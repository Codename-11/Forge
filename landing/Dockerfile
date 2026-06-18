# Forge landing site deploy image.
#
# Coolify's `static` build pack only copies an existing directory into nginx; it
# does not run this app's docs + Next static export build. Use this Dockerfile
# build pack instead.

FROM node:22-alpine AS builder

ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_PUBLIC_SITE_URL=https://forge-pm.dev

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Install docs dependencies first so this layer is cached unless docs deps move.
COPY docs/package.json docs/pnpm-lock.yaml ./docs/
RUN pnpm --dir docs --ignore-workspace install --frozen-lockfile \
  || pnpm --dir docs --ignore-workspace install

# Install landing dependencies independently from the main Forge app workspace.
COPY landing/package.json landing/pnpm-lock.yaml ./landing/
RUN pnpm --dir landing --ignore-workspace install --frozen-lockfile

# Build needs the docs source plus the repo changelog/package metadata parsed by
# landing/lib/releases.ts.
COPY docs ./docs
COPY CHANGELOG.md package.json ./
COPY landing ./landing

RUN pnpm --dir landing --ignore-workspace build

FROM nginx:alpine AS runtime

COPY landing/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/landing/out/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
