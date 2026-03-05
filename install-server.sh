#!/bin/bash

set -e

# ========== CẤU HÌNH ==========
APP_DIR="/opt/n8n-agent"
GIT_REPO="https://github.com/tinovn/n8n-manage.git"
UPDATE_SCRIPT="$APP_DIR/update-agent.sh"
UPGRADE_SCRIPT="$APP_DIR/upgrade.sh"
STEP_LOG="/var/log/n8n-agent-install-steps.log"
EMAIL="noreply@tino.org"
NODE_VERSION="20"

log_step() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$STEP_LOG"
}

echo "Bat dau cai dat n8n-agent server..."

# ========== 1. Cap nhat he thong ==========
echo "Dang cap nhat he thong..."
apt update && apt upgrade -y
apt install -y dnsutils curl git ca-certificates gnupg lsb-release jq

# ========== 2. Cai Node.js ==========
echo "Cai Node.js ${NODE_VERSION}..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt install -y nodejs
fi
log_step "Da cai Node.js $(node -v)"

# ========== 3. Cai Docker & Compose ==========
echo "Cai Docker & Docker Compose Plugin..."
if ! command -v docker &> /dev/null; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt update
  apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable docker
systemctl start docker
log_step "Da cai Docker"

# ========== 4. Cai Nginx & Certbot ==========
echo "Cai Nginx va Certbot..."
apt install -y nginx certbot python3-certbot-nginx
systemctl enable nginx
systemctl start nginx
log_step "Da cai Nginx va Certbot"

# ========== 5. Clone agent va build ==========
echo "Clone n8n-agent tu GitHub..."
rm -rf "$APP_DIR"
git clone "$GIT_REPO" "$APP_DIR"
cd "$APP_DIR"
npm install
npm run build
log_step "Da clone va build n8n-agent"

# ========== 6. Tao systemd service ==========
echo "Tao systemd service..."
cat <<EOF > /etc/systemd/system/n8n-agent.service
[Unit]
Description=N8N Agent Service
After=network.target

[Service]
ExecStart=$(which node) ${APP_DIR}/dist/main.js
Restart=always
User=root
Environment=NODE_ENV=production
WorkingDirectory=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reexec
systemctl daemon-reload
systemctl enable n8n-agent
systemctl start n8n-agent
log_step "Da tao service n8n-agent"

# ========== 7. Tao update-agent.sh ==========
echo "Tao script cap nhat agent..."
cat <<'SCRIPT' > "$UPDATE_SCRIPT"
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

chmod +x "$UPDATE_SCRIPT"
log_step "Da tao update script"

# ========== 8. Tao systemd timer de auto-update ==========
echo "Tao systemd timer de auto-update khi reboot..."
cat <<EOF > /etc/systemd/system/n8n-agent-update.service
[Unit]
Description=Auto Update N8N Agent on Boot
After=network.target

[Service]
Type=oneshot
ExecStart=${UPDATE_SCRIPT}
RemainAfterExit=true
EOF

cat <<EOF > /etc/systemd/system/n8n-agent-update.timer
[Unit]
Description=Run n8n-agent update on boot

[Timer]
OnBootSec=30s
AccuracySec=1s
Unit=n8n-agent-update.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable n8n-agent-update.timer
systemctl start n8n-agent-update.timer
log_step "Da tao systemd timer auto-update"

# ========== 9. Gui request /api/n8n/install neu DNS dung ==========
echo "Kiem tra DNS hostname tro dung IP de goi API /api/n8n/install"

sleep 10
DOMAIN=$(hostname -f)
SERVER_IP=$(curl -s https://api.ipify.org)
PORT=7071
API_KEY=""

# Doc PORT va API_KEY tu .env neu co
if [ -f "$APP_DIR/.env" ]; then
  PORT_FROM_ENV=$(grep '^PORT=' "$APP_DIR/.env" | cut -d '=' -f2)
  [ -n "$PORT_FROM_ENV" ] && PORT="$PORT_FROM_ENV"

  API_FROM_ENV=$(grep '^AGENT_API_KEY=' "$APP_DIR/.env" | cut -d '=' -f2)
  [ -n "$API_FROM_ENV" ] && API_KEY="$API_FROM_ENV"
fi

SUCCESS=0
for i in {1..200}; do
  DOMAIN_IP=$(dig +short A "$DOMAIN" @1.1.1.1 | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1)
  if [[ "$DOMAIN_IP" == "$SERVER_IP" ]]; then
    echo "DNS chinh xac: $DOMAIN -> $DOMAIN_IP"
    SUCCESS=1
    break
  else
    echo "DNS chua dung ($DOMAIN -> $DOMAIN_IP), thu lai lan $i..."
    sleep 10
  fi
done

systemctl restart n8n-agent
sleep 15
if [[ "$SUCCESS" -eq 1 ]]; then
  echo "Gui request toi: http://localhost:$PORT/api/n8n/install"
  curl -s -X POST "http://localhost:$PORT/api/n8n/install" \
    -H "Content-Type: application/json" \
    -H "tng-api-key: $API_KEY" \
    -d '{"domain": "'"$DOMAIN"'", "email": "'"$EMAIL"'"}'
  log_step "Da goi API /api/n8n/install"
else
  echo "DNS khong tro dung sau 200 lan thu -> bo qua goi API"
  log_step "Bo qua goi API vi DNS khong dung"
fi

# ========== 10. Ket thuc ==========
echo "Cai dat hoan tat!"
echo "Agent service: systemctl status n8n-agent"
echo "Auto-update: systemctl list-timers | grep n8n-agent"
echo "Manual update: $UPDATE_SCRIPT"

log_step "Toan bo cai dat hoan tat"
