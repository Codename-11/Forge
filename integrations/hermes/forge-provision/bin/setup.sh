#!/usr/bin/env bash
set -euo pipefail

PROFILE=${1:-victor}
SKILL_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ "$PROFILE" == "victor" ]]; then
  ENV_FILE=${FORGE_ENV_FILE:-$HOME/.hermes/forge.env}
else
  ENV_FILE=${FORGE_ENV_FILE:-$HOME/.hermes/profiles/$PROFILE/forge.env}
fi

if [[ ! -r "$ENV_FILE" ]]; then
  echo "forge-provision: create $ENV_FILE from forge.env.example first" >&2
  exit 1
fi

MARKER="# forge-provision:${PROFILE}"
ENTRY="17 * * * * FORGE_ENV_FILE='$ENV_FILE' '$SKILL_ROOT/bin/run.sh' ${MARKER}"
CURRENT=$(crontab -l 2>/dev/null || true)
FILTERED=$(printf '%s\n' "$CURRENT" | grep -Fv "$MARKER" || true)
printf '%s\n%s\n' "$FILTERED" "$ENTRY" | crontab -
echo "forge-provision: installed hourly refresh for $PROFILE"
