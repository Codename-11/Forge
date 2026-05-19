import "server-only";
import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis?: Redis;
  redisPub?: Redis;
  redisSub?: Redis;
};

function make() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Next.js imports server modules while collecting page data during builds.
    // Connect on first real Redis command so static analysis/build workers do
    // not try to dial localhost Redis inside the Docker build container.
    lazyConnect: true,
  });
}

export const redis = globalForRedis.redis ?? make();
export const redisPub = globalForRedis.redisPub ?? make();
export const redisSub = globalForRedis.redisSub ?? make();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
  globalForRedis.redisPub = redisPub;
  globalForRedis.redisSub = redisSub;
}
