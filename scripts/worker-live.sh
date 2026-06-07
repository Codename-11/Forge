#!/usr/bin/env bash
# Run the Forge worker on the host against live Docker services.
#
# Use this only when intentionally testing dispatch/runtime logic against live
# data. The production worker is still running, so keep sessions short.

set -euo pipefail

WATCH=0
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    *) echo "[worker:live] Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/dev-live-env.sh"

export NODE_OPTIONS="--require ./scripts/ignore-server-only.cjs"

if [[ "$WATCH" == "1" ]]; then
  echo "[worker:live] Starting watched worker against live data."
  exec pnpm exec tsx watch src/server/worker.ts
fi

echo "[worker:live] Starting worker against live data."
exec pnpm exec tsx src/server/worker.ts
