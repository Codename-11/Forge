#!/bin/sh
# Build the VitePress docs and stage them under landing/public/docs/ so the
# landing site's static export serves the full documentation at
# forge-pm.dev/docs/.
#
# This mirrors the app's ../scripts/build-docs.sh — the SAME VitePress site
# (<repo>/docs, base "/docs/") — retargeted into the public marketing site
# instead of the app shell. There is one docs source; both the app
# (forge.axiom-labs.dev/docs/) and the public site (forge-pm.dev/docs/)
# build it. No second renderer.
#
# Because the landing is a pure static export, no Next rewrite is needed:
# static hosts auto-serve index.html for the bare /docs/ directory, and
# VitePress's base "/docs/" makes every asset URL resolve under the subpath.
#
# POSIX sh (the node:20-alpine runner has no bash). STAGE_ONLY=1 re-copies an
# existing dist without rebuilding; SKIP_DOCS=1 skips entirely for a fast
# landing-only inner loop.

set -eu

if [ "${SKIP_DOCS:-0}" = "1" ]; then
  echo "[landing build-docs] SKIP_DOCS=1 — skipping docs build."
  exit 0
fi

LANDING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$LANDING_DIR/.." && pwd)"
DOCS_DIR="$REPO_DIR/docs"
DIST_DIR="$DOCS_DIR/.vitepress/dist"
PUBLIC_DOCS="$LANDING_DIR/public/docs"

if [ ! -d "$DOCS_DIR" ]; then
  echo "[landing build-docs] No docs/ at $DOCS_DIR — skipping (landing built in isolation)."
  exit 0
fi

if [ "${STAGE_ONLY:-0}" != "1" ]; then
  if [ ! -d "$DOCS_DIR/node_modules" ]; then
    echo "[landing build-docs] Installing docs deps (first run)..."
    # Don't fail if the lockfile is stale in CI — fall back to a plain install.
    pnpm --dir "$DOCS_DIR" --ignore-workspace install --frozen-lockfile \
      || pnpm --dir "$DOCS_DIR" --ignore-workspace install
  fi
  echo "[landing build-docs] Building VitePress site..."
  pnpm --dir "$DOCS_DIR" --ignore-workspace build
fi

if [ ! -d "$DIST_DIR" ]; then
  echo "[landing build-docs] Expected dist at $DIST_DIR but it's missing. Did the build fail?" >&2
  exit 1
fi

echo "[landing build-docs] Staging dist → landing/public/docs/"
rm -rf "$PUBLIC_DOCS"
mkdir -p "$PUBLIC_DOCS"
# Copy contents (not the dir itself) so files land directly under
# public/docs/. -a preserves timestamps.
cp -a "$DIST_DIR"/. "$PUBLIC_DOCS"/

echo "[landing build-docs] Done. forge-pm.dev will serve docs at /docs/."
