#!/bin/sh
# Build the VitePress docs and stage them under public/docs/ so the Next
# server can serve them at /docs/ on the same origin as the app shell.
#
# Why same-origin: the workspace /docs route iframes /docs/?embed=dashboard
# (see src/app/(app)/w/[slug]/docs/). Same-origin avoids CORS and lets the
# X-Frame-Options: SAMEORIGIN header (set in next.config.ts) succeed.
#
# POSIX sh (not bash) so this works in the node:20-alpine runner without
# pulling bash in just for one script. The Docker build runs this as part
# of `pnpm build`.
#
# Skips the rebuild if STAGE_ONLY=1 — useful in CI when you've already
# built docs in a prior step. Skips entirely if SKIP_DOCS=1 so a hot
# inner-loop `pnpm build:app` doesn't pay the docs cost.

set -eu

if [ "${SKIP_DOCS:-0}" = "1" ]; then
  echo "[build-docs] SKIP_DOCS=1 — skipping docs build."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$ROOT_DIR/docs"
DIST_DIR="$DOCS_DIR/.vitepress/dist"
PUBLIC_DOCS="$ROOT_DIR/public/docs"

if [ "${STAGE_ONLY:-0}" != "1" ]; then
  if [ ! -d "$DOCS_DIR/node_modules" ]; then
    echo "[build-docs] Installing docs deps (first run)..."
    # Don't fail if the lockfile is out of date in CI — fall back to a
    # plain install so the build proceeds.
    pnpm --dir "$DOCS_DIR" --ignore-workspace install --frozen-lockfile \
      || pnpm --dir "$DOCS_DIR" --ignore-workspace install
  fi
  echo "[build-docs] Building VitePress site..."
  pnpm --dir "$DOCS_DIR" --ignore-workspace build
fi

if [ ! -d "$DIST_DIR" ]; then
  echo "[build-docs] Expected dist at $DIST_DIR but it's missing. Did the build fail?" >&2
  exit 1
fi

echo "[build-docs] Staging dist → public/docs/"
rm -rf "$PUBLIC_DOCS"
mkdir -p "$PUBLIC_DOCS"
# Copy contents (not the dir itself) so files land directly under
# public/docs/. -a preserves timestamps; rsync would be overkill here.
cp -a "$DIST_DIR"/. "$PUBLIC_DOCS"/

echo "[build-docs] Done. Forge prod will serve docs at /docs/."
