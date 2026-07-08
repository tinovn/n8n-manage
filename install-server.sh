#!/bin/bash
# =============================================================================
# n8n-agent VPS installer — cai dat agent NestJS + tu dong cai n8n
#
# Usage:
#   install-server.sh [--api-key KEY] [--port PORT] [--domain FQDN] \
#                     [--email EMAIL] [--ref GIT_REF]
#
# Cac gia tri co the truyen qua flag HOAC bien moi truong (flag uu tien).
# Neu bootstrap.sh da pre-seed /opt/n8n-agent/.env thi cac gia tri do duoc
# doc lai o buoc 5.5 va KHONG bi rotate.
# =============================================================================

set -euo pipefail

# ========== CẤU HÌNH ==========
APP_DIR="/opt/n8n-agent"
GIT_REPO="https://github.com/tinovn/n8n-manage.git"
UPDATE_SCRIPT="$APP_DIR/update-agent.sh"
UPGRADE_SCRIPT="$APP_DIR/upgrade.sh"
STEP_LOG="/var/log/n8n-agent-install-steps.log"
LOG_FILE="/var/log/n8n-agent-install.log"
NODE_VERSION="20"
export DEBIAN_FRONTEND=noninteractive

# ========== THAM SO / BIEN MOI TRUONG ==========
# Gia tri co the truyen qua flag hoac bien moi truong (flag uu tien hon).
# Neu bootstrap.sh da pre-seed /opt/n8n-agent/.env thi cac gia tri do se duoc
# doc lai o buoc 5.5 va KHONG bi ghi de (khong rotate).
#
# Usage: install-server.sh [--api-key KEY] [--port PORT] [--domain FQDN] \
#                          [--email EMAIL] [--ref GIT_REF]
AGENT_API_KEY="${AGENT_API_KEY:-}"
PORT="${PORT:-7071}"
DOMAIN_ARG="${DOMAIN:-}"
EMAIL="${EMAIL:-noreply@tino.org}"
GIT_REF="${GIT_REF:-main}"
# IP mac dinh duoc phep goi API (ngoai localhost). Guard cung hard-code san cac
# IP nay, ghi vao .env de de audit/sua. Truyen --ips de bo sung/thay the.
ALLOWED_IP_RANGES="${ALLOWED_IP_RANGES:-103.130.216.5,127.0.0.1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    # --mgmt-key la alias cua --api-key (dong bo voi Hermes / Hostbill template).
    --api-key|--mgmt-key) AGENT_API_KEY="$2"; shift 2 ;;
    --port)    PORT="$2"; shift 2 ;;
    --domain)  DOMAIN_ARG="$2"; shift 2 ;;
    --email)   EMAIL="$2"; shift 2 ;;
    --ips)     ALLOWED_IP_RANGES="$2"; shift 2 ;;
    --ref)     GIT_REF="$2"; shift 2 ;;
    *)         shift ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")"
log_step() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$STEP_LOG"; }
# Ghi ra stderr. Duoi systemd one-shot, ExecStart da `>> $LOG_FILE 2>&1` nen moi
# output (ke ca apt/npm/docker) vao $LOG_FILE — khong tu `tee` de tranh double.
# Chay truc tiep: nen redirect thu cong, vd `install-server.sh ... 2>&1 | tee log`.
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }
step() { log ""; log "==== $* ===="; }
die()  { log "FATAL: $*"; exit 1; }

# ---- apt-lock handling (VPS moi hay bi unattended-upgrades giu lock) ----
is_apt_locked() {
  fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock 2>/dev/null
}
wait_for_apt() {
  local max=180 waited=0
  while [[ $waited -lt $max ]]; do
    is_apt_locked || return 0
    log "apt dang bi lock, cho 5s (${waited}s/${max}s)..."
    sleep 5; waited=$((waited + 5))
  done
  log "WARN: apt van lock sau ${max}s, ep giai phong."
  killall -9 apt apt-get dpkg unattended-upgr 2>/dev/null || true
  rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
  dpkg --force-confdef --force-confold --configure -a 2>/dev/null || true
}
apt_retry() {
  local retries=3 i=0
  while [[ $i -lt $retries ]]; do
    wait_for_apt
    if "$@"; then return 0; fi
    i=$((i + 1))
    log "apt retry ${i}/${retries}: don lock + cau hinh lai dpkg..."
    killall -9 apt apt-get dpkg 2>/dev/null || true
    rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
    dpkg --force-confdef --force-confold --configure -a 2>/dev/null || true
    sleep 5
  done
  die "apt that bai sau ${retries} lan: $*"
}

