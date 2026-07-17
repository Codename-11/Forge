#!/usr/bin/env bash
# Playwright webServer for E2E — a Next dev server against a DEDICATED,
# disposable database (`forge_e2e`) on the isolated docker stack, fully
# separate from both prod (dev:live) and the shared dev:local data. Boots the
# stack if needed, migrates + seeds (idempotent, with FORGE_E2E fixtures), then
# runs the server. Nothing here can touch production.
#
#   pnpm e2e            # provisions + runs Playwright (spawns this)
#   bash scripts/e2e-web.sh   # just the server (manual)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"
PORT="${E2E_PORT:-3200}"

# ---- Dedicated, isolated E2E environment ----------------------------------
# All overridable so CI (GitHub service containers) can point at its own
# Postgres/Redis without the local docker-compose stack. `:-` = default only
# when unset. E2E_MANAGE_STACK=0 (set in CI) skips docker compose + createdb.
E2E_MANAGE_STACK="${E2E_MANAGE_STACK:-1}"
if [[ "$E2E_MANAGE_STACK" == "1" ]]; then
  # Local E2E must never inherit the developer database from the invoking shell.
  export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://forge:forge@localhost:55432/forge_e2e?schema=public}"
  export REDIS_URL="${E2E_REDIS_URL:-redis://localhost:56379/15}"
else
  # CI supplies isolated service-container endpoints explicitly.
  export DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required when E2E_MANAGE_STACK=0}"
  export REDIS_URL="${REDIS_URL:?REDIS_URL is required when E2E_MANAGE_STACK=0}"
fi
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:59000}"
export S3_PUBLIC_ENDPOINT="${S3_PUBLIC_ENDPOINT:-http://localhost:59000}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-forgeminio}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-forgeminio-dev-password}"
export S3_FORCE_PATH_STYLE="true"

export AUTH_SECRET="${AUTH_SECRET:-e2e-secret-changeme-0000000000000000}"
export AUTH_URL="http://localhost:${PORT}"
export NEXT_PUBLIC_APP_URL="$AUTH_URL"
export AUTH_TRUST_HOST="true"
export ADMIN_EMAIL="${ADMIN_EMAIL:-owner@forge.local}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-forge-dev}"
export ADMIN_NAME="${ADMIN_NAME:-Forge Owner}"
export ADMIN_HANDLE="${ADMIN_HANDLE:-forge}"

export PLUGIN_JWT_SECRET="${PLUGIN_JWT_SECRET:-e2e-plugin-signing-key}"
export PLUGIN_JWT_ISSUER="${PLUGIN_JWT_ISSUER:-forge}"
export PLUGIN_JWT_AUDIENCE="${PLUGIN_JWT_AUDIENCE:-forge-plugins}"

# Flips the mock-runs connector + the seed's E2E fixtures on.
export FORGE_E2E=1
# Dedicated build dir so a parallel `next dev` on the same checkout can't
# corrupt our .next (avoids MODULE_NOT_FOUND worker-chunk flakiness).
export NEXT_DIST_DIR=".next-e2e"

# ---- Provision -------------------------------------------------------------
if [[ "$E2E_MANAGE_STACK" == "1" ]]; then
  echo "[e2e] Ensuring isolated docker stack is up…"
  docker compose -f "$COMPOSE_FILE" up -d >/dev/null

  echo "[e2e] Waiting for Postgres…"
  for i in $(seq 1 30); do
    docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U forge >/dev/null 2>&1 && break
    [[ "$i" == "30" ]] && { echo "[e2e] Postgres not ready" >&2; exit 1; }
    sleep 1
  done

  if [[ "${E2E_RESET_DB:-0}" == "1" ]]; then
    if [[ "$DATABASE_URL" != *"/forge_e2e"* ]]; then
      echo "[e2e] Refusing reset: DATABASE_URL is not the dedicated forge_e2e database." >&2
      exit 1
    fi
    echo "[e2e] Resetting dedicated forge_e2e database…"
    docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U forge -d forge -v ON_ERROR_STOP=1 -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'forge_e2e' AND pid <> pg_backend_pid();" >/dev/null
    docker compose -f "$COMPOSE_FILE" exec -T postgres dropdb -U forge --if-exists forge_e2e
    docker compose -f "$COMPOSE_FILE" exec -T postgres createdb -U forge forge_e2e
  fi

  # Dedicated DB — create if missing (separate from the shared `forge` DB).
  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U forge -d forge -tAc \
    "SELECT 1 FROM pg_database WHERE datname='forge_e2e'" 2>/dev/null | grep -q 1 \
    || docker compose -f "$COMPOSE_FILE" exec -T postgres createdb -U forge forge_e2e
else
  echo "[e2e] E2E_MANAGE_STACK=0 — using externally-provided DB/Redis (CI)."
fi

echo "[e2e] Applying migrations + seeding (idempotent)…"
pnpm exec prisma migrate deploy >/dev/null
pnpm exec prisma generate >/dev/null
pnpm exec tsx prisma/seed.ts
if [[ "${FORGE_SCENARIOS:-0}" == "1" ]]; then
  pnpm exec tsx scripts/seed-scenarios.ts --scenarios "${FORGE_SCENARIO_NAMES:-all}" --scale "${FORGE_SCENARIO_SCALE:-1}"
fi

# Production build → `next start` (NOT `next dev`): no on-demand compilation, so
# the server doesn't stall under parallel workers — the source of E2E flakiness.
# Rebuild only when missing or forced (E2E_FORCE_BUILD=1, set by `pnpm e2e`).
if [[ "${E2E_FORCE_BUILD:-0}" == "1" || ! -f "$ROOT/$NEXT_DIST_DIR/BUILD_ID" ]]; then
  echo "[e2e] Building production bundle (NEXT_DIST_DIR=$NEXT_DIST_DIR)…"
  pnpm exec next build
else
  echo "[e2e] Reusing existing $NEXT_DIST_DIR build (E2E_FORCE_BUILD=1 to rebuild)."
fi

echo "[e2e] Starting Next (production) on :${PORT} (DB forge_e2e, FORGE_E2E=1)…"
exec pnpm exec next start -p "$PORT"
