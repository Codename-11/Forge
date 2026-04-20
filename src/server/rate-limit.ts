import "server-only";
import { redis } from "@/server/redis";

/**
 * Fixed-window rate limiter backed by Redis INCR + EXPIRE.
 *
 * Semantics:
 *   key:       logical identifier (e.g. `plugin:<id>:invoke`, `ip:1.2.3.4:signin`)
 *   limit:     max events per window
 *   windowSec: window length in seconds
 *
 * Returns `{ ok, remaining, resetAt }`. When `ok === false`, the caller
 * should return a 429 (API) or throw TRPCError (tRPC).
 *
 * This intentionally uses fixed windows — simple and O(1). For hot paths
 * needing burst smoothing, swap in a token bucket backed by Redis scripts.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ ok: boolean; remaining: number; resetAt: number }> {
  const redisKey = `rl:${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, windowSec);
  const ttl = await redis.ttl(redisKey);
  const resetAt = Date.now() + (ttl > 0 ? ttl * 1000 : windowSec * 1000);
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt };
}
