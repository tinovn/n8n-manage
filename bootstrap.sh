#!/bin/bash
# =============================================================================
# n8n-agent Bootstrap — cho cloud-init, pre-seed .env, reboot roi tu cai
#
# Luong su dung (Hostbill / SSH one-shot):
#   ssh root@vps "curl -fsSL https://raw.githubusercontent.com/tinovn/n8n-manage/main/bootstrap.sh | \
#     bash -s -- [--api-key <KEY>] [--port <PORT>] [--domain <FQDN>] \
#                [--email <EMAIL>] [--ips <CIDR,CIDR>] [--ref <GIT_REF>]"
#
# Cac flag nhan biet (gia tri pre-seed vao /opt/n8n-agent/.env, install-server.sh
# doc lai ma KHONG rotate):
#   --api-key  -> AGENT_API_KEY      (ghi vao .env)
#   --port     -> PORT               (ghi vao .env, mac dinh 7071)
#   --ips      -> ALLOWED_IP_RANGES  (ghi vao .env)
#   --domain   -> truyen sang install-server.sh qua --domain
#   --email    -> truyen sang install-server.sh qua --email
#   --ref      -> truyen sang install-server.sh qua --ref (branch/tag/SHA)
# Cac flag khac duoc chuyen tiep nguyen ven cho install-server.sh.
#
# Luong:
#   1. Detach khoi SSH (setsid + nohup) de song sot SSH timeout ngan.
#   2. Cho cloud-init xong.
#   3. Pre-seed /opt/n8n-agent/.env voi token operator cung cap.
#   4. Tai install-server.sh -> /opt/n8n-agent/n8n-install.sh.
#   5. Luu args -> /opt/n8n-agent/n8n-install.args.
#   6. Tao systemd one-shot, enable.
#   7. Reboot — install-server.sh chay sau boot, doc token tu .env.
#   8. Xong -> service tu disable + cleanup.
#
# Theo doi: journalctl -u n8n-agent-install -f
#       hoac: tail -f /var/log/n8n-agent-install.log
# =============================================================================

set -euo pipefail

readonly REPO_RAW="https://raw.githubusercontent.com/tinovn/n8n-manage/main"
readonly BOOT_DIR="/opt/n8n-agent"
readonly INSTALL_SCRIPT="${BOOT_DIR}/n8n-install.sh"
readonly INSTALL_ARGS="${BOOT_DIR}/n8n-install.args"
readonly ENV_FILE="${BOOT_DIR}/.env"
readonly LOG_FILE="/var/log/n8n-agent-install.log"
readonly SERVICE_NAME="n8n-agent-install"

# ---- Detach khoi SSH session dang goi -------------------------------------
# Hostbill / cron / caller kieu phpseclib goi voi SSH timeout ngan (vd setTimeout(30)).
# cloud-init --wait co the ton 1-3 phut tren VPS moi, nen SSH session bi dut giua
# chung va bash con nhan SIGHUP. De song sot, o lan chay dau tien ta re-spawn chinh
# minh bang setsid + nohup, chuyen output vao log, va thoat ngay de caller thay exit 0.
if [[ "${N8N_BOOTSTRAP_DETACHED:-0}" != "1" ]]; then
    mkdir -p "$BOOT_DIR" "$(dirname "$LOG_FILE")"
    # Luu script len dia de setsid re-exec (co the dang chay duoi `curl … | bash`,
    # khi do $0 chi la "bash").
    self="${BOOT_DIR}/.bootstrap.sh"
    if [[ -f "$0" && "$0" != "bash" && "$0" != "-bash" ]]; then
        cp -f "$0" "$self"
    else
        curl -fsSL "${REPO_RAW}/bootstrap.sh" -o "$self" \
            || { echo "FATAL: tai lai bootstrap that bai" >&2; exit 1; }
    fi
    chmod +x "$self"
    N8N_BOOTSTRAP_DETACHED=1 setsid nohup bash "$self" "$@" \
        >>"$LOG_FILE" 2>&1 </dev/null &
    disown 2>/dev/null || true
    echo "n8n-bootstrap: da detach (pid $!). Xem tien do: tail -f $LOG_FILE"
    exit 0
fi

mkdir -p "$BOOT_DIR"

# Sau khi detach, stdout/stderr da duoc redirect vao $LOG_FILE, nen chi echo ra
# stderr (tranh double khi dung them `tee -a $LOG_FILE`).
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] bootstrap: $*" >&2; }

log "=== n8n-agent bootstrap bat dau ==="

# ---- 0. Parse flags: tach loai ghi-.env vs loai chuyen-tiep --------------
# Gia tri pre-seed vao .env. Cac flag domain/email/ref (va flag la) chuyen tiep
# nguyen ven sang install-server.sh qua $INSTALL_ARGS.
API_KEY=""; PORT=""; IPS=""
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    # --mgmt-key la alias cua --api-key (dong bo voi Hermes / Hostbill template).
    --api-key|--mgmt-key) API_KEY="$2"; shift 2 ;;
    --port)    PORT="$2"; shift 2 ;;
    --ips)     IPS="$2"; shift 2 ;;
    --domain)  PASSTHROUGH+=(--domain "$2"); shift 2 ;;
    --email)   PASSTHROUGH+=(--email "$2"); shift 2 ;;
    --ref)     PASSTHROUGH+=(--ref "$2"); shift 2 ;;
    *)         PASSTHROUGH+=("$1"); shift ;;
  esac
