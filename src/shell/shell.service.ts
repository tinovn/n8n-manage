import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellOptions {
  ignoreExitCode?: boolean;
}

@Injectable()
export class ShellService {
  private readonly logger = new Logger(ShellService.name);

  execute(command: string, cwd?: string, options: ShellOptions = {}): Promise<ShellResult> {
    return new Promise((resolve, reject) => {
      this.logger.log(`Executing command: ${command} in ${cwd || 'current directory'}`);
      exec(command, { cwd }, (error, stdout, stderr) => {
        const exitCode = (error as any)?.code || 0;
        if (exitCode !== 0 && !options.ignoreExitCode) {
          this.logger.error(`Command failed with exit code ${exitCode}`);
          this.logger.error(`STDOUT: ${stdout}`);
          this.logger.error(`STDERR: ${stderr}`);
          return reject(new Error(`Command execution failed: ${command}\n\n${stderr}`));
        }
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
}
