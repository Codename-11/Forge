import "server-only";
import { z } from "zod";
import { db } from "@/server/db";

/**
 * Forge's MCP (Model Context Protocol) surface — a small, stable set of
 * tools that any agent runtime (Claude Code, Hermes, OpenAI Agents) can
 * call to read/write Forge data.
 *
 * Each tool is auth-gated by scope. The route handler at
 * `/api/mcp/[tool]` authenticates the API key, then dispatches here.
 */

export interface McpContext {
  workspaceId: string;
  userId: string | null;
  pluginId: string | null;
}

export const mcpTools = {
  "issues.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      includeDone: z.boolean().default(false),
    }),
    async run(input: { query?: string; limit: number; includeDone: boolean }, ctx: McpContext) {
      return db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
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
    input: z.object({ id: z.string() }),
    async run(input: { id: string }, ctx: McpContext) {
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
      const status = await db.status.findFirstOrThrow({
        where: { workspaceId: ctx.workspaceId, isDefault: true },
      });
      const last = await db.issue.findFirst({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      return db.issue.create({
        data: {
          workspaceId: ctx.workspaceId,
          number: (last?.number ?? 0) + 1,
          title: input.title,
          description: input.description,
          projectId: input.projectId,
          statusId: status.id,
          priority: input.priority ?? "NONE",
          authorId: ctx.userId ?? (await db.membership.findFirstOrThrow({
            where: { workspaceId: ctx.workspaceId },
            select: { userId: true },
          })).userId,
        },
        include: { status: true },
      });
    },
  },
  "issues.transition": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string(), statusId: z.string() }),
    async run(input: { id: string; statusId: string }, _ctx: McpContext) {
      return db.issue.update({
        where: { id: input.id },
        data: { statusId: input.statusId },
      });
    },
  },
  "comments.create": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({ issueId: z.string(), body: z.string().min(1).max(50_000) }),
    async run(input: { issueId: string; body: string }, ctx: McpContext) {
      return db.comment.create({
        data: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          authorId: ctx.userId ?? (await db.membership.findFirstOrThrow({
            where: { workspaceId: ctx.workspaceId },
            select: { userId: true },
          })).userId,
          body: input.body,
        },
      });
    },
  },
  "projects.list": {
    scopes: ["READ_PROJECTS"] as const,
    input: z.object({ includeArchived: z.boolean().default(false) }),
    async run(input: { includeArchived: boolean }, ctx: McpContext) {
      return db.project.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...(input.includeArchived ? {} : { archived: false }),
        },
        orderBy: { updatedAt: "desc" },
      });
    },
  },
  "issues.claim": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      claimTtlMinutes: z.number().int().min(1).max(1440).default(60),
    }),
    async run(input: { claimTtlMinutes: number }, ctx: McpContext) {
      // Atomically claim the oldest unclaimed queued issue.
      // Postgres-specific: UPDATE … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1)
      // Until we wire that raw, rely on an updateMany + read fallback. Good enough for now.
      const agentUserId =
        ctx.userId ??
        (
          await db.membership.findFirstOrThrow({
            where: { workspaceId: ctx.workspaceId },
            select: { userId: true },
          })
        ).userId;
      const expiresAt = new Date(Date.now() + input.claimTtlMinutes * 60_000);
      const result = await db.$transaction(async (tx) => {
        const next = await tx.issue.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            queued: true,
            claimedAt: null,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        });
        if (!next) return null;
        return tx.issue.update({
          where: { id: next.id },
          data: {
            claimedById: agentUserId,
            claimedAt: new Date(),
            claimExpiresAt: expiresAt,
            assignees: {
              upsert: {
                where: { issueId_userId: { issueId: next.id, userId: agentUserId } },
                create: { userId: agentUserId },
                update: {},
              },
            },
          },
          include: { status: true, project: true },
        });
      });
      return result ?? { claimed: null };
    },
  },
  "issues.release": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string() }),
    async run(input: { id: string }, ctx: McpContext) {
      return db.issue.update({
        where: { id: input.id },
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
      return db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          ...(input.includeClaimed ? {} : { claimedAt: null }),
        },
        take: input.limit,
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        include: { status: true, project: true },
      });
    },
  },
  "analytics.summary": {
    scopes: ["READ_ANALYTICS"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      const [open, done] = await Promise.all([
        db.issue.count({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
        }),
        db.issue.count({
          where: { workspaceId: ctx.workspaceId, status: { category: "DONE" } },
        }),
      ]);
      return { openIssues: open, doneIssues: done };
    },
  },
} as const;

export type McpToolName = keyof typeof mcpTools;

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
