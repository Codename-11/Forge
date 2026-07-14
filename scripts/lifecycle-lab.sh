#!/usr/bin/env bash
# Deterministic issue-lifecycle lab for product iteration and browser audits.
# Uses its own Postgres database, Redis logical DB, Next build directory, and
# port. It cannot read or mutate production or the shared dev:local database.
#
#   pnpm dev:lifecycle --fresh          # HMR server at http://localhost:3300
#   pnpm dev:lifecycle                  # reseed lab scenarios, preserve schema
#   pnpm dev:lifecycle --production     # deterministic next start (Playwright)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"
PORT="${LIFECYCLE_PORT:-3300}"
FRESH=0
PRODUCTION=0

for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --production) PRODUCTION=1 ;;
    *) echo "[lifecycle] Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# Deliberately ignore inherited application URLs. A shell pointed at staging or
# production must still land on the disposable local lab stores.
export DATABASE_URL="postgresql://forge:forge@localhost:55432/forge_lifecycle?schema=public"
export REDIS_URL="redis://localhost:56379/14"
export S3_ENDPOINT="http://localhost:59000"
export S3_PUBLIC_ENDPOINT="http://localhost:59000"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-forgeminio}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-forgeminio-dev-password}"
export S3_FORCE_PATH_STYLE="true"

export AUTH_SECRET="${AUTH_SECRET:-lifecycle-lab-secret-changeme-32bytes}"
export AUTH_URL="http://localhost:${PORT}"
export NEXT_PUBLIC_APP_URL="$AUTH_URL"
export AUTH_TRUST_HOST="true"
export ADMIN_EMAIL="${ADMIN_EMAIL:-owner@forge.local}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-forge-dev}"
export ADMIN_NAME="${ADMIN_NAME:-Forge Owner}"
export ADMIN_HANDLE="${ADMIN_HANDLE:-forge}"
export PLUGIN_JWT_SECRET="${PLUGIN_JWT_SECRET:-lifecycle-plugin-signing-key}"
export PLUGIN_JWT_ISSUER="${PLUGIN_JWT_ISSUER:-forge}"
export PLUGIN_JWT_AUDIENCE="${PLUGIN_JWT_AUDIENCE:-forge-plugins}"

# Reuse the in-process mock runtime, but keep the lab opt-in independently.
export FORGE_E2E=1
export FORGE_LIFECYCLE_LAB=1
# The lab is a frozen UX state matrix. Background dispatch/watchdog workers
# would correctly advance those states, which would make visual audits racey.
export FORGE_DISABLE_IN_PROCESS_WORKER=1
export NEXT_DIST_DIR=".next-lifecycle"

echo "[lifecycle] Ensuring isolated docker stack is up…"
docker compose -f "$COMPOSE_FILE" up -d >/dev/null

echo "[lifecycle] Waiting for Postgres…"
for i in $(seq 1 30); do
  docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U forge >/dev/null 2>&1 && break
  [[ "$i" == "30" ]] && { echo "[lifecycle] Postgres not ready" >&2; exit 1; }
  sleep 1
done

docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U forge -d forge -tAc \
  "SELECT 1 FROM pg_database WHERE datname='forge_lifecycle'" 2>/dev/null | grep -q 1 \
  || docker compose -f "$COMPOSE_FILE" exec -T postgres createdb -U forge forge_lifecycle

if [[ "$FRESH" == "1" ]]; then
  echo "[lifecycle] --fresh: recreating the lab schema…"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U forge -d forge_lifecycle -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
fi

echo "[lifecycle] Applying migrations and deterministic fixtures…"
pnpm exec prisma migrate deploy >/dev/null
pnpm exec prisma generate >/dev/null
pnpm exec tsx prisma/seed.ts >/dev/null
pnpm exec tsx scripts/seed-lifecycle-lab.ts

echo
echo "[lifecycle] Lab: http://localhost:${PORT}/w/forge/command-center"
echo "[lifecycle] Sign in: $ADMIN_EMAIL / $ADMIN_PASSWORD"
echo "[lifecycle] Data: forge_lifecycle · Redis /14 · $NEXT_DIST_DIR"
echo

if [[ "$PRODUCTION" == "1" ]]; then
  if [[ "${LIFECYCLE_FORCE_BUILD:-0}" == "1" || ! -f "$ROOT/$NEXT_DIST_DIR/BUILD_ID" ]]; then
    echo "[lifecycle] Building deterministic production bundle…"
    pnpm exec next build
  fi
  exec pnpm exec next start -p "$PORT"
fi

exec pnpm exec next dev --turbo -p "$PORT"
