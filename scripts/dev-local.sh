#!/usr/bin/env bash
# pnpm dev:local — fully isolated local dev loop.
#
# Unlike `dev:live` (which points `next dev` at the *deployed* Postgres /
# Redis / MinIO and edits prod data), this boots the throwaway docker
# stack in docker/docker-compose.yml, migrates + seeds it, and runs the
# HMR dev server against that local-only data. Nothing here can touch
# production. This is the loop for rapid UI iteration.
#
#   pnpm dev:local            # boot stack, migrate, seed if empty, run dev
#   pnpm dev:local --fresh    # wipe the local DB first, then the above
#   pnpm dev:local --no-seed  # skip seeding (e.g. after db:clone-prod)
#
# Sign in at http://localhost:3000 with ADMIN_EMAIL / ADMIN_PASSWORD
# printed below — the credentials provider upserts that user and the
# seed gives them an OWNER membership on the "forge" workspace.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"

FRESH=0
SEED=1
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --no-seed) SEED=0 ;;
    *) echo "[dev:local] Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# ---- Local-only environment ----------------------------------------------
# Host ports match docker/docker-compose.yml (5xxxx / 59xxx range).
export DATABASE_URL="postgresql://forge:forge@localhost:55432/forge?schema=public"
export REDIS_URL="redis://localhost:56379"

export S3_ENDPOINT="http://localhost:59000"
export S3_PUBLIC_ENDPOINT="http://localhost:59000"
export S3_REGION="us-east-1"
export S3_ACCESS_KEY="forgeminio"
export S3_SECRET_KEY="forgeminio-dev-password"
export S3_FORCE_PATH_STYLE="true"

# Stable dev auth — fixed secret so sessions survive restarts. The
# credentials provider keys off ADMIN_EMAIL / ADMIN_PASSWORD; ADMIN_HANDLE
# = "forge" so its bootstrap workspace lines up with the seed's slug.
export AUTH_SECRET="${AUTH_SECRET:-dev-local-secret-changeme-32bytes!!}"
export AUTH_URL="${AUTH_URL_DEV:-http://localhost:3000}"
export NEXT_PUBLIC_APP_URL="$AUTH_URL"
export AUTH_TRUST_HOST="true"
export ADMIN_EMAIL="${ADMIN_EMAIL:-owner@forge.local}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-forge-dev}"
export ADMIN_NAME="${ADMIN_NAME:-Forge Owner}"
export ADMIN_HANDLE="${ADMIN_HANDLE:-forge}"

export PLUGIN_JWT_SECRET="${PLUGIN_JWT_SECRET:-dev-plugin-signing-key}"
export PLUGIN_JWT_ISSUER="${PLUGIN_JWT_ISSUER:-forge}"
export PLUGIN_JWT_AUDIENCE="${PLUGIN_JWT_AUDIENCE:-forge-plugins}"

# Local AI features point at a local gateway if one is running; harmless
# if it isn't (AI features just error at call time, not boot).
export HERMES_GATEWAY_URL="${HERMES_GATEWAY_URL:-http://127.0.0.1:8642/v1}"

# ---- Bring up the isolated stack ------------------------------------------
echo "[dev:local] Starting docker stack (postgres/redis/minio)…"
docker compose -f "$COMPOSE_FILE" up -d

echo "[dev:local] Waiting for Postgres to accept connections…"
for i in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U forge >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" == "30" ]]; then
    echo "[dev:local] Postgres did not become ready in time." >&2
    exit 1
  fi
  sleep 1
done

if [[ "$FRESH" == "1" ]]; then
  echo "[dev:local] --fresh: dropping and recreating the public schema…"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U forge -d forge -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
fi

echo "[dev:local] Applying migrations…"
pnpm exec prisma migrate deploy
pnpm exec prisma generate >/dev/null

if [[ "$SEED" == "1" ]]; then
  # Seed only if the workspace table is empty, so re-running dev:local on
  # an existing local DB (or after db:clone-prod) doesn't clobber data.
  COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U forge -d forge -tAc 'SELECT count(*) FROM "Workspace";' 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [[ "${COUNT:-0}" == "0" ]]; then
    echo "[dev:local] Empty DB — seeding rich fixtures…"
    pnpm exec tsx prisma/seed.ts
  else
    echo "[dev:local] DB already has $COUNT workspace(s) — skipping seed (use --fresh to reset)."
  fi
fi

echo
echo "[dev:local] Local data:"
echo "           postgres → localhost:55432 (forge/forge)"
echo "           redis    → localhost:56379"
echo "           minio    → localhost:59000 (console :59001)"
echo "           app at   → $AUTH_URL"
echo "[dev:local] Sign in: $ADMIN_EMAIL / $ADMIN_PASSWORD"
echo

exec pnpm exec next dev --turbo