log "=== Bat dau cai dat n8n-agent server ==="
[[ "$(id -u)" == "0" ]] || die "Phai chay bang root."

# ========== 1. Cap nhat he thong ==========
step "1. Cap nhat he thong + xu ly apt-lock"

# Tam dung unattended-upgrades de tranh tranh chap apt-lock ngay sau reboot.
systemctl stop unattended-upgrades 2>/dev/null || true
systemctl stop apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true

# Khong cho cloud-init o day: install-server.sh chay SAU reboot (do bootstrap.sh
# len lich), luc do cloud-init cua lan boot dau da xong tu truoc. Goi
# `cloud-init status --wait` o day se deadlock voi cloud-final.service cua lan
# boot thu 2. Viec cho cloud-init la nhiem vu cua bootstrap.sh (truoc reboot).

apt_retry apt-get -qqy update
apt_retry apt-get -qqy upgrade
apt_retry apt-get -qqy install dnsutils curl git ca-certificates gnupg lsb-release jq openssl

# ========== 2. Cai Node.js ==========
step "2. Cai Node.js ${NODE_VERSION}"
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt_retry apt-get -qqy install nodejs
fi
log_step "Da cai Node.js $(node -v)"

# ========== 3. Cai Docker & Compose ==========
step "3. Cai Docker & Docker Compose Plugin"
if ! command -v docker &> /dev/null; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt_retry apt-get -qqy update
  apt_retry apt-get -qqy install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable docker
systemctl start docker
log_step "Da cai Docker"

# ========== 4. Cai Nginx & Certbot ==========
step "4. Cai Nginx va Certbot"
apt_retry apt-get -qqy install nginx certbot python3-certbot-nginx
systemctl enable nginx
systemctl start nginx
log_step "Da cai Nginx va Certbot"

# ========== 5. Clone agent va build ==========
echo "Clone n8n-agent tu GitHub (ref: ${GIT_REF})..."
# Bao toan .env do bootstrap.sh pre-seed truoc khi xoa thu muc de clone lai.
PRESEEDED_ENV=""
if [ -f "$APP_DIR/.env" ]; then
  PRESEEDED_ENV="$(mktemp)"
  cp "$APP_DIR/.env" "$PRESEEDED_ENV"
fi

rm -rf "$APP_DIR"
git clone "$GIT_REPO" "$APP_DIR"
cd "$APP_DIR"
git checkout "$GIT_REF" 2>/dev/null || echo "Khong checkout duoc ref '${GIT_REF}', dung mac dinh."

# Khoi phuc .env da pre-seed (neu co).
if [ -n "$PRESEEDED_ENV" ]; then
  cp "$PRESEEDED_ENV" "$APP_DIR/.env"
  rm -f "$PRESEEDED_ENV"
fi

npm install
npm run build
log_step "Da clone va build n8n-agent"

# ========== 5.5 Tao/cap nhat .env cho agent ==========
echo "Chuan bi file .env cho agent..."
ENV_FILE="$APP_DIR/.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Doc lai gia tri da co trong .env (uu tien) de khong rotate key khi cai lai.
# `|| true` de grep khong khop (file rong) khong giet script duoi `set -e`.
existing_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d '=' -f2- || true; }
API_FROM_ENV="$(existing_env AGENT_API_KEY)"
PORT_FROM_ENV="$(existing_env PORT)"
IPS_FROM_ENV="$(existing_env ALLOWED_IP_RANGES)"

# Thu tu uu tien: gia tri trong .env > flag/bien moi truong > mac dinh.
# Dung `if` (khong dung `[ -n x ] && cmd`) vi duoi `set -e`, bieu thuc test tra
# exit 1 khi rong se giet script.
if [ -n "$API_FROM_ENV" ]; then AGENT_API_KEY="$API_FROM_ENV"; fi
if [ -n "$PORT_FROM_ENV" ]; then PORT="$PORT_FROM_ENV"; fi
if [ -n "$IPS_FROM_ENV" ]; then ALLOWED_IP_RANGES="$IPS_FROM_ENV"; fi

