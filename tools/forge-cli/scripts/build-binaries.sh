#!/bin/sh
# Cross-compile standalone `forge` binaries for all platforms via Bun.
# Requires: bun on PATH, and tools/forge-cli/dist built (`pnpm build:cli`).
# Output dir: $OUT (default tools/forge-cli/binaries/). Also writes SHA256SUMS.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)   # tools/forge-cli
SRC="$ROOT/dist/index.js"
OUT="${OUT:-$ROOT/binaries}"

[ -f "$SRC" ] || { echo "build-binaries: $SRC missing — run 'pnpm build:cli' first" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "build-binaries: bun is required" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"
for t in linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; do
  ext=""; [ "$t" = "windows-x64" ] && ext=".exe"
  echo "build-binaries: forge-${t}${ext}"
  bun build "$SRC" --compile --target="bun-${t}" --outfile "$OUT/forge-${t}${ext}"
done

( cd "$OUT" && sha256sum forge-* > SHA256SUMS )
echo "build-binaries: done → $OUT"
ls -lh "$OUT"
