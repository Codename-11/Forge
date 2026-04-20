# syntax=docker/dockerfile:1.7
# --- Multi-stage Next.js production build ---------------------------------
# deps: cacheable install layer
# build: generate Prisma client + next build (standalone output)
# runner: minimal runtime image; runs migrations on startup, then next start

FROM node:20-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ---- deps -----------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
# pnpm-lock.yaml may not exist on first build; fall back to install.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    else pnpm install --no-frozen-lockfile; fi

# ---- build ----------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm prisma generate
RUN pnpm build

# ---- runner ---------------------------------------------------------------
FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat tini
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Install Prisma CLI at a pinned version for the boot-time migrate step.
# The client + query engine travel with the standalone bundle via
# outputFileTracingIncludes; only the CLI binary is extra here.
RUN npm install -g --no-fund --no-audit prisma@6.19.3

# Standalone output + static assets + public + schema.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma

# Flatten the Prisma client: @prisma/client's default.js does
# `require(".prisma/client/default")`. With pnpm, `.prisma` lives inside
# the virtual store, which breaks the standalone bundle. Drop it at the
# top-level `node_modules/.prisma` path the client resolver expects.
COPY --from=build /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma ./node_modules/.prisma

# On boot: apply migrations, then start Next.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
