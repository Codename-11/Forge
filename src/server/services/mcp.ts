import "server-only";
import { z } from "zod";
import { CycleStatus, InitiativeStatus, RelationKind } from "@prisma/client";
import { db } from "@/server/db";
import {
  assertKeyScope,
  buildKeyScopeWhere,
  type ApiKeyContext,
} from "@/server/services/api-key-auth";
import {
  ALLOWED_MIME_TYPES,
  ALLOWED_TARGET_TYPES,
  MAX_FILE_SIZE_BYTES,
  deleteAttachment,
  finalizeAttachment,
  presignDownloadUrl,
  presignUploadUrl,
} from "@/server/services/storage";

/**
 * Forge's MCP (Model Context Protocol) surface — the stable set of tools any
 * agent runtime (Claude Code, Hermes, OpenAI Agents) can call to read/write
 * Forge data.
 *
 * Each tool is auth-gated by scope. Route handlers at `/api/mcp/rpc` (real
 * MCP) and `/api/mcp/:tool` (REST alias) authenticate the API key and then
 * dispatch here. Tools honor granular `ApiKey` narrowing (projectIds,
 * labelIds, initiativeIds) so a per-initiative bot only sees its lane.
 *
 * Tools intentionally mirror the tRPC router surface without depending on
 * the routers themselves — the routers require a full session, which MCP
 * callers don't have. Where possible the zod input schemas are shared with
 * the underlying routers so validation stays consistent.
 */

// ---------------------------------------------------------------------------
// Context + helpers
// ---------------------------------------------------------------------------

export interface McpContext {
  workspaceId: string;
  userId: string | null;
  pluginId: string | null;
  /**
   * Full API key context when the caller came in via a `forge_sk_…` bearer.
   * Null for session-authenticated callers (admin UIs etc.). Carries the
   * narrowing arrays (projectIds / labelIds / initiativeIds) so tools can
   * apply `buildKeyScopeWhere` + `assertKeyScope`.
   */
  apiKey: ApiKeyContext | null;
}

/**
 * Shim to satisfy `assertKeyScope`/`buildKeyScopeWhere` which both expect a
 * tRPC-ish ctx shape (`{ apiKey, db }`). We wrap `McpContext` here so the
 * tRPC helpers work unchanged.
 */
function scopeCtx(ctx: McpContext): { apiKey: ApiKeyContext | null; db: typeof db } {
  return { apiKey: ctx.apiKey, db };
}

/**
 * Resolve the acting user id. MCP keys often belong to a plugin (no userId);
 * fall back to any workspace member so rows that require an author /
 * assignee still have a valid FK target. Matches the existing `issues.create`
 * behavior so plugins don't need a linked user.
 */
async function resolveActorId(ctx: McpContext): Promise<string> {
  if (ctx.userId) return ctx.userId;
  const m = await db.membership.findFirstOrThrow({
    where: { workspaceId: ctx.workspaceId },
    select: { userId: true },
  });
  return m.userId;
}

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

/**
 * Compute the set of issue ids in a workspace blocked by at least one
 * non-completed dependency. Mirrors the router helper in `issue.ts` so the
 * MCP `issues.claim` path can exclude blocked candidates when an agent asks
 * "what should I work on next."
 */
