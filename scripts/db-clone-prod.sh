#!/usr/bin/env bash
# Backward-compatible Git Bash entrypoint. The cross-platform TypeScript
# orchestrator owns target validation, confirmation, and streaming. The file is
# LF-pinned for Git Bash on Windows.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec pnpm --dir "$ROOT" exec tsx scripts/dev.ts refresh "$@"
