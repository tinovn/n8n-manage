import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import * as archiver from 'archiver';
import { randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { firstValueFrom } from 'rxjs';
import { Task, TaskStatus } from '../tasks/task.model';
import { TasksService } from '../tasks/tasks.service';
import { v4 as uuidv4 } from 'uuid';
import { ShellService } from '../shell/shell.service';

const DOCKERFILE_INLINE = `FROM alpine:3.22 AS apkstage
RUN apk add --no-cache apk-tools
FROM dockerhub.tino.org/library/n8nio/n8n:latest
USER root
COPY --from=apkstage /sbin/apk /sbin/apk
COPY --from=apkstage /lib /lib/
COPY --from=apkstage /usr/lib /usr/lib/
COPY --from=apkstage /etc/apk/ /etc/apk/
RUN /sbin/apk add --no-cache ffmpeg
USER node`;

function makeDockerfileInline(version: string): string {
  return `FROM alpine:3.22 AS apkstage
RUN apk add --no-cache apk-tools
FROM dockerhub.tino.org/library/n8nio/n8n:${version}
USER root
COPY --from=apkstage /sbin/apk /sbin/apk
COPY --from=apkstage /lib /lib/
COPY --from=apkstage /usr/lib /usr/lib/
COPY --from=apkstage /etc/apk/ /etc/apk/
RUN /sbin/apk add --no-cache ffmpeg
USER node`;
}

@Injectable()
export class N8nService {
  private readonly logger = new Logger(N8nService.name);
  private readonly instancePath = '/opt/n8n';
  private activeOperations = new Set<string>();
  private versionCache: any = null;
  private cacheTimestamp: number = null;

  constructor(
    private readonly shellService: ShellService,
    private readonly httpService: HttpService,
    private readonly tasksService: TasksService,
  ) {}

  private lockOperation(operationName: string) {
    if (this.activeOperations.has('single-instance')) {
      throw new ConflictException('An operation is already in progress. Please wait.');
    }
    this.activeOperations.add('single-instance');
    this.logger.log(`[LOCKED] Starting operation: ${operationName}`);
  }

  private unlockOperation(operationName: string) {
    this.activeOperations.delete('single-instance');
    this.logger.log(`[UNLOCKED] Finished operation: ${operationName}`);
  }

  private executeInBackground(operationName: string, taskId: string, operation: () => Promise<any>) {
    (async () => {
      try {
        this.tasksService.update(taskId, TaskStatus.RUNNING);
        const result = await operation();
        this.tasksService.update(taskId, TaskStatus.COMPLETED, { result });
      } catch (error) {
        this.logger.error(
          `Task ${taskId} (${operationName}) failed: ${error.message}`,
          error.stack,
        );
        this.tasksService.update(taskId, TaskStatus.FAILED, {
          error: error.message,
        });
      } finally {
        this.unlockOperation(operationName);
      }
    })();
  }

  private async executeLockedOperation<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeOperations.has('single-instance')) {
      throw new ConflictException('An operation is already in progress. Please wait.');
    }
    this.activeOperations.add('single-instance');
    this.logger.log(`[LOCKED] Starting operation: ${operationName}`);
    try {
      return await operation();
    } finally {
      this.activeOperations.delete('single-instance');
      this.logger.log(`[UNLOCKED] Finished operation: ${operationName}`);
    }
  }

  private async checkInstanceExists(shouldExist: boolean) {
    try {
      await fs.access(path.join(this.instancePath, 'docker-compose.yml'));
      if (!shouldExist)
        throw new ConflictException('n8n instance is already installed.');
    } catch (error) {
      if (error.code === 'ENOENT' && shouldExist) {
        throw new NotFoundException('n8n instance is not installed yet.');
      }
      if (error instanceof ConflictException) throw error;
    }
  }

  install(domain: string, email: string): string {
    this.lockOperation('install');
    const task = this.tasksService.create(`Installing n8n on ${domain}`);
    this.executeInBackground('install', task.id, async () => {
      await this.checkInstanceExists(false);
      await fs.mkdir(this.instancePath, { recursive: true });
      const { composeContent, envContent } = this.createConfigFiles(domain);
      await fs.writeFile(path.join(this.instancePath, 'docker-compose.yml'), composeContent);
      await fs.writeFile(path.join(this.instancePath, '.env'), envContent);
      await this.shellService.execute('docker compose up -d --build', this.instancePath);
      await this.setupNginxAndSSL(domain, email);
      return {
        message: 'Installation completed.',
        n8nUrl: `https://${domain}`,
      };
    });
    return task.id;
  }

  delete(): string {
    this.lockOperation('delete');
    const task = this.tasksService.create('Deleting n8n instance');
    this.executeInBackground('delete', task.id, async () => {
      await this.checkInstanceExists(true);
      const domain = await this.getEnvVariable('N8N_HOST');
      await this.shellService.execute('docker compose down -v', this.instancePath);
      if (domain) await this.cleanupNginxAndSSL(domain);
      await fs.rm(this.instancePath, { recursive: true, force: true });
      return { message: 'Instance deleted successfully.' };
    });
    return task.id;
  }

  reinstall(domain: string, email: string): string {
    this.lockOperation('reinstall');
    const task = this.tasksService.create(`Reinstalling n8n instance on ${domain}`);
    this.executeInBackground('reinstall', task.id, async () => {
      await this.checkInstanceExists(true);
      const oldDomain = await this.getEnvVariable('N8N_HOST');
      await this.shellService.execute('docker compose down -v', this.instancePath);
      if (oldDomain) await this.cleanupNginxAndSSL(oldDomain);
      await fs.rm(this.instancePath, { recursive: true, force: true });
      await fs.mkdir(this.instancePath, { recursive: true });
      const { composeContent, envContent } = this.createConfigFiles(domain);
      await fs.writeFile(path.join(this.instancePath, 'docker-compose.yml'), composeContent);
      await fs.writeFile(path.join(this.instancePath, '.env'), envContent);
      await this.shellService.execute('docker compose up -d --build', this.instancePath);
      await this.setupNginxAndSSL(domain, email);
      return { message: 'Instance reinstalled successfully.' };
    });
    return task.id;
  }

  changeDomain(newDomain: string, newEmail: string, ip: string): string {
    this.lockOperation('changeDomain');
    const task = this.tasksService.create(`Changing domain to ${newDomain}`);
    this.executeInBackground('changeDomain', task.id, async () => {
      await this.checkInstanceExists(true);
      const oldDomain = await this.getEnvVariable('N8N_HOST');
      const envPath = path.join(this.instancePath, '.env');
      let envContent = await fs.readFile(envPath, 'utf-8');

      envContent = envContent.replace(new RegExp(`^N8N_HOST=.*$`, 'm'), `N8N_HOST=${newDomain}`);
      await fs.writeFile(envPath, envContent);
      await this.shellService.execute('docker compose down', this.instancePath);
      await this.shellService.execute('docker compose up -d', this.instancePath);
      if (oldDomain) await this.cleanupNginxAndSSL(oldDomain);
      await this.setupNginxAndSSL(newDomain, newEmail);
      return {
        message: `Domain changed to ${newDomain}.`,
        newN8nUrl: `https://${newDomain}`,
      };
    });
    return task.id;
  }

  upgrade(): string {
    this.lockOperation('upgrade');
    const task = this.tasksService.create('Upgrading n8n to latest version');
    this.executeInBackground('upgrade', task.id, async () => {
      await this.checkInstanceExists(true);
      await this.updateDockerComposeVersion('latest');
      await this.shellService.execute('docker compose down', this.instancePath);
      await this.shellService.execute('docker compose build --no-cache', this.instancePath);
      const { stdout } = await this.shellService.execute('docker compose up -d', this.instancePath);
      return { message: 'Upgrade completed.', log: stdout };
    });
    return task.id;
  }

  updateToVersion(version: string): string {
    this.lockOperation('updateToVersion');
    const task = this.tasksService.create(`Updating n8n to version ${version}`);
    this.executeInBackground('updateToVersion', task.id, async () => {
      await this.checkInstanceExists(true);
      await this.updateDockerComposeVersion(version);
      await this.shellService.execute('docker compose down', this.instancePath);
      await this.shellService.execute('docker compose build --no-cache', this.instancePath);
      const { stdout } = await this.shellService.execute('docker compose up -d', this.instancePath);
      return {
        message: `Update to version ${version} completed.`,
        log: stdout,
      };
    });
    return task.id;
  }

  private async updateDockerComposeVersion(version: string) {
    const composePath = path.join(this.instancePath, 'docker-compose.yml');
    let composeContent = await fs.readFile(composePath, 'utf-8');
    const newInline = makeDockerfileInline(version);
    // Replace the dockerfile_inline block: match from "dockerfile_inline: |" to the next non-indented line
    const inlineRegex = /dockerfile_inline: \|[\s\S]*?(?=\n    \w|\n  \w)/g;
    const replacement = `dockerfile_inline: |\n        ${newInline.split('\n').join('\n        ')}`;
    composeContent = composeContent.replace(inlineRegex, replacement);
    await fs.writeFile(composePath, composeContent);
  }

  async getVersionInfo() {
    await this.checkInstanceExists(true);
    const [current, available] = await Promise.all([
      this.getCurrentVersion(),
      this.getAvailableVersions(),
    ]);
    return { current, ...available };
  }

  resetOwner(): string {
    this.lockOperation('resetOwner');
    const task = this.tasksService.create('Resetting instance owner');
    this.executeInBackground('resetOwner', task.id, async () => {
      await this.checkInstanceExists(true);
      this.logger.log('Resetting instance owner...');
      const command = 'docker compose exec -u node -it n8n n8n user-management:reset';
      await this.shellService.execute(command, this.instancePath);
      await this.shellService.execute('docker compose down', this.instancePath);
      await this.shellService.execute('docker compose up -d', this.instancePath);
      return {
        message: 'Instance owner has been reset successfully. You can now create a new owner account.',
      };
    });
    return task.id;
  }

  private createNginxConfig(domain: string): string {
    return `server {
    listen 80;
    server_name ${domain};

    client_max_body_size 100M;

    location /nocodb/ {
       rewrite ^/nocodb/(.*)$ /$1 break;

       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-Host $host;
       proxy_set_header X-Forwarded-Port $server_port;

       proxy_redirect / /nocodb/;

       proxy_redirect default;
   }
   location /mcp/ {
        proxy_pass         http://127.0.0.1:5678;
        proxy_http_version 1.1;
        proxy_set_header   Connection '';
        proxy_set_header   Host $host;

        proxy_buffering    off;
        proxy_cache        off;
        gzip               off;

        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }


    location / {
        proxy_pass http://127.0.0.1:5678;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`;
  }

  private createConfigFiles(domain: string) {
    const composeContent = `
services:
  postgres:
    image: dockerhub.tino.org/library/postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - n8n_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -d \${POSTGRES_DB} -U \${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: dockerhub.tino.org/library/redis:7-alpine
    restart: unless-stopped
    command: redis-server --requirepass "\${REDIS_PASSWORD}"
    volumes:
      - n8n_redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "\${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  n8n:
    build:
      context: .
      dockerfile_inline: |
        ${DOCKERFILE_INLINE.split('\n').join('\n        ')}
    restart: unless-stopped
    ports:
      - "127.0.0.1:5678:5678"
    environment:
      N8N_HOST: \${N8N_HOST}
      N8N_PROTOCOL: https
      WEBHOOK_URL: https://\${N8N_HOST}/
      GENERIC_TIMEZONE: \${GENERIC_TIMEZONE}
      NODE_OPTIONS: --max-old-space-size=512
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_PORT: 5432
      DB_POSTGRESDB_DATABASE: \${POSTGRES_DB}
      DB_POSTGRESDB_USER: \${POSTGRES_USER}
      DB_POSTGRESDB_PASSWORD: \${POSTGRES_PASSWORD}
      EXECUTIONS_MODE: queue
      QUEUE_BULL_REDIS_HOST: redis
      QUEUE_BULL_REDIS_PORT: 6379
      QUEUE_BULL_REDIS_PASSWORD: \${REDIS_PASSWORD}
      N8N_RUNNERS_ENABLED: true
      OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS: false
      EXECUTIONS_DATA_PRUNE: true
      EXECUTIONS_DATA_MAX_AGE: 168
      N8N_SAVE_EXECUTIONS: false
      N8N_BASIC_AUTH_ACTIVE: false
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      N8N_TRUST_PROXY: true
    volumes:
      - n8n_data:/home/node/.n8n
      - /tmp:/tmp
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
  nocodb:
    image: dockerhub.tino.org/library/nocodb/nocodb:latest
    restart: always
    ports:
      - "8080:8080"
    environment:
      NC_DB_TYPE: "pg"
      NC_DATABASE: \${POSTGRES_DB}
      NC_DB_HOST: postgres
      NC_DB_PORT: 5432
      NC_DB_USER: \${POSTGRES_USER}
      NC_DB_PASSWORD: \${POSTGRES_PASSWORD}
      NC_ADMIN_EMAIL: \${NC_ADMIN_EMAIL}
      NC_ADMIN_PASSWORD: \${NC_ADMIN_PASSWORD}
      NC_PUBLIC_URL: "https://\${N8N_HOST}/nocodb"
      NC_BACKEND_URL: "https://\${N8N_HOST}/nocodb"
      NC_DISABLE_TELE: "true"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - n8n_nocodb_data:/usr/app/data
  n8n-worker:
    build:
      context: .
      dockerfile_inline: |
        ${DOCKERFILE_INLINE.split('\n').join('\n        ')}
    restart: unless-stopped
    depends_on:
     - postgres
     - redis
    command: worker
    environment:
     DB_TYPE: postgresdb
     DB_POSTGRESDB_HOST: postgres
     DB_POSTGRESDB_PORT: 5432
     DB_POSTGRESDB_DATABASE: \${POSTGRES_DB}
     DB_POSTGRESDB_USER: \${POSTGRES_USER}
     DB_POSTGRESDB_PASSWORD: \${POSTGRES_PASSWORD}
     EXECUTIONS_MODE: queue
     QUEUE_MODE: redis
     QUEUE_BULL_REDIS_HOST: redis
     QUEUE_BULL_REDIS_PORT: 6379
     QUEUE_BULL_REDIS_PASSWORD: \${REDIS_PASSWORD}
     EXECUTIONS_PROCESS_CONCURRENCY: 10
     N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
    volumes:
     - n8n_data:/home/node/.n8n
     - /tmp:/tmp

volumes:
  n8n_postgres_data:
  n8n_redis_data:
  n8n_data:
  n8n_nocodb_data:
`;
    const envContent = `# N8N Settings
N8N_HOST=${domain}
GENERIC_TIMEZONE=Asia/Ho_Chi_Minh

# Auto-generated Credentials
POSTGRES_DB=n8n
NC_ADMIN_EMAIL=admin@${domain}
NC_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}
POSTGRES_USER=user_${randomBytes(8).toString('hex')}
POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}
N8N_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}
REDIS_PASSWORD=${randomBytes(24).toString('hex')}`;
    return { composeContent, envContent };
  }

  async exportData(types: string[]) {
    this.lockOperation('exportData');
    const exportId = uuidv4();
    const tempDirOnHost = path.join('/tmp');
    try {
      await this.checkInstanceExists(true);
      this.logger.log(`Starting export with types [${types.join(', ')}].`);
      await fs.mkdir(tempDirOnHost, { recursive: true });
      const tempDirInContainer = `/home/node/exports/${exportId}`;
      await this.shellService.execute(
        `docker compose exec -u node n8n mkdir -p ${tempDirInContainer}`,
        this.instancePath,
      );
      for (const type of types) {
        try {
          const command = `docker compose exec -u node n8n n8n export:${type} --backup --output=${tempDirInContainer}/${type}/`;
          await this.shellService.execute(command, this.instancePath);
        } catch (error) {
          this.logger.error(
            `Failed to export ${type}. It may not be supported or available.`,
            error,
          );
        }
      }
      await this.shellService.execute(
        `docker compose cp n8n:${tempDirInContainer} "${tempDirOnHost}"`,
        this.instancePath,
      );
      const finalZipFileName = `n8n-backup-${new Date().toISOString().split('T')[0]}.zip`;
      const finalZipFilePath = path.join('/tmp', finalZipFileName);
      await this.createZipArchiveFromDir(
        path.join(tempDirOnHost, exportId),
        finalZipFilePath,
        types,
      );
      const stream = createReadStream(finalZipFilePath);
      stream.on('close', () => {
        this.unlockOperation('exportData');
        fs.rm(path.join(tempDirOnHost, exportId), {
          recursive: true,
          force: true,
        }).catch(() => {});
        fs.unlink(finalZipFilePath).catch(() => {});
        this.shellService
          .execute(
            `docker compose exec -u node n8n rm -rf ${tempDirInContainer}`,
            this.instancePath,
          )
          .catch(() => {});
      });
      return { stream: new StreamableFile(stream), filename: finalZipFileName };
    } catch (error) {
      this.unlockOperation('exportData');
      await fs
        .rm(path.join(tempDirOnHost, exportId), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
      throw error;
    }
  }

  async importData(files: Express.Multer.File[], overwrite: boolean) {
    return this.executeLockedOperation('importData', async () => {
      await this.checkInstanceExists(true);
      const importId = uuidv4();
      const stagingDir = path.join('/tmp', importId);
      const workflowsDir = path.join(stagingDir, 'workflows');
      const credentialsDir = path.join(stagingDir, 'credentials');
      try {
        await fs.mkdir(workflowsDir, { recursive: true });
        await fs.mkdir(credentialsDir, { recursive: true });
        let unclassifiedCount = 0;
        for (const file of files) {
          if (path.extname(file.originalname) !== '.json') continue;
          const content = file.buffer.toString('utf-8');
          let item;
          try {
            item = JSON.parse(content);
          } catch {
            this.logger.warn(`Skipping invalid JSON file: ${file.originalname}`);
            continue;
          }
          const type = this.classifyJson(item);
          if (!overwrite && item.id) {
            const oldId = item.id;
            const newId =
              oldId && typeof oldId === 'string'
                ? oldId
                    .split('')
                    .sort(() => Math.random() - 0.5)
                    .join('')
                : randomBytes(8).toString('hex');
            item.id = newId;
          }
          const targetFileName = `${uuidv4()}.json`;
          if (type === 'workflow') {
            await fs.writeFile(
              path.join(workflowsDir, targetFileName),
              JSON.stringify(item, null, 2),
            );
          } else if (type === 'credential') {
            await fs.writeFile(
              path.join(credentialsDir, targetFileName),
              JSON.stringify(item, null, 2),
            );
          } else {
            unclassifiedCount++;
            this.logger.warn(`Could not classify file: ${file.originalname}`);
          }
        }
        this.logger.log(`Files processed and moved to staging directories.`);
        const tempDirInContainer = `/home/node/imports/${importId}`;
        await this.shellService.execute(
          `docker compose exec -u node n8n mkdir -p ${tempDirInContainer}`,
          this.instancePath,
        );
        const stagingDirInContainer = `/home/node/imports/`;
        await this.shellService.execute(
          `docker compose cp "${stagingDir}" n8n:${stagingDirInContainer}`,
          this.instancePath,
        );
        let workflowsLog = 'No workflows to import.';
        let credentialsLog = 'No credentials to import.';
        if ((await fs.readdir(workflowsDir)).length > 0) {
          const { stdout } = await this.shellService.execute(
            `docker compose exec -u node n8n n8n import:workflow --separate --input=${tempDirInContainer}/workflows`,
            this.instancePath,
          );
          workflowsLog = stdout;
        }
        if ((await fs.readdir(credentialsDir)).length > 0) {
          const { stdout } = await this.shellService.execute(
            `docker compose exec -u node n8n n8n import:credentials --separate --input=${tempDirInContainer}/credentials`,
            this.instancePath,
          );
          credentialsLog = stdout;
        }
        return {
          workflowsLog,
          credentialsLog,
          unclassifiedFiles: unclassifiedCount,
        };
      } finally {
        fs.rm(path.join('/tmp', importId), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    });
  }

  async getRedisInfo() {
    this.lockOperation('getRedisInfo');
    try {
      await this.checkInstanceExists(true);
      this.logger.log('Fetching and formatting Redis info...');
      const redisPassword = await this.getEnvVariable('REDIS_PASSWORD');
      if (!redisPassword) {
        throw new NotFoundException('REDIS_PASSWORD not found in .env file.');
      }
      const command = `docker compose exec redis redis-cli -a ${redisPassword} INFO`;
      const { stdout } = await this.shellService.execute(command, this.instancePath);
      const parsedInfo = this.parseRedisInfo(stdout);
      const uptimeInSeconds = parseInt(parsedInfo.server?.uptime_in_seconds ?? '0', 10);
      const days = Math.floor(uptimeInSeconds / 86400);
      const hours = Math.floor((uptimeInSeconds % 86400) / 3600);
      return {
        status: 'active',
        version: `Redis ${parsedInfo.server?.redis_version ?? 'N/A'}`,
        connection: {
          port: parsedInfo.server?.tcp_port ?? 'N/A',
          connected_clients: parsedInfo.clients?.connected_clients ?? 'N/A',
          password: redisPassword ?? 'N/A',
        },
        stats: {
          memory_usage: parsedInfo.memory?.used_memory_human ?? 'N/A',
          uptime_formatted: `${days} days, ${hours} hours`,
          total_commands_processed: parsedInfo.stats?.total_commands_processed ?? 'N/A',
        },
        raw: parsedInfo,
      };
    } catch (error) {
      this.logger.error(`Could not get Redis info. Returning inactive status.`, error.stack);
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }
      return {
        status: 'inactive',
        version: 'N/A',
        connection: { port: 'N/A', connected_clients: 'N/A', password: 'N/A' },
        stats: {
          memory_usage: 'N/A',
          uptime_formatted: 'N/A',
          total_commands_processed: 'N/A',
        },
        raw: { error: error.message },
      };
    } finally {
      this.unlockOperation('getRedisInfo');
    }
  }

  async getNocodbInfo() {
    this.lockOperation('getNocodbInfo');
    try {
      await this.checkInstanceExists(true);
      this.logger.log('Checking NocoDB container status and credentials...');

      const ncUserEmail = await this.getEnvVariable('NC_ADMIN_EMAIL');
      const ncUserPassword = await this.getEnvVariable('NC_ADMIN_PASSWORD');

      if (!ncUserEmail || !ncUserPassword) {
        throw new NotFoundException('NC_ADMIN_EMAIL or NC_ADMIN_PASSWORD not found in .env file.');
      }

      const containerName = 'n8n-nocodb-1';
      const checkContainerCmd = `docker inspect -f '{{.State.Running}}' ${containerName}`;
      const { stdout: containerRunning } = await this.shellService.execute(
        checkContainerCmd,
        this.instancePath,
      );

      if (containerRunning.trim() !== 'true') {
        throw new Error('NocoDB container is not running.');
      }

      const response = await this.httpService.axiosRef.get(
        'http://localhost:8080/api/v1/version',
        { timeout: 3000 },
      );

      const versionInfo = response.data;
      const statusCode = response.status;
      const currentVersion = versionInfo?.currentVersion || 'unknown';
      const releaseVersion = versionInfo?.releaseVersion || 'unknown';

      return {
        status: statusCode === 200 ? 'active' : 'unhealthy',
        version: currentVersion,
        release: releaseVersion,
        credentials: {
          admin_email: ncUserEmail,
          admin_password: ncUserPassword,
        },
        http_status: statusCode,
      };
    } catch (error) {
      this.logger.error(
        `Could not get NocoDB info. Returning inactive status.`,
        error.stack,
      );
      if (error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }
      return {
        status: 'inactive',
        credentials: {
          admin_email: 'N/A',
          admin_password: 'N/A',
        },
        http_status: 'N/A',
        raw: { error: error.message },
      };
    } finally {
      this.unlockOperation('getNocodbInfo');
    }
  }

  disable2FA(userEmail: string): string {
    this.lockOperation('disable2FA');
    const task = this.tasksService.create(`Disabling 2FA for user: ${userEmail}`);
    this.executeInBackground('disable2FA', task.id, async () => {
      await this.checkInstanceExists(true);
      this.logger.log(`Disabling 2FA for user: ${userEmail}`);
      const command = `docker compose exec -u node n8n n8n mfa:disable --email "${userEmail}"`;
      const { stdout } = await this.shellService.execute(command, this.instancePath);
      return {
        message: `Successfully disabled 2FA for ${userEmail}.`,
        log: stdout,
      };
    });
    return task.id;
  }

  async status() {
    this.logger.log('Fetching instance status (non-locking)...');
    try {
      const command = 'docker compose ps --format json';
      const { stdout } = await this.shellService.execute(command, this.instancePath);
      const services = stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (e) {
            this.logger.error(`Failed to parse JSON line from docker-compose ps: ${line}`);
            return null;
          }
        })
        .filter(Boolean);
      if (services.length === 0) {
        return { overallStatus: 'stopped', services: [] };
      }
      let runningCount = 0;
      const serviceDetails = services.map((service) => {
        const isRunning = service.State === 'running';
        if (isRunning) runningCount++;
        return {
          serviceName: service.Name,
          status: service.State,
          ports: service.Ports || 'N/A',
          state: service.Status,
        };
      });
      let overallStatus = 'stopped';
      if (runningCount === serviceDetails.length) {
        overallStatus = 'running';
      } else if (runningCount > 0) {
        overallStatus = 'degraded';
      }
      return { overallStatus, services: serviceDetails };
    } catch (error) {
      this.logger.warn(
        `Could not get instance status, assuming it's stopped. Error: ${error.message}`,
      );
      return { overallStatus: 'stopped', services: [] };
    }
  }

  async info() {
    this.logger.log('Fetching instance info (non-locking)...');
    try {
      const domain = await this.getEnvVariable('N8N_HOST');
      const recentTasks = this.tasksService.getRecentTasksSummary(3);
      return {
        currentDomain: domain || 'Not set or instance not installed',
        tasks: recentTasks,
      };
    } catch (error) {
      this.logger.error(`Failed to get instance info: ${error.message}`);
      throw new InternalServerErrorException('Could not retrieve instance information.');
    }
  }

  private async setupNginxAndSSL(domain: string, email: string) {
    const nginxConfigContent = this.createNginxConfig(domain);
    const nginxConfigPath = `/etc/nginx/sites-available/${domain}`;
    await fs.writeFile(nginxConfigPath, nginxConfigContent);
    this.logger.log(`Nginx config file created at ${nginxConfigPath}`);
    try {
      await this.shellService.execute(
        `ln -sf ${nginxConfigPath} /etc/nginx/sites-enabled/${domain}`,
      );
    } catch (e) {
      if (!e.message.includes('File exists')) {
        throw e;
      }
      this.logger.warn(`Symbolic link for ${domain} already exists.`);
    }
    await this.shellService.execute('nginx -t');
    await this.shellService.execute('systemctl reload nginx');
    this.logger.log('Nginx reloaded with new site configuration.');
    const certbotCommand = `certbot --nginx -d ${domain} --non-interactive --agree-tos -m ${email}`;
    await this.shellService.execute(certbotCommand);
    this.logger.log(`Certbot has been run for ${domain}. SSL should be active.`);
  }

  private async cleanupNginxAndSSL(domain: string) {
    const nginxConfigPath = `/etc/nginx/sites-available/${domain}`;
    const nginxSymlinkPath = `/etc/nginx/sites-enabled/${domain}`;
    try {
      await fs.unlink(nginxConfigPath);
      await fs.unlink(nginxSymlinkPath);
      this.logger.log(`Cleaned up Nginx config for ${domain}.`);
      await this.shellService.execute('systemctl reload nginx');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.error(`Could not remove Nginx files for ${domain}: ${error.message}`);
      }
    }
  }

  private async getEnvVariable(key: string): Promise<string | null> {
    try {
      const envPath = path.join(this.instancePath, '.env');
      const envContent = await fs.readFile(envPath, 'utf-8');
      const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  private parseRedisInfo(info: string): Record<string, Record<string, string>> {
    const sections: Record<string, Record<string, string>> = {};
    let currentSection: Record<string, string> = null;
    info.split('\n').forEach((line) => {
      line = line.trim();
      if (line.startsWith('#')) {
        const sectionName = line.substring(1).trim().toLowerCase();
        currentSection = {};
        sections[sectionName] = currentSection;
      } else if (currentSection && line.includes(':')) {
        const [key, ...valueParts] = line.split(':');
        currentSection[key] = valueParts.join(':').trim();
      }
    });
    return sections;
  }

  private classifyJson(item: any): string {
    if (item.nodes && Array.isArray(item.nodes) && item.connections) {
      return 'workflow';
    }
    if (item.name && item.type && item.data) {
      return 'credential';
    }
    return 'unknown';
  }

  private createZipArchiveFromDir(
    sourceDir: string,
    outPath: string,
    types: string[],
  ): Promise<void> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = createWriteStream(outPath);
    return new Promise((resolve, reject) => {
      archive.on('error', (err) => reject(err)).pipe(stream);
      stream.on('close', () => resolve());
      for (const type of types) {
        archive.directory(path.join(sourceDir, type), type);
      }
      archive.finalize();
    });
  }

  private async getCurrentVersion(): Promise<string> {
    try {
      const command = 'docker compose exec n8n n8n --version';
      const { stdout } = await this.shellService.execute(command, this.instancePath);
      return stdout.trim().split(' ').pop() || 'unknown';
    } catch (error) {
      this.logger.error(`Could not get current version`, error);
      return 'unknown';
    }
  }

  private async getAvailableVersions() {
    if (
      this.versionCache &&
      this.cacheTimestamp &&
      Date.now() - this.cacheTimestamp < 3600000
    ) {
      this.logger.log('Returning n8n versions from cache.');
      return this.versionCache;
    }
    this.logger.log('Fetching n8n versions from Docker Hub API.');
    const url =
      'https://registry.hub.docker.com/v2/repositories/n8nio/n8n/tags?page_size=15';
    try {
      const response = await firstValueFrom(this.httpService.get(url));
      const tagsData = response.data.results;
      const allVersions = tagsData
        .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag.name))
        .map((tag) => {
          const amd64Image = tag.images.find((img) => img.architecture === 'amd64');
          const sizeInBytes = amd64Image ? amd64Image.size : tag.full_size || 0;
          const sizeInMb = parseFloat((sizeInBytes / (1024 * 1024)).toFixed(2));
          return {
            version: tag.name,
            pushed_date: tag.tag_last_pushed,
            size_mb: sizeInMb,
          };
        })
        .sort((a, b) => {
          const partsA = a.version.split('.').map(Number);
          const partsB = b.version.split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if (partsA[i] > partsB[i]) return -1;
            if (partsA[i] < partsB[i]) return 1;
          }
          return 0;
        });
      const latest = allVersions.length > 0 ? allVersions[0] : null;
      this.versionCache = { latest, all: allVersions };
      this.cacheTimestamp = Date.now();
      return this.versionCache;
    } catch (error) {
      this.logger.error('Failed to fetch versions from Docker Hub.', error.stack);
      return { latest: null, all: [] };
    }
  }

  async getExportSummary() {
    return this.executeLockedOperation('getExportSummary', async () => {
      await this.checkInstanceExists(true);
      this.logger.log('Fetching export summary using n8n-cli --backup flag...');
      const tempDirName = uuidv4();
      const tempContainerPath = `/home/node/tmp_summary_${tempDirName}`;
      let workflowCount = 0;
      let credentialCount = 0;
      try {
        await this.shellService.execute(
          `docker compose exec -u node n8n mkdir -p ${tempContainerPath}/workflows ${tempContainerPath}/credentials`,
          this.instancePath,
        );
        const workflowExportCommand = `docker compose exec -u node n8n n8n export:workflow --backup --output=${tempContainerPath}/workflows/`;
        const wfExportResult = await this.shellService.execute(
          workflowExportCommand,
          this.instancePath,
          { ignoreExitCode: true },
        );
        if (wfExportResult.exitCode === 0) {
          const countWorkflowsCommand = `docker compose exec -u node n8n sh -c 'ls -1 ${tempContainerPath}/workflows/ | wc -l'`;
          const { stdout: wfCountStdout } = await this.shellService.execute(
            countWorkflowsCommand,
            this.instancePath,
          );
          workflowCount = parseInt(wfCountStdout.trim(), 10) || 0;
        } else {
          this.logger.warn(
            `Workflow export command exited with code ${wfExportResult.exitCode}. Assuming 0 workflows. Stderr: ${wfExportResult.stderr}`,
          );
          workflowCount = 0;
        }
        const credentialExportCommand = `docker compose exec -u node n8n n8n export:credential --backup --output=${tempContainerPath}/credentials/`;
        const credExportResult = await this.shellService.execute(
          credentialExportCommand,
          this.instancePath,
          { ignoreExitCode: true },
        );
        if (credExportResult.exitCode === 0) {
          const countCredentialsCommand = `docker compose exec -u node n8n sh -c 'ls -1 ${tempContainerPath}/credentials/ | wc -l'`;
          const { stdout: credCountStdout } = await this.shellService.execute(
            countCredentialsCommand,
            this.instancePath,
          );
          credentialCount = parseInt(credCountStdout.trim(), 10) || 0;
        } else {
          this.logger.warn(
            `Credential export command exited with code ${credExportResult.exitCode}. Assuming 0 credentials. Stderr: ${credExportResult.stderr}`,
          );
          credentialCount = 0;
        }
      } finally {
        await this.shellService
          .execute(
            `docker compose exec -u node n8n rm -rf ${tempContainerPath}`,
            this.instancePath,
          )
          .catch((err) =>
            this.logger.error(`Failed to cleanup temp dir in container: ${err.message}`),
          );
      }
      return {
        workflows: { total: workflowCount },
        credentials: { total: credentialCount },
      };
    });
  }

  async resolveDomainToIp(domain: string): Promise<string> {
    try {
      const command = `dig +short A ${domain}`;
      const { stdout } = await this.shellService.execute(command);
      const ips = stdout
        .trim()
        .split('\n')
        .filter((ip) => ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/));

      if (ips.length === 0) {
        throw new Error(`No A record found for domain: ${domain}`);
      }
      return ips[0];
    } catch (error) {
      this.logger.error(
        `Failed to resolve domain ${domain}: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Domain resolution failed or timed out for ${domain}. Check domain spelling or DNS server issues.`,
      );
    }
  }

  runCommand(command: string) {
    this.lockOperation('runCustomShellScript');
    const scriptPath = '/opt/n8n-agent/run.sh';

    try {
      const task = this.tasksService.create('Running custom shell script');
      this.executeInBackground('runCustomShellScript', task.id, async () => {
        const output = await this.shellService.execute(`bash ${scriptPath}`);
        return {
          status: 'success',
          output,
        };
      });
      return task.id;
    } catch (error) {
      this.logger.error('Error running run.sh', error);
      this.unlockOperation('runCustomShellScript');
      throw error;
    }
  }
}
