#!/usr/bin/env bash
# pnpm dev / pnpm dev:live - run `next dev` against the deployed Postgres /
# Redis / MinIO instead of a local docker compose stack.
#
# Frontend HMR is instant; server routes (tRPC, MCP, webhook delivery) hit the
# live DB. By default this preserves the historical behavior and boots workers
# in-process via Next instrumentation. For UI/API-only live dev, use
# `pnpm dev:live:ui` or pass `--no-workers`.

set -euo pipefail

RUN_WORKERS="${RUN_WORKERS:-1}"
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
