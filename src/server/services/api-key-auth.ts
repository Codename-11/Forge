import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/server/db";
import type { PluginScope } from "@prisma/client";

export class ApiKeyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Authenticate an incoming plugin/agent request from its `Authorization: Bearer <key>`.
 * Enforces revocation, expiry, and required scopes. Updates `lastUsedAt` lazily.
 *
 * Returns the resolved plugin (or user) + scopes, so callers can further gate
 * action-level authorization.
 */
export async function authenticateApiKey(
  raw: string,
  required: PluginScope[] = [],
): Promise<{
  workspaceId: string;
  pluginId: string | null;
  userId: string | null;
  scopes: PluginScope[];
  keyId: string;
}> {
  const hashed = createHash("sha256").update(raw).digest("hex");
  const key = await db.apiKey.findUnique({
    where: { hashedKey: hashed },
    include: { plugin: true },
  });
  if (!key) throw new ApiKeyError("Invalid API key.", 401);
  if (key.revokedAt) throw new ApiKeyError("API key revoked.", 401);
  if (key.expiresAt && key.expiresAt < new Date()) throw new ApiKeyError("API key expired.", 401);
  if (key.plugin && key.plugin.status !== "APPROVED")
    throw new ApiKeyError("Plugin not approved.", 403);

  for (const s of required) {
    if (!key.scopes.includes(s))
      throw new ApiKeyError(`Missing required scope: ${s}`, 403);
  }

  // Non-blocking last-used update. Batch in production via a queue.
  void db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return {
    workspaceId: key.workspaceId,
    pluginId: key.pluginId,
    userId: key.userId,
    scopes: key.scopes,
    keyId: key.id,
  };
}
