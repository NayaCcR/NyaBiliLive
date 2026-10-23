#!/usr/bin/env bash
# Install (or refresh) NyaBiliLive as a systemd service.
#
# Why this exists: the production process used to be started by hand
# (`npm run start` with PPID 1), with no systemd unit, no pm2 entry and no cron
# guard. When it died on 2026-10-15 nothing brought it back, and danmaku,
# waiting-area and user monitoring stayed dark for eight days. systemd
# `Restart=always` closes that hole and also gives the process a boot hook.
#
# Usage:  sudo bash deploy/install-service.sh [install-dir]
# Default install dir: /server/NyaBiliLive

set -euo pipefail

APP_DIR="${1:-/server/NyaBiliLive}"
SERVICE_NAME="nyabililive"
UNIT_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${SERVICE_NAME}.service"
UNIT_TARGET="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(command -v node)"

if [[ ! -f "${APP_DIR}/server/index.js" ]]; then
  echo "找不到 ${APP_DIR}/server/index.js，请先部署代码" >&2
  exit 1
fi

if [[ -z "${NODE_BIN}" ]]; then
  echo "找不到 node，请先安装 Node.js >= 20" >&2
  exit 1
fi

mkdir -p "${APP_DIR}/data/logs"

# Render the unit with this host's real paths so the template stays portable.
sed \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
  -e "s|^ExecStart=.*|ExecStart=${NODE_BIN} server/index.js|" \
  -e "s|^Environment=NYABILILIVE_LOG_DIR=.*|Environment=NYABILILIVE_LOG_DIR=${APP_DIR}/data/logs|" \
  -e "s|^StandardOutput=.*|StandardOutput=append:${APP_DIR}/data/logs/stdout.log|" \
  -e "s|^StandardError=.*|StandardError=append:${APP_DIR}/data/logs/stderr.log|" \
  "${UNIT_SOURCE}" > "${UNIT_TARGET}"

# Stop the legacy hand-started process so only systemd owns the port.
if pgrep -f "node server/index.js" >/dev/null 2>&1; then
  echo "停止旧的手工进程…"
  pkill -f "node server/index.js" || true
  sleep 2
fi

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 3
systemctl --no-pager --full status "${SERVICE_NAME}" || true

echo
echo "完成。常用命令："
echo "  systemctl status ${SERVICE_NAME}"
echo "  systemctl restart ${SERVICE_NAME}"
echo "  journalctl -u ${SERVICE_NAME} -f"
echo "  tail -f ${APP_DIR}/data/logs/nyabililive.log"
