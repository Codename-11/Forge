import "server-only";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { db } from "@/server/db";
import { ApiKeyKind, PluginScope, type Role } from "@prisma/client";

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
  /** Populated by authenticateApiKey; optional only for legacy internal test contexts. */
  kind?: ApiKeyKind;
  principalType?: "USER" | "AGENT" | "PLUGIN";
  userId: string | null;
  /** Current workspace role for user principals; service principals do not inherit issuer roles. */
  membershipId?: string | null;
  membershipRole?: Role | null;
  pluginId: string | null;
  scopes: PluginScope[];
  projectIds: string[];
  labelIds: string[];
  initiativeIds: string[];
  /**
   * If set, this key acts as a specific agent. MCP tools that take an
   * optional `profileKey` (e.g. `issues.assigned`) infer the agent from
   * this column when the caller omits an explicit handle.
   */
  linkedAgentId: string | null;
}

export type NarrowEntity = "issue" | "project" | "initiative";

export function hasApiKeyNarrowing(ctx: { apiKey?: ApiKeyContext | null }): boolean {
  const key = ctx.apiKey;
  return Boolean(key && (key.projectIds.length || key.labelIds.length || key.initiativeIds.length));
}

function userProjectAccessWhere(key: ApiKeyContext): Record<string, unknown> | null {
  if (key.principalType !== "USER") return null;
  if (!key.membershipId || !key.membershipRole) return { id: "__user_membership_denied__" };
  if (key.membershipRole === "OWNER" || key.membershipRole === "ADMIN") return null;
  const explicit = {
    accessGrants: {
      some: {
        membershipId: key.membershipId,
        role: { in: ["VIEWER", "CONTRIBUTOR", "MANAGER"] },
      },
    },
  };
  return key.membershipRole === "MEMBER"
    ? { OR: [{ visibility: "WORKSPACE" }, explicit] }
    : explicit;
}

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
    include: {
      plugin: true,
      user: {
        select: {
          status: true,
          disabledAt: true,
          deletedAt: true,
          memberships: {
            select: { id: true, workspaceId: true, role: true },
          },
        },
      },
    },
  });
  if (!key) throw new ApiKeyError("Invalid API key.", 401);
  if (key.revokedAt) throw new ApiKeyError("API key revoked.", 401);
  if (key.expiresAt && key.expiresAt < new Date()) throw new ApiKeyError("API key expired.", 401);
  if (key.plugin && key.plugin.status !== "APPROVED")
    throw new ApiKeyError("Plugin not approved.", 403);

  const principalType: ApiKeyContext["principalType"] = key.pluginId
    ? "PLUGIN"
    : key.kind === ApiKeyKind.PERSONAL || key.kind === ApiKeyKind.SESSION
      ? "USER"
      : "AGENT";
  let membershipRole: Role | null = null;
  let membershipId: string | null = null;
  if (principalType === "USER") {
    // PERSONAL and SESSION credentials are alternate sessions for a human,
    // not durable service principals. Re-resolve their account and workspace
    // authority on every request so suspension, deletion, and membership
    // changes take effect immediately.
    if (!key.userId || key.pluginId || key.linkedAgentId) {
      throw new ApiKeyError("Invalid user API key.", 401);
    }
    if (!key.user || key.user.status !== "ACTIVE" || key.user.disabledAt || key.user.deletedAt) {
      throw new ApiKeyError("API key owner is not active.", 403);
    }
    const membership = key.user.memberships.find(
      (candidate) => candidate.workspaceId === key.workspaceId,
    );
    membershipId = membership?.id ?? null;
    membershipRole = membership?.role ?? null;
    if (!membershipRole) {
      throw new ApiKeyError("API key owner is not a workspace member.", 403);
    }
  }

  // ADMIN on a user key is only a requested ceiling. A later role demotion
  // removes it from the effective request context without changing the
  // durable key metadata. AGENT and PLUGIN keys retain service-principal
  // semantics and continue to be governed by their stored scopes.
  const scopes =
    principalType === "USER" && membershipRole !== "OWNER" && membershipRole !== "ADMIN"
      ? key.scopes.filter((scope) => scope !== PluginScope.ADMIN)
      : key.scopes;

  for (const s of required) {
    if (!scopes.includes(s)) throw new ApiKeyError(`Missing required scope: ${s}`, 403);
  }

  // Non-blocking last-used update. Batch in production via a queue.
  void db.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    keyId: key.id,
    workspaceId: key.workspaceId,
    kind: key.kind,
    principalType,
    pluginId: key.pluginId,
    userId: key.userId,
    membershipId,
    membershipRole,
    scopes,
    projectIds: key.projectIds,
    labelIds: key.labelIds,
    initiativeIds: key.initiativeIds,
    linkedAgentId: key.linkedAgentId,
  };
}

