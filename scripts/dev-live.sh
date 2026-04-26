#!/usr/bin/env bash
# pnpm dev:live — run `next dev` against the deployed Postgres / Redis /
# MinIO instead of a local docker compose stack.
#
# Why: HMR-backed UI iteration without a 2-minute container rebuild for
# every change. We're the only operators; the prod data is the data we
# care about.
#
# Mirrors Lucid's `pnpm run dev` pattern, adapted for Forge's full-stack
# Next.js layout. Frontend HMR is instant; server routes (tRPC, MCP,
# webhook delivery) hit the live DB. Auth is session-scoped to
# localhost:3000, so you log in fresh in dev — that's intentional.
#
# Reads ~/docker/forge/.env for the live secrets and resolves docker
# bridge IPs at boot so a container recreate doesn't break dev. If you
# want the dev server reachable from the LAN, run with
# DEV_HOST=0.0.0.0 (the dev:host script does this).

set -euo pipefail

PROD_ENV="${PROD_ENV_FILE:-/home/bailey/docker/forge/.env}"
if [[ ! -f "$PROD_ENV" ]]; then
  echo "[dev:live] Could not find live env at $PROD_ENV — set PROD_ENV_FILE." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$PROD_ENV"; set +a

resolve_ip() {
  local name="$1"
  local ip
  ip=$(docker inspect "$name" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print $1}')
  if [[ -z "$ip" ]]; then
    echo "[dev:live] Container $name not found or has no IP. Is the live stack up?" >&2
    exit 1
  fi
  echo "$ip"
}

POSTGRES_IP=$(resolve_ip forge-postgres)
REDIS_IP=$(resolve_ip forge-redis)
MINIO_IP=$(resolve_ip forge-minio)

export DATABASE_URL="postgresql://forge:${POSTGRES_PASSWORD}@${POSTGRES_IP}:5432/forge?schema=public"
export REDIS_URL="redis://${REDIS_IP}:6379"

# Internal S3 client uses the bridge IP; presigned URLs the browser
# actually hits stay on the public Traefik hostname.
export S3_ENDPOINT="http://${MINIO_IP}:9000"
export S3_PUBLIC_ENDPOINT="${S3_PUBLIC_ENDPOINT:-https://forge-s3.axiom-labs.dev}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY="${MINIO_ROOT_USER}"
export S3_SECRET_KEY="${MINIO_ROOT_PASSWORD}"
export S3_FORCE_PATH_STYLE="true"

# NextAuth — override so callbacks return to localhost, but keep the
# same secret so JWTs verify against existing sessions if you copied
# any over (rare; usually you'll just sign in fresh).
export AUTH_URL="${AUTH_URL_DEV:-http://localhost:3000}"
export NEXT_PUBLIC_APP_URL="$AUTH_URL"
export AUTH_TRUST_HOST="true"

# Hermes provider — point at the local gateway so AI features work.
export HERMES_GATEWAY_URL="${HERMES_GATEWAY_URL:-http://127.0.0.1:8642/v1}"

echo "[dev:live] Live data:"
echo "           postgres → $POSTGRES_IP"
echo "           redis    → $REDIS_IP"
echo "           minio    → $MINIO_IP (presigned via $S3_PUBLIC_ENDPOINT)"
echo "           app at   → $AUTH_URL"
echo "[dev:live] Sign in with the credentials in $PROD_ENV (ADMIN_EMAIL / ADMIN_PASSWORD)."
echo

if [[ -n "${DEV_HOST:-}" ]]; then
  exec pnpm exec next dev --turbo --hostname "$DEV_HOST"
else
  exec pnpm exec next dev --turbo
fi
