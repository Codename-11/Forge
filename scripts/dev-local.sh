#!/usr/bin/env bash
# Backward-compatible Git Bash entrypoint for the cross-platform local dev
# orchestrator. Prefer `pnpm dev` directly; .gitattributes keeps this LF-safe.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec pnpm --dir "$ROOT" exec tsx scripts/dev.ts start "$@"
