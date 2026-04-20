#!/bin/sh
set -e

# Wait briefly for DB before migrating. `pg_isready` isn't in the slim
# runtime, so just let `prisma migrate deploy` retry the connection.
echo "[forge] running prisma migrate deploy…"
prisma migrate deploy --schema=prisma/schema.prisma || {
  echo "[forge] migration failed; continuing so you can inspect logs"
}

# Seeding is skipped in the production image — the Authelia bridge
# auto-provisions a workspace for each SSO user on first login. Seed from
# the host with `docker compose exec forge prisma db seed` if you want
# sample data.

echo "[forge] starting Next.js on :${PORT}"
exec node server.js
