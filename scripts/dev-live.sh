#!/usr/bin/env bash
# pnpm dev:live:unsafe - exceptional live-data inspection only.
#
# Frontend HMR is instant; server routes (tRPC, MCP, webhook delivery) hit the
# live DB. Workers are disabled by default so the deployed worker remains
# authoritative. Starting local workers requires the explicit
# `pnpm dev:live:workers:unsafe` command.

set -euo pipefail

RUN_WORKERS="${RUN_WORKERS:-0}"
for arg in "$@"; do
  case "$arg" in
    --workers) RUN_WORKERS=1 ;;
    --no-workers) RUN_WORKERS=0 ;;
    *) echo "[dev:live] Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/dev-live-env.sh"

echo "[dev:live:unsafe] WARNING: this app process reads and writes DEPLOYED production data."
echo "[dev:live:unsafe] Use pnpm dev for normal workstation development."

if [[ "$RUN_WORKERS" == "0" ]]; then
  export FORGE_DISABLE_IN_PROCESS_WORKER="1"
  echo "[dev:live] In-process workers disabled. Production worker remains authoritative."
  echo
fi

if [[ -n "${DEV_HOST:-}" ]]; then
  exec pnpm exec next dev --turbo --hostname "$DEV_HOST"
else
  exec pnpm exec next dev --turbo
fi
