#!/usr/bin/env bash
# Run the live-data app server and a watched live-data worker side by side.
#
# This is the rapid loop for changes that span UI/API plus worker-driven
# dispatch/runtime logic. The app disables in-process workers so there is only
# one local worker process to restart on code changes.

set -euo pipefail

LAN_MODE=0
for arg in "$@"; do
  case "$arg" in
    --lan) LAN_MODE=1 ;;
    *) echo "[dev:live:stack] Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

detect_lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
}

if [[ "$LAN_MODE" == "1" ]]; then
  DEV_PORT="${PORT:-3000}"
  LAN_IP="${LAN_IP:-$(detect_lan_ip)}"
  if [[ -z "$LAN_IP" ]]; then
    echo "[dev:live:stack] Could not detect a LAN IP. Set LAN_IP=..." >&2
    exit 1
  fi
  export DEV_HOST="${DEV_HOST:-0.0.0.0}"
  export AUTH_URL_DEV="${AUTH_URL_DEV:-http://${LAN_IP}:${DEV_PORT}}"
fi

cleanup() {
  trap - INT TERM EXIT
  if [[ -n "${APP_PID:-}" ]]; then kill "$APP_PID" 2>/dev/null || true; fi
  if [[ -n "${WORKER_PID:-}" ]]; then kill "$WORKER_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[dev:live:stack] app    -> ${AUTH_URL_DEV:-http://localhost:${PORT:-3000}}"
echo "[dev:live:stack] worker -> live Redis/Postgres, watched with tsx"
echo

./scripts/dev-live.sh --no-workers 2>&1 | sed -u 's/^/[app]    /' &
APP_PID=$!

LIVE_ENV_QUIET=1 ./scripts/worker-live.sh --watch 2>&1 | sed -u 's/^/[worker] /' &
WORKER_PID=$!

wait -n "$APP_PID" "$WORKER_PID"
