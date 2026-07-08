import "server-only";
import { ApiKeyKind } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

/**
 * Purge SESSION keys past their TTL.
 *
 * SESSION keys are the ephemeral kind (`access.createSession`, TTL-bounded) and
 * are documented as "auto-purged when expired". Key expiry is otherwise only
 * enforced lazily at auth (`api-key-auth.ts` rejects a request bearing an
 * expired key but never removes the row), so without this sweep expired SESSION
 * rows accumulate in the DB and linger as "expired" in the Clients UI forever.
 *
 * Scoped to SESSION only — PERSONAL/AGENT keys with an explicit expiry are left
 * for an admin to remove deliberately, matching the "permanent until revoked"
 * intent of those kinds. Deleting an ApiKey is safe: nothing holds an FK to it
 * (its own relations to workspace/user/plugin/agent are outbound).
 */
export async function purgeExpiredSessionKeys(
  now: Date = new Date(),
): Promise<{ purged: number }> {
  const res = await db.apiKey.deleteMany({
    where: { kind: ApiKeyKind.SESSION, expiresAt: { lt: now } },
  });
  if (res.count > 0) {
    logger.info({ purged: res.count }, "expired-key-purge: removed expired SESSION keys");
  }
  return { purged: res.count };
}