async function findBlockedIssueIds(workspaceId: string): Promise<Set<string>> {
  const blockers = await db.issueRelation.findMany({
    where: {
      workspaceId,
      OR: [
        {
          kind: RelationKind.BLOCKED_BY,
          fromIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
        {
          kind: RelationKind.BLOCKS,
          toIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
      ],
    },
    select: { fromIssueId: true, toIssueId: true, kind: true },
  });
  const ids = new Set<string>();
  for (const r of blockers) {
    if (r.kind === RelationKind.BLOCKED_BY) ids.add(r.toIssueId);
    if (r.kind === RelationKind.BLOCKS) ids.add(r.fromIssueId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export const mcpTools = {
  // --------------------------------------------------------------------- Issues
  "issues.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      query: z.string().max(200).optional().describe("Fulltext search on title"),
      limit: z.number().int().min(1).max(50).default(20),
      includeDone: z.boolean().default(false).describe("Include DONE/CANCELED issues"),
    }),
    async run(
      input: { query?: string; limit: number; includeDone: boolean },
      ctx: McpContext,
    ) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      return db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...keyWhere,
          ...(input.query
            ? { title: { contains: input.query, mode: "insensitive" as const } }
            : {}),
          ...(input.includeDone
            ? {}
            : { status: { category: { notIn: ["DONE", "CANCELED"] } } }),
        },
        take: input.limit,
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        include: { status: true, project: true },
      });
    },
  },

  "issues.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().describe("Issue id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });
      return db.issue.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: { status: true, project: true, assignees: { include: { user: true } } },
      });
    },
  },

  "issues.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(50_000).optional(),
      projectId: z.string().optional(),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    }),
    async run(
      input: {
        title: string;
        description?: string;
        projectId?: string;
        priority?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
      },
      ctx: McpContext,
    ) {
      if (input.projectId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: input.projectId,
        });
      }
      const status = await db.status.findFirstOrThrow({
        where: { workspaceId: ctx.workspaceId, isDefault: true },
      });
      const last = await db.issue.findFirst({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const authorId = await resolveActorId(ctx);
      return db.issue.create({
        data: {
          workspaceId: ctx.workspaceId,
          number: (last?.number ?? 0) + 1,
          title: input.title,
          description: input.description,
          projectId: input.projectId,
          statusId: status.id,
          priority: input.priority ?? "NONE",
          authorId,
        },
        include: { status: true },
      });
    },
  },

  "issues.transition": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().describe("Issue id (cuid)"),
      statusId: z.string().describe("Target status id"),
    }),
    async run(input: { id: string; statusId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });
      // Ensure workspace isolation — don't let an issue id from another ws slip through.
      const issue = await db.issue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.issue.update({
        where: { id: issue.id },
        data: { statusId: input.statusId },
      });
    },
  },

  "issues.claim": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z
        .string()
        .optional()
        .describe("Specific issue to claim; omit to auto-pick the next unblocked"),
      claimTtlMinutes: z.number().int().min(1).max(1440).default(60),
    }),
    async run(
      input: { issueId?: string; claimTtlMinutes: number },
      ctx: McpContext,
    ) {
      const agentUserId = await resolveActorId(ctx);
      const expiresAt = new Date(Date.now() + input.claimTtlMinutes * 60_000);

      if (input.issueId) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
        const issue = await db.issue.findFirstOrThrow({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
        });
        if (issue.claimedAt && issue.claimedById !== agentUserId) {
          return { claimed: null, reason: "already-claimed" as const };
        }
        const updated = await db.issue.update({
          where: { id: issue.id },
          data: {
            claimedById: agentUserId,
            claimedAt: new Date(),
            claimExpiresAt: expiresAt,
            assignees: {
              upsert: {
                where: {
                  issueId_userId: { issueId: issue.id, userId: agentUserId },
                },
                create: { userId: agentUserId },
                update: {},
              },
            },
          },
          include: { status: true, project: true },
        });
        return { claimed: updated };
      }

      // "Give me something to work on" — skip blocked issues + narrowing.
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      const blockedIds = await findBlockedIssueIds(ctx.workspaceId);
      const candidate = await db.issue.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          claimedAt: null,
          status: { category: { notIn: ["DONE", "CANCELED"] } },
          ...keyWhere,
          ...(blockedIds.size ? { id: { notIn: [...blockedIds] } } : {}),
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      if (!candidate) return { claimed: null };
      const updated = await db.issue.update({
        where: { id: candidate.id },
        data: {
          claimedById: agentUserId,
          claimedAt: new Date(),
          claimExpiresAt: expiresAt,
          assignees: {
            upsert: {
              where: {
                issueId_userId: { issueId: candidate.id, userId: agentUserId },
              },
              create: { userId: agentUserId },
              update: {},
            },
          },
        },
        include: { status: true, project: true },
      });
      return { claimed: updated };
    },
  },

  "issues.release": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string().describe("Issue id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });
      const issue = await db.issue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.issue.update({
        where: { id: issue.id },
        data: { claimedAt: null, claimedById: null, claimExpiresAt: null },
      });
    },
  },

  "issues.queue": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      includeClaimed: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async run(
      input: { includeClaimed: boolean; limit: number },
      ctx: McpContext,
    ) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      return db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          ...keyWhere,
          ...(input.includeClaimed ? {} : { claimedAt: null }),
        },
        take: input.limit,
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        include: { status: true, project: true },
      });
    },
  },

  // ------------------------------------------------------------------- Comments
  "comments.create": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      issueId: z.string(),
      body: z.string().min(1).max(50_000),
    }),
    async run(input: { issueId: string; body: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const authorId = await resolveActorId(ctx);
      return db.comment.create({
        data: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          authorId,
          body: input.body,
        },
      });
    },
  },

  // ------------------------------------------------------------------- Projects
  "projects.list": {
    scopes: ["READ_PROJECTS"] as const,
    input: z.object({ includeArchived: z.boolean().default(false) }),
    async run(input: { includeArchived: boolean }, ctx: McpContext) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "project");
      return db.project.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...keyWhere,
          ...(input.includeArchived ? {} : { archived: false }),
        },
        orderBy: { updatedAt: "desc" },
      });
    },
  },

  // -------------------------------------------------------------------- Analytics
  "analytics.summary": {
    scopes: ["READ_ANALYTICS"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      const [open, done] = await Promise.all([
        db.issue.count({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            ...keyWhere,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
        }),
        db.issue.count({
          where: {
            workspaceId: ctx.workspaceId,
            ...keyWhere,
            status: { category: "DONE" },
          },
        }),
      ]);
      return { openIssues: open, doneIssues: done };
    },
  },

  // ---------------------------------------------------------------------- Cycles
  "cycles.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z
      .object({
        status: z
          .nativeEnum(CycleStatus)
          .optional()
          .describe("Filter by CycleStatus (PLANNED/ACTIVE/COMPLETED)"),
      })
      .default({}),
    async run(input: { status?: CycleStatus }, ctx: McpContext) {
      return db.cycle.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { startsAt: "desc" },
        include: { _count: { select: { issues: true } } },
      });
    },
  },

  "cycles.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().describe("Cycle id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      return db.cycle.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          issues: {
            where: { deletedAt: null },
            include: { status: true },
            orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
          },
        },
      });
    },
  },

  "cycles.current": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      return db.cycle.findFirst({
        where: { workspaceId: ctx.workspaceId, status: CycleStatus.ACTIVE },
        orderBy: { startsAt: "desc" },
      });
    },
  },

  "cycles.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      name: z.string().min(1).max(80),
      startsAt: z.coerce.date().optional(),
      endsAt: z.coerce.date().optional(),
      lengthDays: z.number().int().min(1).max(365).optional(),
      cooldownDays: z.number().int().min(0).max(90).optional(),
    }),
    async run(
      input: {
        name: string;
        startsAt?: Date;
        endsAt?: Date;
        lengthDays?: number;
        cooldownDays?: number;
      },
      ctx: McpContext,
    ) {
      const ws = await db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { cycleLengthDays: true, cycleCooldownDays: true },
      });
      const lengthDays = input.lengthDays ?? ws.cycleLengthDays;
      const cooldownDays = input.cooldownDays ?? ws.cycleCooldownDays;
      const startsAt = input.startsAt ?? new Date();
      const endsAt = input.endsAt ?? addDays(startsAt, lengthDays);
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new Error("Cycle `endsAt` must be after `startsAt`.");
      }
      return db.cycle.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          startsAt,
          endsAt,
          lengthDays,
          cooldownDays,
        },
      });
    },
  },

  "cycles.update": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string(),
      name: z.string().min(1).max(80).optional(),
      startsAt: z.coerce.date().optional(),
      endsAt: z.coerce.date().optional(),
      status: z.nativeEnum(CycleStatus).optional(),
    }),
    async run(
      input: {
        id: string;
        name?: string;
        startsAt?: Date;
        endsAt?: Date;
        status?: CycleStatus;
      },
      ctx: McpContext,
    ) {
      const { id, ...patch } = input;
      const cycle = await db.cycle.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.cycle.update({ where: { id: cycle.id }, data: patch });
    },
  },

  "cycles.plan": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      cycleId: z.string(),
      issueIds: z.array(z.string()).min(1).max(500),
    }),
    async run(
      input: { cycleId: string; issueIds: string[] },
      ctx: McpContext,
    ) {
      const cycle = await db.cycle.findFirstOrThrow({
        where: { id: input.cycleId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      for (const id of input.issueIds) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id });
      }
      const issues = await db.issue.findMany({
        where: {
          id: { in: input.issueIds },
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (issues.length !== input.issueIds.length) {
        throw new Error("One or more issues were not found in this workspace.");
      }
      await db.issue.updateMany({
        where: { id: { in: issues.map((i) => i.id) }, workspaceId: ctx.workspaceId },
        data: { cycleId: cycle.id },
      });
      return { planned: issues.length, cycleId: cycle.id };
    },
  },

  "cycles.rollover": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ fromCycleId: z.string() }),
    async run(input: { fromCycleId: string }, ctx: McpContext) {
      return db.$transaction(async (tx) => {
        const fromCycle = await tx.cycle.findFirstOrThrow({
          where: { id: input.fromCycleId, workspaceId: ctx.workspaceId },
        });
        const unfinished = await tx.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            cycleId: fromCycle.id,
            deletedAt: null,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          select: { id: true },
        });

        let target = await tx.cycle.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            status: CycleStatus.ACTIVE,
            id: { not: fromCycle.id },
          },
          orderBy: { startsAt: "asc" },
        });
        if (!target) {
          const ws = await tx.workspace.findUniqueOrThrow({
            where: { id: ctx.workspaceId },
            select: { cycleLengthDays: true, cycleCooldownDays: true },
          });
          const startsAt = addDays(fromCycle.endsAt, ws.cycleCooldownDays);
          const endsAt = addDays(startsAt, ws.cycleLengthDays);
          target = await tx.cycle.create({
            data: {
              workspaceId: ctx.workspaceId,
              name: `${fromCycle.name} (rollover)`,
              startsAt,
              endsAt,
              lengthDays: ws.cycleLengthDays,
              cooldownDays: ws.cycleCooldownDays,
              status: CycleStatus.ACTIVE,
            },
          });
        }
        if (unfinished.length) {
          await tx.issue.updateMany({
            where: { id: { in: unfinished.map((i) => i.id) }, workspaceId: ctx.workspaceId },
            data: { cycleId: target.id },
          });
        }
        return { rolled: unfinished.length, targetCycleId: target.id };
      });
    },
  },

  // ----------------------------------------------------------------- Initiatives
  "initiatives.list": {
    scopes: ["READ_PROJECTS"] as const,
    input: z
      .object({
        status: z
          .nativeEnum(InitiativeStatus)
          .optional()
          .describe("Filter by InitiativeStatus"),
      })
      .default({}),
    async run(input: { status?: InitiativeStatus }, ctx: McpContext) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "initiative");
      return db.initiative.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...keyWhere,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        include: { _count: { select: { projects: true } } },
      });
    },
  },

  "initiatives.get": {
    scopes: ["READ_PROJECTS"] as const,
    input: z.object({ id: z.string().describe("Initiative id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "initiative", id: input.id });
      return db.initiative.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          projects: {
            where: { deletedAt: null },
            orderBy: { updatedAt: "desc" },
          },
        },
      });
    },
  },

  "initiatives.create": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      name: z.string().min(1).max(120),
      slug: z
        .string()
        .min(2)
        .max(48)
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      description: z.string().max(10_000).optional(),
      targetDate: z.coerce.date().optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    }),
    async run(
      input: {
        name: string;
        slug?: string;
        description?: string;
        targetDate?: Date;
        color?: string;
      },
      ctx: McpContext,
    ) {
      const slugSource = (input.slug ?? input.name)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "initiative";
      const createdById = await resolveActorId(ctx);
      const last = await db.initiative.findFirst({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      return db.initiative.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          slug: slugSource,
          description: input.description,
          targetDate: input.targetDate,
          color: input.color,
          position: (last?.position ?? -1) + 1,
          createdById,
        },
      });
    },
  },

  "initiatives.update": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      id: z.string(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(10_000).nullable().optional(),
      targetDate: z.coerce.date().nullable().optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional(),
      status: z.nativeEnum(InitiativeStatus).optional(),
    }),
    async run(
      input: {
        id: string;
        name?: string;
        description?: string | null;
        targetDate?: Date | null;
        color?: string | null;
        status?: InitiativeStatus;
      },
      ctx: McpContext,
    ) {
      const { id, ...patch } = input;
      await assertKeyScope(scopeCtx(ctx), { entity: "initiative", id });
      const initiative = await db.initiative.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.initiative.update({ where: { id: initiative.id }, data: patch });
    },
  },

  "initiatives.linkProject": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      initiativeId: z.string(),
      projectId: z.string(),
    }),
    async run(
      input: { initiativeId: string; projectId: string },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), {
        entity: "initiative",
        id: input.initiativeId,
      });
      await assertKeyScope(scopeCtx(ctx), {
        entity: "project",
        id: input.projectId,
      });
      const initiative = await db.initiative.findFirstOrThrow({
        where: { id: input.initiativeId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      const project = await db.project.findFirstOrThrow({
        where: { id: input.projectId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.project.update({
        where: { id: project.id },
        data: { initiativeId: initiative.id },
      });
    },
  },

  "initiatives.unlinkProject": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({ projectId: z.string() }),
    async run(input: { projectId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), {
        entity: "project",
        id: input.projectId,
      });
      const project = await db.project.findFirstOrThrow({
        where: { id: input.projectId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.project.update({
        where: { id: project.id },
        data: { initiativeId: null },
      });
    },
  },

  // ------------------------------------------------------------------- Relations
  "relations.add": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      fromIssueId: z.string(),
      toIssueId: z.string(),
      kind: z.nativeEnum(RelationKind),
    }),
    async run(
      input: { fromIssueId: string; toIssueId: string; kind: RelationKind },
      ctx: McpContext,
    ) {
      if (input.fromIssueId === input.toIssueId) {
        throw new Error("Cannot relate an issue to itself.");
      }
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.fromIssueId });
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.toIssueId });

      return db.$transaction(async (tx) => {
        const [from, to] = await Promise.all([
          tx.issue.findFirst({
            where: {
              id: input.fromIssueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
            select: { id: true },
          }),
          tx.issue.findFirst({
            where: {
              id: input.toIssueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
            select: { id: true },
          }),
        ]);
        if (!from || !to) {
          throw new Error("Both issues must belong to this workspace.");
        }
        const primary = await tx.issueRelation.upsert({
          where: {
            fromIssueId_toIssueId_kind: {
              fromIssueId: input.fromIssueId,
              toIssueId: input.toIssueId,
              kind: input.kind,
            },
          },
          create: {
            workspaceId: ctx.workspaceId,
            fromIssueId: input.fromIssueId,
            toIssueId: input.toIssueId,
            kind: input.kind,
          },
          update: {},
        });
        const mirror =
          input.kind === RelationKind.BLOCKS
            ? RelationKind.BLOCKED_BY
            : input.kind === RelationKind.BLOCKED_BY
              ? RelationKind.BLOCKS
              : null;
        let reciprocal: typeof primary | null = null;
        if (mirror) {
          reciprocal = await tx.issueRelation.upsert({
            where: {
              fromIssueId_toIssueId_kind: {
                fromIssueId: input.toIssueId,
                toIssueId: input.fromIssueId,
                kind: mirror,
              },
            },
            create: {
              workspaceId: ctx.workspaceId,
              fromIssueId: input.toIssueId,
              toIssueId: input.fromIssueId,
              kind: mirror,
            },
            update: {},
          });
        }
        return { relation: primary, reciprocal };
      });
    },
  },

  "relations.remove": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ relationId: z.string() }),
    async run(input: { relationId: string }, ctx: McpContext) {
      return db.$transaction(async (tx) => {
        const relation = await tx.issueRelation.findFirst({
          where: { id: input.relationId, workspaceId: ctx.workspaceId },
        });
        if (!relation) throw new Error("Relation not found.");
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: relation.fromIssueId,
        });
        await tx.issueRelation.delete({ where: { id: relation.id } });
        const mirror =
          relation.kind === RelationKind.BLOCKS
            ? RelationKind.BLOCKED_BY
            : relation.kind === RelationKind.BLOCKED_BY
              ? RelationKind.BLOCKS
              : null;
        if (mirror) {
          await tx.issueRelation.deleteMany({
            where: {
              workspaceId: ctx.workspaceId,
              fromIssueId: relation.toIssueId,
              toIssueId: relation.fromIssueId,
              kind: mirror,
            },
          });
        }
        return { ok: true };
      });
    },
  },

  "relations.listForIssue": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ issueId: z.string() }),
    async run(input: { issueId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const issue = await db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!issue) throw new Error("Issue not found.");
      return db.issueRelation.findMany({
        where: { workspaceId: ctx.workspaceId, fromIssueId: input.issueId },
        include: {
          toIssue: {
            select: {
              id: true,
              number: true,
              title: true,
              statusId: true,
              status: { select: { category: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });
    },
  },

  // ------------------------------------------------------------------- Time
  "time.start": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().optional(),
      description: z.string().max(1000).optional(),
      billable: z.boolean().default(false),
      hourlyRate: z.number().min(0).max(10_000).optional(),
    }),
    async run(
      input: {
        issueId?: string;
        description?: string;
        billable: boolean;
        hourlyRate?: number;
      },
      ctx: McpContext,
    ) {
      const userId = await resolveActorId(ctx);
      return db.$transaction(async (tx) => {
        const running = await tx.timeEntry.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            userId,
            endedAt: null,
          },
        });
        if (running) {
          throw new Error(
            "A time entry is already running. Stop it before starting a new one.",
          );
        }
        if (input.issueId) {
          await assertKeyScope(scopeCtx(ctx), {
            entity: "issue",
            id: input.issueId,
          });
          const issue = await tx.issue.findFirst({
            where: {
              id: input.issueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
            select: { id: true },
          });
          if (!issue) throw new Error("Issue not found in workspace.");
        }
        return tx.timeEntry.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId,
            issueId: input.issueId,
            description: input.description,
            startedAt: new Date(),
            billable: input.billable,
            hourlyRate: input.hourlyRate,
          },
        });
      });
    },
  },

  "time.stop": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ entryId: z.string() }),
    async run(input: { entryId: string }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const entry = await db.timeEntry.findFirst({
        where: {
          id: input.entryId,
          workspaceId: ctx.workspaceId,
          userId,
        },
      });
      if (!entry) throw new Error("Time entry not found.");
      if (entry.endedAt) throw new Error("Entry is already stopped.");
      return db.timeEntry.update({
        where: { id: entry.id },
        data: { endedAt: new Date() },
      });
    },
  },

  "time.running": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      return db.timeEntry.findFirst({
        where: { workspaceId: ctx.workspaceId, userId, endedAt: null },
        include: {
          issue: {
            select: { id: true, number: true, title: true, projectId: true },
          },
        },
      });
    },
  },

  "time.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      userId: z.string().optional(),
      issueId: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      billable: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    async run(
      input: {
        userId?: string;
        issueId?: string;
        from?: Date;
        to?: Date;
        billable?: boolean;
        limit: number;
      },
      ctx: McpContext,
    ) {
      const userId = input.userId ?? (await resolveActorId(ctx));
      return db.timeEntry.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId,
          ...(input.issueId ? { issueId: input.issueId } : {}),
          ...(input.billable !== undefined ? { billable: input.billable } : {}),
          ...(input.from || input.to
            ? {
                startedAt: {
                  ...(input.from ? { gte: input.from } : {}),
                  ...(input.to ? { lte: input.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { startedAt: "desc" },
        take: input.limit,
        include: {
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              project: { select: { id: true, key: true, name: true } },
            },
          },
        },
      });
    },
  },

  "time.summary": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      groupBy: z.enum(["day", "issue", "project", "billable"]),
      userId: z.string().optional(),
    }),
    async run(
      input: {
        from: Date;
        to: Date;
        groupBy: "day" | "issue" | "project" | "billable";
        userId?: string;
      },
      ctx: McpContext,
    ) {
      const userId = input.userId ?? (await resolveActorId(ctx));
      const entries = await db.timeEntry.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId,
          startedAt: { gte: input.from, lte: input.to },
          endedAt: { not: null },
        },
        include: {
          issue: {
            select: {
              id: true,
              project: { select: { id: true } },
            },
          },
        },
      });
      const minutesBetween = (a: Date, b: Date) =>
        Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
      const amountFor = (minutes: number, rate?: number | null) =>
        !rate ? 0 : Math.round((minutes / 60) * rate * 100) / 100;
      const buckets = new Map<
        string,
        { key: string; minutes: number; billableAmount: number }
      >();
      let totalMinutes = 0;
      let totalBillableAmount = 0;
      for (const e of entries) {
        if (!e.endedAt) continue;
        const mins = minutesBetween(e.startedAt, e.endedAt);
        const amt = e.billable ? amountFor(mins, e.hourlyRate) : 0;
        totalMinutes += mins;
        totalBillableAmount += amt;
        let key: string;
        if (input.groupBy === "day") key = e.startedAt.toISOString().slice(0, 10);
        else if (input.groupBy === "issue") key = e.issue?.id ?? "unassigned";
        else if (input.groupBy === "project")
          key = e.issue?.project?.id ?? "unassigned";
        else key = e.billable ? "billable" : "non-billable";
        const bucket = buckets.get(key) ?? { key, minutes: 0, billableAmount: 0 };
        bucket.minutes += mins;
        bucket.billableAmount += amt;
        buckets.set(key, bucket);
      }
      return {
        totalMinutes,
        totalBillableAmount: Math.round(totalBillableAmount * 100) / 100,
        buckets: Array.from(buckets.values()).sort((a, b) => b.minutes - a.minutes),
      };
    },
  },

  // -------------------------------------------------------------- Attachments
  "attachments.initUpload": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      targetType: z
        .string()
        .refine((v) => ALLOWED_TARGET_TYPES.has(v), {
          message: `targetType must be one of ${[...ALLOWED_TARGET_TYPES].join(", ")}`,
        }),
      targetId: z.string(),
      filename: z.string().min(1).max(255),
      mimeType: z
        .string()
        .refine((v) => ALLOWED_MIME_TYPES.has(v), {
          message: "mimeType not allowed",
        }),
      size: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    }),
    async run(
      input: {
        targetType: string;
        targetId: string;
        filename: string;
        mimeType: string;
        size: number;
      },
      ctx: McpContext,
    ) {
      if (input.targetType === "issue") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.targetId,
        });
      } else if (input.targetType === "project") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: input.targetId,
        });
      } else if (input.targetType === "initiative") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "initiative",
          id: input.targetId,
        });
      }
      const uploaderId = await resolveActorId(ctx);
      return presignUploadUrl({
        workspaceId: ctx.workspaceId,
        uploaderId,
        targetType: input.targetType,
        targetId: input.targetId,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
      });
    },
  },

  "attachments.finalize": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ attachmentId: z.string() }),
    async run(input: { attachmentId: string }, ctx: McpContext) {
      return finalizeAttachment({
        attachmentId: input.attachmentId,
        workspaceId: ctx.workspaceId,
      });
    },
  },

  "attachments.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      targetType: z.string().refine((v) => ALLOWED_TARGET_TYPES.has(v)),
      targetId: z.string(),
    }),
    async run(
      input: { targetType: string; targetId: string },
      ctx: McpContext,
    ) {
      if (input.targetType === "issue") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.targetId,
        });
      } else if (input.targetType === "project") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: input.targetId,
        });
      } else if (input.targetType === "initiative") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "initiative",
          id: input.targetId,
        });
      }
      return db.attachment.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          NOT: { url: { startsWith: "pending:" } },
        },
        orderBy: { createdAt: "asc" },
      });
    },
  },

  "attachments.getDownloadUrl": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ attachmentId: z.string() }),
    async run(input: { attachmentId: string }, ctx: McpContext) {
      const row = await db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
        select: { id: true, targetType: true, targetId: true },
      });
      if (!row) throw new Error("Attachment not found.");
      if (row.targetType === "issue" && row.targetId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: row.targetId,
        });
      }
      return presignDownloadUrl(input.attachmentId);
    },
  },

  "attachments.delete": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ attachmentId: z.string() }),
    async run(input: { attachmentId: string }, ctx: McpContext) {
      const row = await db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
        select: { id: true, targetType: true, targetId: true },
      });
      if (!row) throw new Error("Attachment not found.");
      if (row.targetType === "issue" && row.targetId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: row.targetId,
        });
      }
      await deleteAttachment(input.attachmentId);
      return { ok: true };
    },
  },

  // -------------------------------------------------------------------- Pins
  "pins.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const user = await db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { pinnedIssueIds: true },
      });
      if (user.pinnedIssueIds.length === 0) return [];
      const issues = await db.issue.findMany({
        where: {
          id: { in: user.pinnedIssueIds },
          deletedAt: null,
          workspace: {
            deletedAt: null,
            memberships: { some: { userId } },
          },
        },
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          workspace: { select: { id: true, slug: true, key: true, name: true } },
          status: {
            select: { id: true, name: true, color: true, category: true },
          },
        },
      });
      const byId = new Map(issues.map((i) => [i.id, i]));
      return user.pinnedIssueIds
        .map((id) => byId.get(id))
        .filter((x): x is NonNullable<typeof x> => x !== undefined);
    },
  },

  "pins.set": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueIds: z
        .array(z.string())
        .max(3)
        .describe("Ordered list of pinned issue ids; max 3."),
    }),
    async run(input: { issueIds: string[] }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const ids = [...new Set(input.issueIds)];
      if (ids.length > 3) throw new Error("Max 3 pins.");
      if (ids.length > 0) {
        const count = await db.issue.count({
          where: {
            id: { in: ids },
            deletedAt: null,
            workspace: {
              deletedAt: null,
              memberships: { some: { userId } },
            },
          },
        });
        if (count !== ids.length) {
          throw new Error("One or more pinned issues are not accessible.");
        }
      }
      await db.user.update({
        where: { id: userId },
        data: { pinnedIssueIds: ids },
      });
      return { pinnedIssueIds: ids };
    },
  },
} as const;

export type McpToolName = keyof typeof mcpTools;

/**
 * Lightweight descriptor — used by the legacy REST handler's `describe`
 * endpoint. The JSON-RPC route builds richer descriptors via
 * `zod-to-json-schema` (see `/api/mcp/rpc/route.ts`).
 */
export async function describeMcp() {
  return {
    version: 1,
    tools: Object.entries(mcpTools).map(([name, t]) => ({
      name,
      scopes: t.scopes,
      inputSchema: t.input._def,
    })),
  };
}
