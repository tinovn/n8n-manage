# n8n-manage

API server to manage n8n instances on VPS - install, upgrade, backup/restore, domain management, and monitoring.

Built with [NestJS](https://nestjs.com/) + TypeScript.

## Quick Install (VPS)

```bash
curl -sL https://raw.githubusercontent.com/tinovn/n8n-manage/main/install-server.sh | bash
```

Script will automatically:
- Install Node.js 20, Docker, Nginx, Certbot
- Clone repo, `npm install`, `npm run build`
- Create systemd service (`n8n-agent`)
- Create auto-update timer (updates on reboot)
- If hostname DNS resolves correctly, auto-call `/api/n8n/install`

## Local Development

```bash
git clone https://github.com/tinovn/n8n-manage.git
cd n8n-manage
npm install
npm run start:dev
```

Server runs on `http://localhost:7071` by default.

### Environment Variables

Create `.env` file:

```env
PORT=7071
AGENT_API_KEY=your-secret-api-key
ALLOWED_IP_RANGES=1.2.3.4,5.6.7.8/24
```

## API Endpoints

All endpoints are under `/api/n8n`. Authentication via `tng-api-key` header.

### Instance Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/n8n/install` | Install n8n (docker compose + nginx + SSL) |
| `DELETE` | `/api/n8n` | Delete n8n instance |
| `POST` | `/api/n8n/reinstall` | Reinstall n8n instance |
| `PATCH` | `/api/n8n/change-domain` | Change domain |
| `POST` | `/api/n8n/reset-owner` | Reset instance owner |
| `POST` | `/api/n8n/disable-2fa` | Disable 2FA for a user |

### Version Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/n8n/version` | Get current & available versions |
| `POST` | `/api/n8n/upgrade` | Upgrade to latest version |
| `POST` | `/api/n8n/version/update` | Update to specific version |

### Data Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/n8n/export` | Export workflows/credentials (zip) |
| `POST` | `/api/n8n/import` | Import workflows/credentials (multipart) |
| `GET` | `/api/n8n/export-summary` | Get export summary (counts) |

### Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/n8n/status` | Instance status (running/stopped/degraded) |
| `GET` | `/api/n8n/info` | Instance info (domain, recent tasks) |
| `GET` | `/api/n8n/redis-info` | Redis connection & stats |
| `GET` | `/api/n8n/nocodb-info` | NocoDB status & credentials |

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tasks/:taskId` | Check async task status |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/n8n/run-command` | Run custom shell script |

## API Examples

### Install n8n

```bash
curl -X POST http://localhost:7071/api/n8n/install \
  -H "Content-Type: application/json" \
  -H "tng-api-key: YOUR_API_KEY" \
  -d '{"domain": "n8n.example.com", "email": "admin@example.com"}'
```

### Upgrade to latest

```bash
curl -X POST http://localhost:7071/api/n8n/upgrade \
  -H "tng-api-key: YOUR_API_KEY"
```

### Update to specific version

```bash
curl -X POST http://localhost:7071/api/n8n/version/update \
  -H "Content-Type: application/json" \
  -H "tng-api-key: YOUR_API_KEY" \
  -d '{"version": "1.95.3"}'
```

### Export data

```bash
curl -X POST http://localhost:7071/api/n8n/export \
  -H "Content-Type: application/json" \
  -H "tng-api-key: YOUR_API_KEY" \
  -d '{"types": ["workflow", "credentials"]}' \
  -o backup.zip
```

### Import data

```bash
curl -X POST http://localhost:7071/api/n8n/import \
  -H "tng-api-key: YOUR_API_KEY" \
  -F "files=@workflow1.json" \
  -F "files=@credential1.json" \
  -F "overwrite=false"
```

### Check task status

```bash
curl http://localhost:7071/api/tasks/TASK_ID \
  -H "tng-api-key: YOUR_API_KEY"
```

## Architecture

Most operations (install, upgrade, delete, etc.) are **async** - they return a `taskId` immediately. Poll `/api/tasks/:taskId` to check progress.

```
POST /api/n8n/install -> { taskId: "abc-123" }
GET  /api/tasks/abc-123 -> { status: "running" }
GET  /api/tasks/abc-123 -> { status: "completed", result: { ... } }
```

### Docker Compose

Generated `docker-compose.yml` includes:
- **postgres** - Database
- **redis** - Queue backend
- **n8n** - Main instance (with ffmpeg via `dockerfile_inline`)
- **n8n-worker** - Queue worker (with ffmpeg)
- **nocodb** - NocoDB instance

### Service Management

```bash
# Check agent status
systemctl status n8n-agent

# View logs
journalctl -u n8n-agent -f

# Manual update
/opt/n8n-agent/update-agent.sh

# Check auto-update timer
systemctl list-timers | grep n8n-agent
```

## Build

```bash
npm run build        # Compile TypeScript
npm run start:prod   # Run production
npm run start:dev    # Run with hot reload
```

## Project Structure

```
src/
├── main.ts                          # Bootstrap, guards, CORS
├── app.module.ts                    # Root module
├── auth/
│   ├── api-key.guard.ts             # API key authentication
│   └── ip-whitelist.guard.ts        # IP whitelist + CIDR support
├── shell/
│   └── shell.service.ts             # Shell command executor
├── tasks/
│   ├── task.model.ts                # Task status enum & interface
│   ├── tasks.service.ts             # In-memory task tracking
│   └── tasks.controller.ts          # GET /api/tasks/:id
└── n8n/
    ├── n8n.module.ts
    ├── n8n.controller.ts            # All /api/n8n/* routes
    ├── n8n.service.ts               # Core logic
    └── dto/                         # Request validation
        ├── install-n8n.dto.ts
        ├── reinstall.dto.ts
        ├── change-domain.dto.ts
        ├── update-version.dto.ts
        ├── export-data.dto.ts
        ├── import-data.dto.ts
        ├── disable-2fa.dto.ts
        └── run-command.dto.ts
```
