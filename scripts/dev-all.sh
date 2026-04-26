#!/usr/bin/env bash
# pnpm dev:all — run the Next dev server (port 3000) and the VitePress
# docs server (port 5181) side by side. Logs interleave with [app] /
# [docs] prefixes; ctrl-c kills both cleanly.
#
# Use `pnpm dev:live` if you want the app pointed at live data; this
# script just wraps the standard `next dev --turbo`. Run dev:live in
# one terminal and `pnpm docs:dev` in another if you prefer separate
# windows.

set -euo pipefail

cleanup() {
  trap - INT TERM EXIT
  if [[ -n "${APP_PID:-}" ]]; then kill "$APP_PID" 2>/dev/null || true; fi
  if [[ -n "${DOCS_PID:-}" ]]; then kill "$DOCS_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[dev:all] app  → http://localhost:3000"
echo "[dev:all] docs → http://localhost:5181/docs/"
echo

pnpm exec next dev --turbo 2>&1 | sed -u 's/^/[app]  /' &
APP_PID=$!

pnpm --dir docs --ignore-workspace dev 2>&1 | sed -u 's/^/[docs] /' &
DOCS_PID=$!

wait