done

# Luu args chuyen tiep cho install-server.sh (co the rong).
printf '%s ' "${PASSTHROUGH[@]:-}" > "$INSTALL_ARGS"
log "Args chuyen tiep cho install-server.sh: ${PASSTHROUGH[*]:-(rong)}"

# ---- 0b. Pre-seed .env ----------------------------------------------------
# Bootstrap la diem provisioning dau tien: no GHI DE cac gia tri operator cung
# cap vao .env de flag luon thang o lan boot dau. install-server.sh doc lai ma
# khong rotate.
write_env_key() {
  local key="$1" value="$2"
  [[ -z "$value" ]] && return 0
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"; rm -f "${ENV_FILE}.bak"
    log "  ${key}: ghi de trong .env"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    log "  ${key}: them vao .env"
  fi
}
write_env_key AGENT_API_KEY     "$API_KEY"
write_env_key PORT              "$PORT"
write_env_key ALLOWED_IP_RANGES "$IPS"

# ---- 1. Cho cloud-init ----------------------------------------------------
# cloud-init co the ket thuc voi exit 2 (RECOVERABLE_ERROR / warning) du da thanh
# cong; duoi `set -euo pipefail` dieu do se giet bootstrap. Bat status rieng va
# coi ma khong nghiem trong (0/2) la thanh cong.
if command -v cloud-init &>/dev/null; then
    log "Cho cloud-init hoan tat (toi da ${CLOUD_INIT_WAIT:-300}s)..."
    # Bao boc `timeout` phong khi cloud-init treo (vd DataSourceNoCloud ket).
    set +e
    timeout "${CLOUD_INIT_WAIT:-300}" cloud-init status --wait >/tmp/ci-wait.log 2>&1
    ci_rc=$?
    set -e
    while IFS= read -r line; do log "cloud-init: $line"; done < /tmp/ci-wait.log
    rm -f /tmp/ci-wait.log
    case "$ci_rc" in
        0|2) log "cloud-init xong (exit=$ci_rc)." ;;
        124) log "WARN: cloud-init qua ${CLOUD_INIT_WAIT:-300}s chua xong; tiep tuc reboot." ;;
        *)   log "WARN: cloud-init exit $ci_rc; tiep tuc." ;;
    esac
else
    log "Khong co cloud-init, bo qua buoc cho."
fi

# ---- 2. Tai install-server.sh ---------------------------------------------
log "Tai install-server.sh tu ${REPO_RAW}"
if ! curl -fsSL "${REPO_RAW}/install-server.sh" -o "$INSTALL_SCRIPT"; then
    log "FATAL: Tai install-server.sh that bai"
    exit 1
fi
chmod +x "$INSTALL_SCRIPT"
log "install-server.sh da tai ($(wc -l < "$INSTALL_SCRIPT") dong)"

# ---- 3. Tao systemd oneshot service + timer OnBootSec ---------------------
# Dung timer OnBootSec (thay vi WantedBy=multi-user.target) de dam bao service
# CHAC CHAN chay sau reboot, khong phu thuoc target ordering / cloud-init.
# Service tu cleanup ca service lan timer khi chay xong (chi cai 1 lan).
log "Tao ${SERVICE_NAME}.service + .timer"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=n8n-agent one-shot installer (chay 1 lan sau reboot)
After=network-online.target
Wants=network-online.target
ConditionPathExists=${INSTALL_SCRIPT}

[Service]
Type=oneshot
RemainAfterExit=no
Environment=DEBIAN_FRONTEND=noninteractive
ExecStart=/bin/bash -c '${INSTALL_SCRIPT} \$(cat ${INSTALL_ARGS}) >> ${LOG_FILE} 2>&1; rc=\$?; systemctl disable ${SERVICE_NAME}.timer; rm -f /etc/systemd/system/${SERVICE_NAME}.timer /etc/systemd/system/${SERVICE_NAME}.service ${INSTALL_SCRIPT} ${INSTALL_ARGS}; systemctl daemon-reload; exit \$rc'
StandardOutput=journal
StandardError=journal
TimeoutStartSec=30min
EOF

cat > "/etc/systemd/system/${SERVICE_NAME}.timer" <<EOF
[Unit]
Description=Kich hoat n8n-agent installer sau khi boot

[Timer]
OnBootSec=20s
AccuracySec=1s
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.timer"

log "Da len lich (timer OnBootSec=20s). Reboot sau 5s..."
log "Theo doi: journalctl -u ${SERVICE_NAME} -f"
log "     hoac: tail -f ${LOG_FILE}"

# ---- 4. Reboot ------------------------------------------------------------
nohup bash -c 'sleep 5 && systemctl reboot' >/dev/null 2>&1 &
exit 0
