#!/usr/bin/env bash
# Sourceable live-data environment for local dev tools.
#
# Loads the deployed Forge env and rewrites service URLs so host-run
# processes can talk to the live Docker network without rebuilding images.

PROD_ENV="${PROD_ENV_FILE:-/home/bailey/docker/forge/.env}"
if [[ ! -f "$PROD_ENV" ]]; then
  echo "[dev:live] Could not find live env at $PROD_ENV - set PROD_ENV_FILE." >&2
  return 1 2>/dev/null || exit 1
fi

# shellcheck disable=SC1090
set -a; source "$PROD_ENV"; set +a

resolve_live_ip() {
  local name="$1"
  local ip
  ip=$(docker inspect "$name" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print $1}')
  if [[ -z "$ip" ]]; then
    echo "[dev:live] Container $name not found or has no IP. Is the live stack up?" >&2
    return 1
  fi
  echo "$ip"
}

POSTGRES_IP=$(resolve_live_ip forge-postgres) || return 1 2>/dev/null || exit 1
REDIS_IP=$(resolve_live_ip forge-redis) || return 1 2>/dev/null || exit 1
MINIO_IP=$(resolve_live_ip forge-minio) || return 1 2>/dev/null || exit 1

export DATABASE_URL="postgresql://forge:${POSTGRES_PASSWORD}@${POSTGRES_IP}:5432/forge?schema=public"
export REDIS_URL="redis://${REDIS_IP}:6379"

# Internal S3 client uses the bridge IP; presigned URLs the browser hits stay
# on the public Traefik hostname.
export S3_ENDPOINT="http://${MINIO_IP}:9000"
export S3_PUBLIC_ENDPOINT="${S3_PUBLIC_ENDPOINT:-https://forge-s3.axiom-labs.dev}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY="${MINIO_ROOT_USER}"
export S3_SECRET_KEY="${MINIO_ROOT_PASSWORD}"
export S3_FORCE_PATH_STYLE="true"

DEV_PORT="${PORT:-3000}"
export AUTH_URL="${AUTH_URL_DEV:-http://localhost:${DEV_PORT}}"
export NEXT_PUBLIC_APP_URL="$AUTH_URL"
export AUTH_TRUST_HOST="true"

# Runtime fallback for legacy Hermes rows with no Runtime.endpoint. Managed
# runtime rows still win through Runtime.endpoint/secret.
export HERMES_GATEWAY_URL="${HERMES_GATEWAY_URL:-http://127.0.0.1:8642/v1}"

if [[ "${LIVE_ENV_QUIET:-0}" != "1" ]]; then
  echo "[dev:live] Live data:"
  echo "           postgres -> $POSTGRES_IP"
  echo "           redis    -> $REDIS_IP"
  echo "           minio    -> $MINIO_IP (presigned via $S3_PUBLIC_ENDPOINT)"
  echo "           app at   -> $AUTH_URL"
  echo "[dev:live] Sign in with the credentials in $PROD_ENV (ADMIN_EMAIL / ADMIN_PASSWORD)."
  echo
fi
