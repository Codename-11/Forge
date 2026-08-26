#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${FORGE_ENV_FILE:-${HERMES_HOME:-$HOME/.hermes}/forge.env}
if [[ ! -r "$ENV_FILE" ]]; then
  echo "forge-presence: env file is not readable: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${FORGE_URL:?forge-presence: FORGE_URL is required}"
: "${FORGE_API_KEY:?forge-presence: FORGE_API_KEY is required}"

curl --fail --silent --show-error --max-time 15 \
  --output /dev/null \
  --request POST "${FORGE_URL%/}/api/mcp/agents.heartbeat" \
  --header "Authorization: Bearer ${FORGE_API_KEY}" \
  --header "Content-Type: application/json" \
  --header "User-Agent: Forge-Presence/1.0.0" \
  --data '{}'
