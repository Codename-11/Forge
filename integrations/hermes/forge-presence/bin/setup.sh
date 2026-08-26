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
  echo "forge-presence: create $ENV_FILE from forge.env.example first" >&2
  exit 1
fi

MARKER="# forge-presence:${PROFILE}"
ENTRY="* * * * * FORGE_ENV_FILE='$ENV_FILE' '$SKILL_ROOT/bin/heartbeat.sh' >/dev/null ${MARKER}"
CURRENT=$(crontab -l 2>/dev/null || true)
FILTERED=$(printf '%s\n' "$CURRENT" | grep -Fv "$MARKER" || true)
printf '%s\n%s\n' "$FILTERED" "$ENTRY" | crontab -
echo "forge-presence: installed one-minute heartbeat for $PROFILE"
