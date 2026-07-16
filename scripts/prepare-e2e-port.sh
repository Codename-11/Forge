#!/usr/bin/env bash
# Called only after acquiring /tmp/forge-e2e.lock. Ensure Playwright cannot
# silently reuse a stale local server and wait for its wrapper process to
# finish releasing the socket before starting a fresh one.
set -euo pipefail

PORT="${E2E_PORT:-3200}"

fuser -k "${PORT}/tcp" 2>/dev/null || true

for _ in $(seq 1 30); do
  if ! fuser "${PORT}/tcp" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "[e2e] Port ${PORT} is still occupied after waiting for stale-server shutdown." >&2
exit 1