/**
 * Enforce that the caller's API key (if any) permits access to a specific
 * resource id. No-op when the call was session-authed (no apiKey on ctx)
 * or when the key hasn't narrowed that entity type.
 *
 * For `issue` narrowing, we check project + label + initiative lists — an
 * issue qualifies if its project is directly allowed, its project belongs to
 * an allowed initiative, OR any label is allowed. This matches the "agent
 * only sees their lane" intuition without forcing every narrowing dimension
 * to match together.
 */
export async function assertKeyScope(
  ctx: { apiKey?: ApiKeyContext | null; db: typeof db },
  opts: { entity: NarrowEntity; id: string },
): Promise<void> {
  const key = ctx.apiKey;
  if (!key) return;
  switch (opts.entity) {
    case "project": {
      const scope = buildKeyScopeWhere(ctx, "project");
      if (!Object.keys(scope).length) return;
      const project = await ctx.db.project.findFirst({
        where: { id: opts.id, workspaceId: key.workspaceId, deletedAt: null, ...scope },
        select: { id: true },
      });
      if (!project) {
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
      const scope = buildKeyScopeWhere(ctx, "issue");
      if (!Object.keys(scope).length) return;
      const issue = await ctx.db.issue.findFirst({
        where: { id: opts.id, workspaceId: key.workspaceId, deletedAt: null, ...scope },
        select: { id: true },
      });
      if (!issue) {
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
      const clauses: Record<string, unknown>[] = [];
      if (key.projectIds.length) clauses.push({ id: { in: key.projectIds } });
      const userAccess = userProjectAccessWhere(key);
      if (userAccess) clauses.push(userAccess);
      if (!clauses.length) return {};
      return clauses.length === 1 ? clauses[0]! : { AND: clauses };
    }
    case "initiative": {
      if (!key.initiativeIds.length) return {};
      return { id: { in: key.initiativeIds } };
    }
    case "issue": {
      const keyClauses: Record<string, unknown>[] = [];
      if (key.projectIds.length) {
        keyClauses.push({ projectId: { in: key.projectIds } });
      }
      if (key.labelIds.length) {
        keyClauses.push({ labels: { some: { labelId: { in: key.labelIds } } } });
      }
      if (key.initiativeIds.length) {
        keyClauses.push({ project: { initiativeId: { in: key.initiativeIds } } });
      }
      const clauses: Record<string, unknown>[] = [];
      if (keyClauses.length)
        clauses.push(keyClauses.length === 1 ? keyClauses[0]! : { OR: keyClauses });
      const userProjectAccess = userProjectAccessWhere(key);
      if (key.principalType === "USER") {
        const canUseUnfiled =
          key.membershipRole === "OWNER" ||
          key.membershipRole === "ADMIN" ||
          key.membershipRole === "MEMBER";
        clauses.push({
          OR: [
            ...(canUseUnfiled ? [{ projectId: null }] : []),
            ...(userProjectAccess ? [{ project: userProjectAccess }] : [{ project: {} }]),
          ],
        });
      }
      if (!clauses.length) return {};
      return clauses.length === 1 ? clauses[0]! : { AND: clauses };
    }
  }
}

/**
 * Artifact scope follows its owning work. A narrowed key may see an artifact
 * through a permitted issue, a directly permitted project, or a project in a
 * permitted initiative. Standalone artifacts are intentionally invisible to
 * narrowed keys because they have no lane from which authority can be derived.
 */
export function buildArtifactKeyScopeWhere(ctx: {
  apiKey?: ApiKeyContext | null;
}): Record<string, unknown> {
  if (!hasApiKeyNarrowing(ctx)) return {};
  const key = ctx.apiKey!;
  const clauses: Record<string, unknown>[] = [];
  const issueWhere = buildKeyScopeWhere(ctx, "issue");
  if (Object.keys(issueWhere).length) clauses.push({ issue: { is: issueWhere } });
  if (key.principalType === "USER") {
    const projectWhere = buildKeyScopeWhere(ctx, "project");
    if (Object.keys(projectWhere).length) clauses.push({ project: { is: projectWhere } });
  }
  if (key.projectIds.length) clauses.push({ projectId: { in: key.projectIds } });
  if (key.initiativeIds.length) {
    clauses.push({ project: { is: { initiativeId: { in: key.initiativeIds } } } });
  }
  // A narrowed key always has at least one issue-derived clause. Keeping the
  // impossible fallback makes the deny-by-default behavior explicit.
  return clauses.length ? { OR: clauses } : { id: "__artifact_scope_denied__" };
}

export async function assertArtifactKeyScope(
  ctx: { apiKey?: ApiKeyContext | null; db: typeof db },
  opts: { artifactId: string; workspaceId: string },
): Promise<void> {
  if (!hasApiKeyNarrowing(ctx)) return;
  const artifact = await ctx.db.artifact.findFirst({
    where: {
      id: opts.artifactId,
      workspaceId: opts.workspaceId,
      ...buildArtifactKeyScopeWhere(ctx),
    },
    select: { id: true },
  });
  if (!artifact) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API key scope does not include this artifact.",
    });
  }
}