# Sinh API key ngau nhien neu chua co.
if [ -z "$AGENT_API_KEY" ]; then
  AGENT_API_KEY="$(openssl rand -hex 32)"
  echo "Da sinh AGENT_API_KEY ngau nhien."
fi

# Ghi lai .env (idempotent).
upsert_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}
upsert_env PORT "$PORT"
upsert_env AGENT_API_KEY "$AGENT_API_KEY"
if [ -n "$ALLOWED_IP_RANGES" ]; then upsert_env ALLOWED_IP_RANGES "$ALLOWED_IP_RANGES"; fi
log_step "Da chuan bi .env (PORT=$PORT)"

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

# ========== 9. Tu dong goi /api/n8n/install (ep cai, khong cho DNS) ==========
step "9. Tu dong cai n8n"

# IP that cua server (uu tien IP public). `|| true` tranh `set -e` giet script.
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || echo "127.0.0.1")
fi

# Do uu tien domain: --domain/DOMAIN > hostname -f (FQDN that) > <ip>.sslip.io.
# sslip.io luon phan giai ve chinh IP nay -> certbot cap SSL duoc ma khong can DNS.
if [[ -n "$DOMAIN_ARG" ]]; then
  DOMAIN="$DOMAIN_ARG"
  log "Domain (tu flag/env): $DOMAIN"
else
  HOSTNAME_FQDN=$(hostname -f 2>/dev/null || hostname)
  if [[ "$HOSTNAME_FQDN" == *.* && "$HOSTNAME_FQDN" != localhost* ]]; then
    DOMAIN="$HOSTNAME_FQDN"
    log "Domain (tu hostname -f): $DOMAIN"
  else
    DOMAIN="${SERVER_IP}.sslip.io"
    log "Domain (sslip.io fallback): $DOMAIN"
  fi
fi

echo "Chuan bi cai n8n cho domain: $DOMAIN (port agent: $PORT)"

# Cho agent service len (poll /api/n8n/status; localhost duoc bypass API key).
echo "Cho n8n-agent san sang..."
AGENT_READY=0
for i in $(seq 1 30); do
  if curl -fs -o /dev/null "http://localhost:$PORT/api/n8n/status"; then
    AGENT_READY=1
    echo "n8n-agent da san sang (lan thu $i)."
    break
  fi
  sleep 2
done

if [[ "$AGENT_READY" -ne 1 ]]; then
  echo "CANH BAO: n8n-agent chua phan hoi sau 60s, van thu goi API install..."
  log_step "n8n-agent khong phan hoi truoc khi goi install"
fi

# Canh bao neu DNS chua tro dung (certbot co the cap SSL that bai) nhung KHONG chan.
# `|| true`: grep khong khop (DNS chua tro) khong duoc giet script duoi `set -e`.
DOMAIN_IP=$(dig +short A "$DOMAIN" @1.1.1.1 2>/dev/null | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1 || true)
if [[ "$DOMAIN_IP" != "$SERVER_IP" ]]; then
  echo "LUU Y: DNS $DOMAIN -> ${DOMAIN_IP:-none} chua khop server IP $SERVER_IP."
  echo "       Van tien hanh cai; neu SSL that bai hay tro DNS roi goi lai /api/n8n/install."
  log_step "DNS chua tro dung nhung van ep cai n8n"
fi

echo "Goi API: http://localhost:$PORT/api/n8n/install"
curl -s -X POST "http://localhost:$PORT/api/n8n/install" \
  -H "Content-Type: application/json" \
  -H "tng-api-key: $AGENT_API_KEY" \
  -d '{"domain": "'"$DOMAIN"'", "email": "'"$EMAIL"'"}'
echo ""
log_step "Da goi API /api/n8n/install cho $DOMAIN"

# ========== 10. Ket thuc ==========
echo "Cai dat hoan tat!"
echo "Agent service: systemctl status n8n-agent"
echo "Auto-update: systemctl list-timers | grep n8n-agent"
echo "Manual update: $UPDATE_SCRIPT"

log_step "Toan bo cai dat hoan tat"
