#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TAG=${1:-$(node -p "'v' + require('$ROOT/package.json').version")}
OUT=${2:-${OUT:-$ROOT/dist/hermes-helpers}}
mkdir -p "$OUT"
rm -f "$OUT"/forge-presence-*.tar.gz "$OUT"/forge-provision-*.tar.gz "$OUT/SHA256SUMS"

for helper in forge-presence forge-provision; do
  archive="$OUT/${helper}-${TAG}.tar.gz"
  tar -C "$ROOT/integrations/hermes" -czf "$archive" "$helper"
done

(
  cd "$OUT"
  sha256sum forge-presence-*.tar.gz forge-provision-*.tar.gz > SHA256SUMS
)

printf 'Packaged Hermes helpers in %s\n' "$OUT"
