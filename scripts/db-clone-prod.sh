#!/usr/bin/env bash
# pnpm db:clone-prod — clone the LIVE Forge Postgres into the local docker
# stack for full-fidelity local testing against real data.
#
# This is the reliable "import existing db" path: a Postgres-level dump
# captures every one of the ~70 models with correct foreign keys, instead
# of trying to serialise the whole schema to JSON. Use the admin UI
# export/import (Settings → Data) when you want a portable single-workspace
# snapshot; use this when you want an exact replica of prod locally.
#
#   pnpm db:clone-prod
#
# Reads the live Postgres password from ~/docker/forge/.env. Dumps from the
# `forge-postgres` container straight into `forge-dev-postgres` (no file on
# disk, no secrets written out). Destructive to the LOCAL db only — it
# never writes to prod (pg_dump is read-only).
#
# After cloning, run `pnpm dev:local --no-seed` to iterate on the data.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"
PROD_ENV="${PROD_ENV_FILE:-/home/bailey/docker/forge/.env}"

PROD_CONTAINER="forge-postgres"
DEV_CONTAINER="forge-dev-postgres"

if [[ ! -f "$PROD_ENV" ]]; then
  echo "[db:clone-prod] Could not find live env at $PROD_ENV — set PROD_ENV_FILE." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$PROD_ENV"; set +a

if ! docker inspect "$PROD_CONTAINER" >/dev/null 2>&1; then
  echo "[db:clone-prod] Live container '$PROD_CONTAINER' not found. Is the prod stack up?" >&2
  exit 1
fi

echo "[db:clone-prod] Ensuring local docker stack is up…"
docker compose -f "$COMPOSE_FILE" up -d postgres >/dev/null
for i in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U forge >/dev/null 2>&1; then break; fi
  [[ "$i" == "30" ]] && { echo "[db:clone-prod] Local Postgres not ready." >&2; exit 1; }
  sleep 1
done

echo "[db:clone-prod] Dumping '$PROD_CONTAINER' → '$DEV_CONTAINER' (this replaces local data)…"
# --clean --if-exists so the dump drops & recreates objects; --no-owner /
# --no-acl so roles from prod don't have to exist locally. PGPASSWORD is
# the live password (read), the dev side uses the static 'forge' password.
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" "$PROD_CONTAINER" \
  pg_dump -U forge -d forge --no-owner --no-acl --clean --if-exists \
  | docker exec -i -e PGPASSWORD="forge" "$DEV_CONTAINER" \
  psql -U forge -d forge -v ON_ERROR_STOP=0 >/dev/null

echo "[db:clone-prod] Applying any newer local migrations…"
DATABASE_URL="postgresql://forge:forge@localhost:55432/forge?schema=public" \
  pnpm exec prisma migrate deploy

echo
echo "[db:clone-prod] Done. Local DB now mirrors prod."
echo "[db:clone-prod] Note: attachment BYTES live in MinIO and are NOT copied —"
echo "                FILE attachment rows will reference objects that aren't in"
echo "                the local bucket. Metadata, LINK attachments, and all other"
echo "                data are intact. Run: pnpm dev:local --no-seed"
