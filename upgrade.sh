#!/bin/bash
set -e

# ============================================================
# upgrade.sh - Migrate from tinovn/n8n-agent to tinovn/n8n-manage
#
# This script runs inside the OLD update-agent.sh flow:
#   1. update-agent.sh stops n8n-agent
#   2. update-agent.sh does git pull (gets this file)
#   3. update-agent.sh runs this upgrade.sh
#   4. update-agent.sh deletes this file
#   5. update-agent.sh restarts n8n-agent
#
# What this script does:
#   - Install Node.js 20 if not present
#   - Backup .env from old agent
#   - Remove old binary repo
#   - Clone new source repo (tinovn/n8n-manage)
#   - npm install + npm run build
#   - Rewrite systemd service to use node
#   - Rewrite update-agent.sh for new repo
# ============================================================

APP_DIR="/opt/n8n-agent"
NEW_REPO="https://github.com/tinovn/n8n-manage.git"
NODE_VERSION="20"
LOG="/var/log/n8n-agent-upgrade.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG"
}

# Auto-relocate: if running from APP_DIR, copy to /tmp and re-exec from there
SELF="$(realpath "$0")"
if [[ "$SELF" == "$APP_DIR"* ]]; then
  cp "$SELF" /tmp/upgrade-n8n-agent.sh
  exec bash /tmp/upgrade-n8n-agent.sh "$@"
fi

log "=== Starting migration to n8n-manage ==="

# 1. Install or upgrade Node.js to version 20
NEED_NODE=0
if ! command -v node &> /dev/null; then
  NEED_NODE=1
else
  CURRENT_NODE=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$CURRENT_NODE" -lt 20 ]; then
    log "Node.js v${CURRENT_NODE} found, upgrading to ${NODE_VERSION}..."
    NEED_NODE=1
  else
    log "Node.js already installed: $(node -v)"
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  log "Installing Node.js ${NODE_VERSION} via NodeSource..."
  # Remove Ubuntu's nodejs first (no npm included)
  apt remove -y nodejs npm 2>/dev/null || true
  # Setup NodeSource repo and install
  for i in 1 2 3; do
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - && break
    log "NodeSource setup attempt $i failed, retrying in 10s..."
    sleep 10
  done
  apt install -y nodejs
  # Verify npm is available
  if ! command -v npm &> /dev/null; then
    log "ERROR: npm not found after install. NodeSource may have failed."
    log "Falling back to manual npm install..."
    curl -fsSL https://www.npmjs.com/install.sh | bash -
  fi
  log "Node.js $(node -v), npm $(npm -v) installed"
fi

# 2. Backup .env if exists
ENV_BACKUP=""
if [ -f "$APP_DIR/.env" ]; then
  ENV_BACKUP="/tmp/n8n-agent-env-backup"
  cp "$APP_DIR/.env" "$ENV_BACKUP"
  log "Backed up .env to $ENV_BACKUP"
fi

# 3. Remove old repo and clone new one
log "Removing old repo and cloning new source..."
cd /
rm -rf "$APP_DIR"
git clone "$NEW_REPO" "$APP_DIR"
cd "$APP_DIR"

# 4. Restore .env
if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
  cp "$ENV_BACKUP" "$APP_DIR/.env"
  rm -f "$ENV_BACKUP"
  log "Restored .env"
fi

# 5. npm install + build
log "Running npm install..."
npm install
log "Building project..."
npm run build
log "Build completed"

# 6. Rewrite systemd service
log "Updating systemd service..."
NODE_BIN=$(which node)
cat <<EOF > /etc/systemd/system/n8n-agent.service
[Unit]
Description=N8N Agent Service
After=network.target

[Service]
ExecStart=${NODE_BIN} ${APP_DIR}/dist/main.js
Restart=always
User=root
Environment=NODE_ENV=production
WorkingDirectory=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

# 7. Rewrite update-agent.sh for new repo
log "Updating update-agent.sh..."
cat <<'SCRIPT' > "$APP_DIR/update-agent.sh"
#!/bin/bash
set -e

APP_DIR="/opt/n8n-agent"
UPGRADE_SCRIPT="$APP_DIR/upgrade.sh"

echo "Cap nhat n8n-agent tu GitHub..."
systemctl stop n8n-agent
cd "$APP_DIR"
git reset --hard
git pull origin main
npm install
npm run build

# Chay upgrade.sh neu co, sau do xoa
if [[ -f "$UPGRADE_SCRIPT" ]]; then
  echo "Da phat hien upgrade.sh -> chay..."
  chmod +x "$UPGRADE_SCRIPT"
  "$UPGRADE_SCRIPT"
  echo "Xoa upgrade.sh sau khi chay xong..."
  rm -f "$UPGRADE_SCRIPT"
fi

systemctl daemon-reload
systemctl restart n8n-agent
echo "Da cap nhat va khoi dong lai n8n-agent"
SCRIPT
chmod +x "$APP_DIR/update-agent.sh"

# 8. Reload systemd
systemctl daemon-reload
log "=== Migration completed successfully ==="
