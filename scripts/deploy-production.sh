#!/usr/bin/env bash
set -euo pipefail

# Serialize and deploy an exact main commit/tag from a dedicated clean clone.
# Usage: scripts/deploy-production.sh v0.20.0

REF=${1:?"usage: scripts/deploy-production.sh <tag-or-main-sha>"}
SOURCE_PATH=${FORGE_SOURCE_PATH:-/home/bailey/deploy/forge-prod}
COMPOSE_PATH=${FORGE_COMPOSE_PATH:-/home/bailey/docker/forge}
LOCK_PATH=${FORGE_DEPLOY_LOCK:-/tmp/forge-production-deploy.lock}
PUBLIC_URL=${FORGE_PUBLIC_URL:-https://forge.axiom-labs.dev}

exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "Another Forge production deployment holds $LOCK_PATH." >&2
  exit 1
fi

if [[ ! -d "$SOURCE_PATH/.git" ]]; then
  echo "Dedicated deployment clone not found at $SOURCE_PATH." >&2
  echo "Create it with: git clone https://github.com/Codename-11/Forge.git $SOURCE_PATH" >&2
  exit 1
fi

if [[ -n "$(git -C "$SOURCE_PATH" status --porcelain)" ]]; then
  echo "Deployment checkout is dirty; refusing to overwrite it." >&2
  exit 1
fi

git -C "$SOURCE_PATH" fetch --prune origin main --tags
TARGET=$(git -C "$SOURCE_PATH" rev-parse "${REF}^{commit}")
if ! git -C "$SOURCE_PATH" merge-base --is-ancestor "$TARGET" origin/main; then
  echo "$REF ($TARGET) is not contained in origin/main." >&2
  exit 1
fi

git -C "$SOURCE_PATH" checkout --detach "$TARGET"

if [[ "$REF" == v* ]]; then
  PACKAGE_VERSION=$(node -p "require('$SOURCE_PATH/package.json').version")
  if [[ "v$PACKAGE_VERSION" != "$REF" ]]; then
    echo "Tag $REF does not match package version v$PACKAGE_VERSION." >&2
    exit 1
  fi
fi

SHORT_SHA=$(git -C "$SOURCE_PATH" rev-parse --short HEAD)
BUILD_TIME=$(date -u +%FT%TZ)

cd "$COMPOSE_PATH"
FORGE_SOURCE_PATH="$SOURCE_PATH" GIT_SHA="$SHORT_SHA" BUILD_TIME="$BUILD_TIME" \
  docker compose build forge forge-worker
FORGE_SOURCE_PATH="$SOURCE_PATH" GIT_SHA="$SHORT_SHA" BUILD_TIME="$BUILD_TIME" \
  docker compose up -d

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error "$PUBLIC_URL/signin" >/dev/null; then
    echo "Forge $REF deployed at $SHORT_SHA ($BUILD_TIME)."
    exit 0
  fi
  sleep 2
done

echo "Deployment started but $PUBLIC_URL/signin did not become healthy within 60 seconds." >&2
docker compose ps >&2
docker compose logs --tail=100 forge forge-worker >&2
exit 1
