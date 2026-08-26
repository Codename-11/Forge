#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${FORGE_ENV_FILE:-${HERMES_HOME:-$HOME/.hermes}/forge.env}
if [[ ! -r "$ENV_FILE" ]]; then
  echo "forge-provision: env file is not readable: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${FORGE_URL:?forge-provision: FORGE_URL is required}"
: "${FORGE_API_KEY:?forge-provision: FORGE_API_KEY is required}"

TMP=$(mktemp "${TMPDIR:-/tmp}/forge-provision.XXXXXX.cjs")
trap 'rm -f "$TMP"' EXIT
curl --fail --silent --show-error --max-time 30 \
  --header "User-Agent: Forge-Provision/1.0.0" \
  "${FORGE_URL%/}/api/integrations/provision-script" \
  --output "$TMP"
FORGE_BASE_URL="${FORGE_URL%/}" node "$TMP"
