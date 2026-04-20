import "server-only";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
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
 * Structured context attached to tRPC requests that come in via an API key.
 * Populated by the API key auth middleware; absent for session-authenticated
 * calls.
 */
export interface ApiKeyContext {
  keyId: string;
  workspaceId: string;
  userId: string | null;
  pluginId: string | null;
  scopes: PluginScope[];
  projectIds: string[];
  labelIds: string[];
  initiativeIds: string[];
}

export type NarrowEntity = "issue" | "project" | "initiative";

/**
 * Authenticate an incoming plugin/agent request from its `Authorization: Bearer <key>`.
 * Enforces revocation, expiry, and required scopes. Updates `lastUsedAt` lazily.
 *
 * Returns the resolved plugin (or user) + scopes + narrowing arrays, so
 * callers can further gate action-level authorization.
 */
export async function authenticateApiKey(
  raw: string,
  required: PluginScope[] = [],
): Promise<ApiKeyContext> {
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
    keyId: key.id,
    workspaceId: key.workspaceId,
    pluginId: key.pluginId,
    userId: key.userId,
    scopes: key.scopes,
    projectIds: key.projectIds,
    labelIds: key.labelIds,
    initiativeIds: key.initiativeIds,
  };
}

/**
 * Enforce that the caller's API key (if any) permits access to a specific
 * resource id. No-op when the call was session-authed (no apiKey on ctx)
 * or when the key hasn't narrowed that entity type.
 *
 * For `issue` narrowing, we check both project + label lists — an issue
 * qualifies if its `projectId` is in `projectIds` OR any of its labels is
 * in `labelIds`. This matches the "agent only sees their lane" intuition
 * without forcing label *and* project narrowing together.
 */
export async function assertKeyScope(
  ctx: { apiKey?: ApiKeyContext | null; db: typeof db },
  opts: { entity: NarrowEntity; id: string },
): Promise<void> {
  const key = ctx.apiKey;
  if (!key) return;
  switch (opts.entity) {
    case "project": {
      if (!key.projectIds.length) return;
      if (!key.projectIds.includes(opts.id)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "API key scope does not include this resource.",
        });
      }
      return;
    }
    case "initiative": {
      if (!key.initiativeIds.length) return;
      if (!key.initiativeIds.includes(opts.id)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "API key scope does not include this resource.",
        });
      }
      return;
    }
    case "issue": {
      const hasProject = key.projectIds.length > 0;
      const hasLabel = key.labelIds.length > 0;
      if (!hasProject && !hasLabel) return;
      const issue = await ctx.db.issue.findUnique({
        where: { id: opts.id },
        select: {
          projectId: true,
          labels: { select: { labelId: true } },
        },
      });
      if (!issue) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const projectOk =
        hasProject && issue.projectId
          ? key.projectIds.includes(issue.projectId)
          : false;
      const labelOk =
        hasLabel && issue.labels.some((l) => key.labelIds.includes(l.labelId));
      if (!projectOk && !labelOk) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "API key scope does not include this resource.",
        });
      }
      return;
    }
  }
}

/**
 * Return a Prisma `where` fragment that narrows a list query to the
 * resources an API key is scoped to. Merge into existing `where` via
 * spread / `AND`. Returns an empty object when there's no active narrowing.
 */
export function buildKeyScopeWhere(
  ctx: { apiKey?: ApiKeyContext | null },
  entity: NarrowEntity,
): Record<string, unknown> {
  const key = ctx.apiKey;
  if (!key) return {};
  switch (entity) {
    case "project": {
      if (!key.projectIds.length) return {};
      return { id: { in: key.projectIds } };
    }
    case "initiative": {
      if (!key.initiativeIds.length) return {};
      return { id: { in: key.initiativeIds } };
    }
    case "issue": {
      const clauses: Record<string, unknown>[] = [];
      if (key.projectIds.length) {
        clauses.push({ projectId: { in: key.projectIds } });
      }
      if (key.labelIds.length) {
        clauses.push({ labels: { some: { labelId: { in: key.labelIds } } } });
      }
      if (!clauses.length) return {};
      return clauses.length === 1 ? clauses[0] : { OR: clauses };
    }
  }
}
