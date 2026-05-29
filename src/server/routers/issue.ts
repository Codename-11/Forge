import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EngagementMode, EventKind, Prisma, Priority, RelationKind, StatusCategory, WorkItemKind } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { assertKeyScope, buildKeyScopeWhere } from "@/server/services/api-key-auth";
import {
  maybeAutoDispatch,
  recordManualDispatchReason,
} from "@/server/services/dispatcher";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import { triageIssue } from "@/server/services/ai-triage";
import { finishRunsForIssue, recordAgentAction } from "@/server/services/agent-run";
import {
  autoWatchActor,
  autoWatchAgent,
  autoWatchUser,
} from "@/server/services/issue-watchers";
import { agentId as agentIdSchema } from "./agent";
import {
  ISSUE_SORT_VALUES,
  UPDATED_SINCE_VALUES,
  updatedSinceToDate,
} from "@/lib/saved-view-filters";
import type { SlashCommand } from "@/lib/slash-commands";
import type { db as DbHandleType } from "@/server/db";

const cursorSchema = z.string().optional();

/**
 * Zod shape for the `applyCommands` extension on `issue.create`. Mirrors
 * the `SlashCommand` discriminated union from `src/lib/slash-commands.ts`
 * so callers can either let the server parse the body OR pass a
 * pre-parsed array. Agents prefer the explicit array — more reliable
 * than text parsing.
 */
const slashCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assign"), handle: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("due"), date: z.coerce.date() }),
  z.object({ kind: z.literal("label"), name: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal("priority"),
    level: z.enum(["urgent", "high", "medium", "low", "none"]),
  }),
  z.object({ kind: z.literal("project"), key: z.string().min(2).max(8) }),
  z.object({ kind: z.literal("watch") }),
  z.object({ kind: z.literal("unwatch") }),
]);

/**
 * Apply a list of `SlashCommand`s to a freshly-created issue. Each
 * command is best-effort: missing labels/projects/agents log a skip
 * but don't fail the whole creation. Returns the structured outcome
 * for debugging / surfacing in the response. Runs OUTSIDE the create
 * transaction so failures here can never roll the issue back —
 * callers expect the issue to land regardless.
 */
type DbHandle = typeof DbHandleType;

async function applySlashCommandsToIssue(opts: {
  db: DbHandle;
  workspaceId: string;
  issueId: string;
  actorId: string;
  callerAgentId: string | null;
  commands: SlashCommand[];
  ip: string | null;
  userAgent: string | null;
}): Promise<Array<{ kind: string; status: "applied" | "skipped"; reason?: string }>> {
  const out: Array<{ kind: string; status: "applied" | "skipped"; reason?: string }> = [];
  const db = opts.db;
  const priorityMap: Record<string, Priority> = {
    urgent: Priority.URGENT,
    high: Priority.HIGH,
    medium: Priority.MEDIUM,
    low: Priority.LOW,
    none: Priority.NONE,
  };

  for (const cmd of opts.commands) {
    try {
      switch (cmd.kind) {
        case "assign": {
          const agent = await db.agent.findFirst({
            where: {
              workspaceId: opts.workspaceId,
              profileKey: cmd.handle,
              archivedAt: null,
            },
            select: { id: true, profileKey: true },
          });
          if (!agent) {
            out.push({ kind: cmd.kind, status: "skipped", reason: "agent not found" });
            break;
          }
          await db.$transaction(async (tx) => {
            await tx.issue.update({
              where: { id: opts.issueId },
              data: { assignedAgentId: agent.id },
            });
            const reasonBlob = await recordManualDispatchReason(tx, {
              issueId: opts.issueId,
              agentProfileKey: agent.profileKey,
              actorId: opts.actorId,
            });
            await recordChange(tx, {
              workspaceId: opts.workspaceId,
              actorId: opts.actorId,
              actorAgentId: opts.callerAgentId,
              entity: "Issue",
              entityId: opts.issueId,
              action: "assign-agent",
              after: { assignedAgentId: agent.id },
              eventKind: EventKind.AGENT_ASSIGNED,
              subjectType: "issue",
              subjectId: opts.issueId,
              payload: {
                agentId: agent.id,
                previousAgentId: null,
                dispatchReason: reasonBlob,
                via: "slash-command",
              },
              ip: opts.ip,
              userAgent: opts.userAgent,
            });
            await maybeApplyAgentTemplate(tx, opts.issueId, agent.id);
          });
          out.push({ kind: cmd.kind, status: "applied" });
          break;
        }
        case "due": {
          await db.issue.update({
            where: { id: opts.issueId },
            data: { dueDate: cmd.date },
          });
          out.push({ kind: cmd.kind, status: "applied" });
          break;
        }
        case "label": {
          const label = await db.label.findFirst({
            where: { workspaceId: opts.workspaceId, name: cmd.name },
            select: { id: true },
          });
          if (!label) {
            out.push({ kind: cmd.kind, status: "skipped", reason: "label not found" });
            break;
          }
          await db.issueLabel.upsert({
            where: { issueId_labelId: { issueId: opts.issueId, labelId: label.id } },
            create: { issueId: opts.issueId, labelId: label.id },
            update: {},
          });
          out.push({ kind: cmd.kind, status: "applied" });
          break;
        }
        case "priority": {
          await db.issue.update({
            where: { id: opts.issueId },
            data: { priority: priorityMap[cmd.level] },
          });
          out.push({ kind: cmd.kind, status: "applied" });
          break;
        }
        case "project": {
          const proj = await db.project.findFirst({
            where: { workspaceId: opts.workspaceId, key: cmd.key, archived: false },
            select: { id: true },
          });
          if (!proj) {
            out.push({ kind: cmd.kind, status: "skipped", reason: "project not found" });
            break;
          }
          await db.issue.update({
            where: { id: opts.issueId },
            data: { projectId: proj.id },
          });
          out.push({ kind: cmd.kind, status: "applied" });
          break;
        }
        case "watch": {
          // user-watch only when caller is human; agent-watch when caller
          // is an agent via API key.
          if (opts.callerAgentId) {
            await db.issueWatcher.upsert({
              where: { issueId_agentId: { issueId: opts.issueId, agentId: opts.callerAgentId } },
              create: {
                workspaceId: opts.workspaceId,
                issueId: opts.issueId,
                agentId: opts.callerAgentId,
              },
              update: {},
            });
          } else {
            await db.issueWatcher.upsert({
              where: { issueId_userId: { issueId: opts.issueId, userId: opts.actorId } },
              create: {
                workspaceId: opts.workspaceId,
                issueId: opts.issueId,
                userId: opts.actorId,
              },
              update: {},
            });
          }
          out.push({ kind: cmd.kind, status: "applied" });
          break;
        }
        case "unwatch": {
          if (opts.callerAgentId) {
            await db.issueWatcher.deleteMany({
              where: { issueId: opts.issueId, agentId: opts.callerAgentId },
            });
          } else {
            await db.issueWatcher.deleteMany({
              where: { issueId: opts.issueId, userId: opts.actorId },
            });
          }
          out.push({ kind: cmd.kind, status: "applied" });
          break;
        }
      }
    } catch (e) {
      out.push({
        kind: cmd.kind,
        status: "skipped",
        reason: e instanceof Error ? e.message : "unknown",
      });
    }
  }
  return out;
}

const filterSchema = z.object({
  // -- Singleton filters (kept for back-compat with existing call-sites). --
  projectId: z.string().cuid().optional(),
  statusId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().optional(),
  priority: z.nativeEnum(Priority).optional(),
  query: z.string().max(200).optional(),
  includeDone: z.boolean().default(true),
  /**
   * Cycle filter. `undefined` = any cycle (no filter). Pass a cycle id to
   * pin. Pass `null` to match "backlog" — issues with no cycle.
   */
  cycleId: z.string().cuid().nullable().optional(),
  /**
   * Initiative filter — joins through `project.initiativeId`. `undefined`
   * for no filter; `null` matches issues whose project has no initiative
   * (or no project at all).
   */
  initiativeId: z.string().cuid().nullable().optional(),
  /**
   * Agent-assignment filter. `undefined` = no filter. Pass an agent id
   * to pin; pass `null` to match issues with no agent assigned.
   */
  assignedAgentId: agentIdSchema.nullable().optional(),

  // -- Array / projection filters (Phase 1D saved-views). --------------------
  // Any-of semantics. AND'd with singleton equivalents above when both pass.
  projectIds: z.array(z.string().cuid()).max(100).optional(),
  statusIds: z.array(z.string().cuid()).max(100).optional(),
  statusCategories: z.array(z.nativeEnum(StatusCategory)).max(8).optional(),
  assigneeIds: z.array(z.string().cuid()).max(100).optional(),
  labelIds: z.array(z.string().cuid()).max(100).optional(),
  initiativeIds: z.array(z.string().cuid()).max(100).optional(),
  cycleIds: z.array(z.string().cuid()).max(100).optional(),
  priorities: z.array(z.nativeEnum(Priority)).max(8).optional(),
  /** Work-item kind filter (any-of). e.g. `["EPIC"]` for the Epics view. */
  kinds: z.array(z.nativeEnum(WorkItemKind)).max(8).optional(),
  /** Match issues whose project has no initiative (or no project at all). */
  withoutInitiative: z.boolean().optional(),
  /** Match issues with no cycle assignment. */
  withoutCycle: z.boolean().optional(),
  /** Match issues with no human assignees AND no agent. */
  unassigned: z.boolean().optional(),
  /** Match issues blocked by an open dependency. */
  blocked: z.boolean().optional(),
  /** Window: only issues updated within the last N days. */
  updatedSince: z.enum(UPDATED_SINCE_VALUES).optional(),
  /**
   * Filter out issues whose `snoozedUntil` is still in the future. Default
   * `false` keeps the public schema permissive (consumers asking for "all
   * issues" expect snoozed ones to be visible). Stalled-style consumers
   * (inbox, dashboard suggestions) pass `true`.
   */
  excludeSnoozed: z.boolean().default(false),

  /**
   * Single-day due-date filter. Format `YYYY-MM-DD` (UTC). Narrows to
   * issues whose `dueDate` falls within `[startOfDay, startOfDay+1d)`.
   * Powers the Today widget's week-peek day-cell deep-link to
   * `/issues?dueOn=…`.
   */
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dueOn must be YYYY-MM-DD")
    .optional(),

  /**
   * Result ordering. `priority` (default) keeps the historical
   * priority-desc then newest-first sort; the rest are single-key sorts
   * surfaced by the issues-list Sort control. Not persisted on saved
   * views — it's a per-user view preference.
   */
  sort: z.enum(ISSUE_SORT_VALUES).optional(),

  limit: z.number().min(1).max(500).default(50),
  cursor: cursorSchema,
});

export const issueRouter = router({
  list: workspaceProcedure
    .input(filterSchema.default({ includeDone: true, limit: 50 }))
    .query(async ({ ctx, input }) => {
      const keyWhere = buildKeyScopeWhere(ctx, "issue");
      // Compose optional OR clauses under AND so multiple predicates that
      // each need OR (query, initiativeId=null) don't clobber each other.
      const andClauses: Array<Record<string, unknown>> = [];
      if (input.initiativeId === null || input.withoutInitiative === true) {
        andClauses.push({
          OR: [{ projectId: null }, { project: { initiativeId: null } }],
        });
      }
      if (input.query) {
        andClauses.push({
          OR: [
            { title: { contains: input.query, mode: "insensitive" } },
            { description: { contains: input.query, mode: "insensitive" } },
          ],
        });
      }

      // `unassigned` = no human assignees AND no agent. Implemented as a
      // single AND so it composes with explicit assigneeIds / assignedAgentId.
      if (input.unassigned === true) {
        andClauses.push({
          AND: [{ assignees: { none: {} } }, { assignedAgentId: null }],
        });
      }

      // Status: combine `statusIds[]` and `statusCategories[]` under OR
      // when both are present so saved views can pin "any of {Backlog} OR
      // exact id Foo" without needing two views. When only one is set we
      // emit the simpler clause.
      let statusClause: Record<string, unknown> | null = null;
      if (input.statusIds?.length && input.statusCategories?.length) {
        statusClause = {
          OR: [
            { statusId: { in: input.statusIds } },
            { status: { category: { in: input.statusCategories } } },
          ],
        };
      } else if (input.statusIds?.length) {
        statusClause = { statusId: { in: input.statusIds } };
      } else if (input.statusCategories?.length) {
        statusClause = { status: { category: { in: input.statusCategories } } };
      }
      if (statusClause) andClauses.push(statusClause);

      // Cycle: array form. The `withoutCycle` boolean appends a `cycleId
      // IS NULL` branch under OR so a saved view can express "in sprint
      // X OR uncycled" if it ever wants to. The single `cycleId` field
      // (above) keeps prior behavior.
      if (input.cycleIds?.length || input.withoutCycle === true) {
        const ors: Array<Record<string, unknown>> = [];
        if (input.cycleIds?.length) ors.push({ cycleId: { in: input.cycleIds } });
        if (input.withoutCycle === true) ors.push({ cycleId: null });
        andClauses.push({ OR: ors });
      }

      // Initiative array: joins through project.initiativeId. The
      // `withoutInitiative` toggle is already handled above; this branch
      // adds the explicit-id case.
      if (input.initiativeIds?.length) {
        andClauses.push({
          project: { initiativeId: { in: input.initiativeIds } },
        });
      }

      // `blocked: true` resolves the blocked-set up front and constrains
      // the row id. Skipped when false/undefined to keep the unblocked
      // path on a single query.
      let blockedConstraint: Record<string, unknown> | null = null;
      if (input.blocked === true) {
        const blocked = await findBlockedIssueIds(ctx);
        if (blocked.size === 0) {
          // Nothing blocked → return early with an empty page.
          return { items: [], nextCursor: undefined };
        }
        blockedConstraint = { id: { in: [...blocked] } };
      }

      // Result ordering. Default keeps priority-desc then newest-first;
      // the Sort control offers single-key alternatives.
      const orderBy: Prisma.IssueOrderByWithRelationInput[] =
        input.sort === "newest"
          ? [{ createdAt: "desc" }]
          : input.sort === "oldest"
            ? [{ createdAt: "asc" }]
            : input.sort === "updated"
              ? [{ updatedAt: "desc" }]
              : input.sort === "title"
                ? [{ title: "asc" }]
                : [{ priority: "desc" }, { createdAt: "desc" }];

      const rows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...keyWhere,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.projectIds?.length
            ? { projectId: { in: input.projectIds } }
            : {}),
          ...(input.statusId ? { statusId: input.statusId } : {}),
          ...(input.assigneeId ? { assignees: { some: { userId: input.assigneeId } } } : {}),
          ...(input.assigneeIds?.length
            ? { assignees: { some: { userId: { in: input.assigneeIds } } } }
            : {}),
          ...(input.labelIds?.length
            ? { labels: { some: { labelId: { in: input.labelIds } } } }
            : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.priorities?.length
            ? { priority: { in: input.priorities } }
            : {}),
          ...(input.kinds?.length ? { kind: { in: input.kinds } } : {}),
          ...(input.cycleId === null
            ? { cycleId: null }
            : input.cycleId
              ? { cycleId: input.cycleId }
              : {}),
          ...(typeof input.initiativeId === "string"
            ? { project: { initiativeId: input.initiativeId } }
            : {}),
          ...(input.assignedAgentId === null
            ? { assignedAgentId: null }
            : input.assignedAgentId
              ? { assignedAgentId: input.assignedAgentId }
              : {}),
          ...(input.updatedSince
            ? { updatedAt: { gte: updatedSinceToDate(input.updatedSince) } }
            : {}),
          ...(input.excludeSnoozed
            ? {
                OR: [
                  { snoozedUntil: null },
                  { snoozedUntil: { lte: new Date() } },
                ],
              }
            : {}),
          ...(input.dueOn
            ? (() => {
                // Parse YYYY-MM-DD as UTC midnight, then bracket the day.
                const [y, m, d] = input.dueOn.split("-").map(Number);
                const start = new Date(Date.UTC(y, m - 1, d));
                const end = new Date(Date.UTC(y, m - 1, d + 1));
                return { dueDate: { gte: start, lt: end } };
              })()
            : {}),
          ...(input.includeDone ? {} : { status: { category: { notIn: ["DONE", "CANCELED"] } } }),
          ...(blockedConstraint ?? {}),
          ...(andClauses.length ? { AND: andClauses } : {}),
        },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        orderBy,
        include: {
          status: true,
          project: { select: { id: true, key: true, name: true, color: true, icon: true } },
          assignees: { include: { user: { select: { id: true, name: true, image: true } } } },
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
              // On-demand availability signals (so assignee chips don't show a
              // false "offline" for managed-runtime agents like Codex).
              provider: true,
              runtimeMode: true,
              lastHeartbeatAt: true,
              webhookUrl: true,
              runtimeId: true,
            },
          },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
        },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      const withFlags = await annotateUnblocked(ctx, rows);
      return { items: withFlags, nextCursor };
    }),

  byId: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
        include: {
          status: true,
          project: true,
          author: { select: { id: true, name: true, image: true } },
          assignees: { include: { user: { select: { id: true, name: true, image: true } } } },
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
              // On-demand availability signals (so assignee chips don't show a
              // false "offline" for managed-runtime agents like Codex).
              provider: true,
              runtimeMode: true,
              lastHeartbeatAt: true,
              webhookUrl: true,
              runtimeId: true,
            },
          },
          labels: { include: { label: true } },
          comments: {
            orderBy: { createdAt: "asc" },
            include: {
              author: { select: { id: true, name: true, image: true } },
              authoringAgent: {
                select: { id: true, name: true, profileKey: true, avatar: true },
              },
              run: { select: { id: true, status: true, finishedAt: true } },
            },
          },
          attachments: true,
          children: {
            select: { id: true, number: true, title: true, statusId: true },
            orderBy: { number: "asc" },
          },
          parent: { select: { id: true, number: true, title: true } },
          // Plan-step provenance (AXI-56): when this issue was materialized
          // from an ExecutionStep, surface the originating step + plan so the
          // issue can deep-link back to its plan.
          executionSteps: {
            select: {
              id: true,
              title: true,
              position: true,
              plan: { select: { id: true, title: true } },
            },
          },
        },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      return issue;
    }),

  /**
   * Child issues of a parent (sub-issues) with their status + kind, plus a
   * done/total rollup. Powers the Sub-issues panel on the issue detail page
   * — lean and self-contained so the panel refetches after a create-child
   * without re-pulling the whole `byId` payload. `done` counts children in
   * a terminal status category (DONE/CANCELED).
   */
  children: workspaceProcedure
    .input(z.object({ parentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const parent = await ctx.db.issue.findFirst({
        where: { id: input.parentId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) throw new TRPCError({ code: "NOT_FOUND" });

      const rows = await ctx.db.issue.findMany({
        where: {
          parentId: input.parentId,
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        orderBy: [{ status: { position: "asc" } }, { number: "asc" }],
        select: {
          id: true,
          number: true,
          title: true,
          kind: true,
          priority: true,
          status: { select: { id: true, name: true, color: true, category: true } },
        },
      });

      const done = rows.filter(
        (r) => r.status.category === "DONE" || r.status.category === "CANCELED",
      ).length;
      return { items: rows, total: rows.length, done };
    }),

  /**
   * Activity stream for a single issue — the audit-backed `ActivityEvent`
   * rows that share the issue's id as `subjectId`. Workspace-scoped so
   * any member can view (unlike `admin.events` which is OWNER/ADMIN only).
   * Feeds the Activity tab on the issue detail right-rail.
   */
  activity: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Confirm the issue exists and lives in this tenant before reading
      // its events — avoids leaking cross-tenant subjectIds through guesses.
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      const rows = await ctx.db.activityEvent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          subjectType: "issue",
          subjectId: input.issueId,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        include: {
          actor: { select: { id: true, name: true, image: true } },
          actorAgent: {
            select: { id: true, name: true, profileKey: true, avatar: true },
          },
        },
      });
      return rows;
    }),

  /**
   * Narrow "card-shape" summary used by the issue-key hover preview.
   * Looks up an issue by its `KEY-NN` token within the current workspace
   * — refuses cross-tenant resolves (the lookup is workspace-scoped, and
   * we reject when the prefix doesn't match the workspace's own `key`).
   *
   * The select shape is intentionally tight: status pill, priority,
   * a few assignees (cap 4 — UI shows up to 3 + a "+N" overflow), the
   * assigned agent, and project chip. Cacheable per-issue; the client
   * sets a generous `staleTime` so hovering the same ref twice doesn't
   * double-fetch.
   */
  summary: workspaceProcedure
    .input(z.object({ key: z.string().min(3).max(32) }))
    .query(async ({ ctx, input }) => {
      const m = /^([A-Z0-9]+)-(\d+)$/i.exec(input.key);
      if (!m) throw new TRPCError({ code: "NOT_FOUND" });
      const wsKey = m[1].toUpperCase();
      const number = parseInt(m[2], 10);
      const workspace = await ctx.db.workspace.findUnique({
        where: { id: ctx.workspaceId },
        select: { key: true, slug: true },
      });
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });
      // Cross-workspace check — `summary({ key: 'OTHER-1' })` from inside
      // workspace `AXI` should not resolve OTHER's issue. Refuse early.
      if (wsKey !== workspace.key) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const issue = await ctx.db.issue.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          number,
          deletedAt: null,
        },
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          status: {
            select: { id: true, name: true, color: true, category: true },
          },
          assignees: {
            take: 4,
            include: {
              user: { select: { id: true, name: true, image: true } },
            },
          },
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
              // On-demand availability signals (so assignee chips don't show a
              // false "offline" for managed-runtime agents like Codex).
              provider: true,
              runtimeMode: true,
              lastHeartbeatAt: true,
              webhookUrl: true,
              runtimeId: true,
            },
          },
          project: {
            select: { id: true, key: true, name: true, color: true },
          },
        },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      return {
        ...issue,
        key: `${workspace.key}-${issue.number}`,
        workspaceSlug: workspace.slug,
      };
    }),

  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(50_000).optional(),
        projectId: z.string().cuid().optional(),
        parentId: z.string().cuid().optional(),
        statusId: z.string().cuid().optional(),
        priority: z.nativeEnum(Priority).default(Priority.NONE),
        kind: z.nativeEnum(WorkItemKind).default(WorkItemKind.ISSUE),
        assigneeIds: z.array(z.string().cuid()).default([]),
        assignedAgentId: agentIdSchema.optional(),
        labelIds: z.array(z.string().cuid()).default([]),
        dueDate: z.date().optional(),
        estimate: z.number().min(0).optional(),
        slaMinutes: z.number().int().min(1).optional(),
        /**
         * Optional pre-parsed slash commands to apply after the issue
         * is created. Composer UIs and agents should pass this rather
         * than relying on the server to text-parse the description.
         * Each command is best-effort — failures log a skip and don't
         * roll the create back.
         */
        applyCommands: z.array(slashCommandSchema).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const status = input.statusId
          ? await tx.status.findFirstOrThrow({
              where: { id: input.statusId, workspaceId: ctx.workspaceId },
            })
          : await tx.status.findFirstOrThrow({
              where: { workspaceId: ctx.workspaceId, isDefault: true },
            });

        // Cross-tenant guard: agent must live in this workspace.
        if (input.assignedAgentId) {
          const agent = await tx.agent.findFirst({
            where: { id: input.assignedAgentId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!agent) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Agent not found in this workspace.",
            });
          }
        }

        const last = await tx.issue.findFirst({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const number = (last?.number ?? 0) + 1;

        const issue = await tx.issue.create({
          data: {
            workspaceId: ctx.workspaceId,
            number,
            kind: input.kind,
            title: input.title,
            description: input.description,
            projectId: input.projectId,
            parentId: input.parentId,
            statusId: status.id,
            priority: input.priority,
            authorId: ctx.session.user.id,
            assignedAgentId: input.assignedAgentId,
            dueDate: input.dueDate,
            estimate: input.estimate,
            slaMinutes: input.slaMinutes,
            assignees: {
              create: input.assigneeIds.map((userId) => ({ userId })),
            },
            labels: {
              create: input.labelIds.map((labelId) => ({ labelId })),
            },
          },
          include: { status: true, assignees: true, labels: true },
        });
        // Auto-watch on create. The author (or authoring agent) is the
        // de-facto first watcher — every modern PM tool does this. When
        // the create comes via an agent-linked API key we watch the
        // agent instead; system-created issues (no actor) skip.
        await autoWatchActor(tx, {
          workspaceId: ctx.workspaceId,
          issueId: issue.id,
          userId: ctx.session.user.id,
          callerAgentId: ctx.apiKey?.linkedAgentId ?? null,
        });
        // Human assignees specified at create time are auto-watched too,
        // so they get the post-create event fan-out (status changes,
        // comments) without having to manually click WatchButton.
        for (const userId of input.assigneeIds) {
          await autoWatchUser(tx, {
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            userId,
          });
        }
        // Pre-assigned agent at create time also gets a watcher row so
        // any subsequent issue-subject event reaches it via the
        // watcher fan-out branch (in addition to the assignee branch).
        if (input.assignedAgentId) {
          await autoWatchAgent(tx, {
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            agentId: input.assignedAgentId,
          });
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: issue.id,
          action: "create",
          after: issue,
          eventKind: EventKind.ISSUE_CREATED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: { number: issue.number, title: issue.title },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        if (input.assignedAgentId) {
          // Stamp a manual `dispatchReason` blob so the attribution
          // chip can render even when an operator picked the agent
          // directly (rather than the auto-dispatcher).
          const agentRow = await tx.agent.findUniqueOrThrow({
            where: { id: input.assignedAgentId },
            select: { profileKey: true },
          });
          const reasonBlob = await recordManualDispatchReason(tx, {
            issueId: issue.id,
            agentProfileKey: agentRow.profileKey,
            actorId: ctx.session.user.id,
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "assign-agent",
            after: { assignedAgentId: input.assignedAgentId },
            eventKind: EventKind.AGENT_ASSIGNED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              agentId: input.assignedAgentId,
              previousAgentId: null,
              dispatchReason: reasonBlob,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          // Apply the agent's template if the description is empty. No-op
          // when the caller supplied a description or the agent has no
          // template configured.
          await maybeApplyAgentTemplate(tx, issue.id, input.assignedAgentId);
        }
        // `maybeAutoDispatch` handles its own template application when it
        // picks an agent — no need to double-call from here.
        await maybeAutoDispatch(tx, issue.id);
        return issue;
      }).then(async (issue) => {
        // Apply slash commands AFTER the create transaction commits, so
        // a missing label or unknown agent doesn't roll the issue back.
        // Each step has its own small transaction (assign also writes
        // an AGENT_ASSIGNED event) — see `applySlashCommandsToIssue`.
        let commandResults:
          | Array<{ kind: string; status: "applied" | "skipped"; reason?: string }>
          | undefined;
        if (input.applyCommands && input.applyCommands.length > 0) {
          commandResults = await applySlashCommandsToIssue({
            db: ctx.db,
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            actorId: ctx.session.user.id,
            callerAgentId: ctx.apiKey?.linkedAgentId ?? null,
            commands: input.applyCommands,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        // Fire-and-forget AI triage. Skipped server-side when AI is off
        // or already-triaged. Runs out-of-band so create stays sub-100ms
        // even when the LLM call takes seconds. We don't await — clients
        // poll via the issue.byId query (toaster/realtime invalidation
        // surfaces the chip when ready).
        if (!ctx.apiKey) {
          // Only auto-triage human-authored issues. Skip when an agent
          // creates an issue via API key (saves cost on bulk creates).
          void triageIssue(issue.id);
        }
        return commandResults
          ? { ...issue, commandResults }
          : issue;
      });
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        statusId: z.string().cuid().optional(),
        priority: z.nativeEnum(Priority).optional(),
        kind: z.nativeEnum(WorkItemKind).optional(),
        projectId: z.string().cuid().nullable().optional(),
        cycleId: z.string().cuid().nullable().optional(),
        assignedAgentId: agentIdSchema.nullable().optional(),
        /**
         * Engagement mode for this assignment (AXI-53). Only meaningful
         * alongside a non-null `assignedAgentId`. When omitted, the
         * workspace `assignmentEngagementMode` default is resolved server
         * side. Stamped on the AGENT_ASSIGNED payload so the dispatcher /
         * opened run pick it up — mirrors the MCP `issues.assign` path.
         */
        mode: z.nativeEnum(EngagementMode).optional(),
        dueDate: z.date().nullable().optional(),
        estimate: z.number().min(0).nullable().optional(),
        /**
         * Agent completion contract. `null` clears the field; omit to
         * leave unchanged. See agent-completion-contract.ts for the
         * structured shape of verificationChecklist.
         */
        expectedOutput: z.string().max(50_000).nullable().optional(),
        verificationChecklist: z
          .array(
            z.object({
              id: z.string().min(1).optional(),
              label: z.string().min(1).max(500),
              kind: z.enum(["manual", "command", "artifact"]).optional(),
              value: z.string().max(2_000).optional(),
              done: z.boolean().optional(),
            }),
          )
          .max(50)
          .nullable()
          .optional(),
        artifactRequired: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // `mode` is dispatch metadata, not an Issue column — pull it out of
      // the patch so it never reaches `issue.update`'s data payload. It's
      // resolved + stamped on the AGENT_ASSIGNED event below.
      const { id, mode: explicitMode, ...patch } = input;
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.issue.findFirstOrThrow({
          where: { id, workspaceId: ctx.workspaceId },
          include: { status: true },
        });

        // Cross-tenant guard: if the caller tries to move the issue to a
        // project or status in a different workspace, reject.
        if (patch.projectId) {
          const proj = await tx.project.findFirst({
            where: { id: patch.projectId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!proj) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Project not found in this workspace.",
            });
          }
        }
        // Cross-tenant guard: cycle must live in this workspace when set.
        if (patch.cycleId) {
          const cyc = await tx.cycle.findFirst({
            where: { id: patch.cycleId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!cyc) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Sprint not found in this workspace.",
            });
          }
        }
        if (patch.statusId) {
          const st = await tx.status.findFirst({
            where: { id: patch.statusId, workspaceId: ctx.workspaceId },
            select: { id: true, category: true },
          });
          if (!st) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Status not found in this workspace.",
            });
          }
        }
        // Cross-tenant guard: agent must live in this workspace when set.
        if (patch.assignedAgentId) {
          const agent = await tx.agent.findFirst({
            where: { id: patch.assignedAgentId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!agent) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Agent not found in this workspace.",
            });
          }
        }

        // Mark lifecycle timestamps based on status category transitions.
        const extra: { startedAt?: Date; completedAt?: Date | null; canceledAt?: Date | null } = {};
        let nextCategory: string | null = null;
        if (patch.statusId && patch.statusId !== before.statusId) {
          const next = await tx.status.findFirstOrThrow({
            where: { id: patch.statusId, workspaceId: ctx.workspaceId },
          });
          nextCategory = next.category;
          if (next.category === "IN_PROGRESS" && !before.startedAt) extra.startedAt = new Date();
          if (next.category === "DONE") extra.completedAt = new Date();
          if (next.category === "CANCELED") extra.canceledAt = new Date();
          if (next.category !== "DONE") extra.completedAt = null;
          if (next.category !== "CANCELED") extra.canceledAt = null;
        }

        // verificationChecklist is a Json column — split it out so the
        // generic spread doesn't trip Prisma's Json-narrowing type union
        // (which is picky about null vs Prisma.JsonNull).
        const { verificationChecklist, ...patchRest } = patch;
        const checklistData =
          verificationChecklist === undefined
            ? {}
            : verificationChecklist === null
              ? { verificationChecklist: Prisma.JsonNull }
              : { verificationChecklist: verificationChecklist as Prisma.InputJsonValue };
        const updateRes = await tx.issue.updateMany({
          where: { id, workspaceId: ctx.workspaceId },
          data: { ...patchRest, ...checklistData, ...extra },
        });
        if (updateRes.count === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
        }
        const after = await tx.issue.findUniqueOrThrow({
          where: { id },
          include: { status: true },
        });

        // Generic update event — status changes re-label this so existing
        // ISSUE_STATUS_CHANGED subscribers keep working. Priority changes
        // additionally emit ISSUE_PRIORITY_CHANGED below so the webhook bus
        // + agent-dispatch escalation path can route on the specific kind
        // without walking the generic payload.
        const kind =
          patch.statusId && patch.statusId !== before.statusId
            ? EventKind.ISSUE_STATUS_CHANGED
            : EventKind.ISSUE_UPDATED;

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: id,
          action: "update",
          before,
          after,
          eventKind: kind,
          subjectType: "issue",
          subjectId: id,
          payload: patch,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        // Priority transitions get a dedicated event so downstream webhook
        // subscribers + the agent-dispatch escalation path (HIGH/URGENT)
        // can route precisely without parsing patch diffs.
        if (patch.priority && patch.priority !== before.priority) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: id,
            action: "change-priority",
            before: { priority: before.priority },
            after: { priority: patch.priority },
            eventKind: EventKind.ISSUE_PRIORITY_CHANGED,
            subjectType: "issue",
            subjectId: id,
            payload: { from: before.priority, to: patch.priority },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }

        // Agent-assignment changes get a dedicated event so the activity
        // stream / webhook bus can route on `AGENT_ASSIGNED` without
        // parsing `payload` for every generic ISSUE_UPDATED.
        const agentProvided = Object.prototype.hasOwnProperty.call(patch, "assignedAgentId");
        if (agentProvided && (patch.assignedAgentId ?? null) !== (before.assignedAgentId ?? null)) {
          // Manual assignment / unassignment — stamp a `dispatchReason`
          // when an agent is being set, clear it on unassign.
          let manualReason: Record<string, unknown> | null = null;
          if (patch.assignedAgentId) {
            const agentRow = await tx.agent.findUniqueOrThrow({
              where: { id: patch.assignedAgentId },
              select: { profileKey: true },
            });
            manualReason = (await recordManualDispatchReason(tx, {
              issueId: id,
              agentProfileKey: agentRow.profileKey,
              actorId: ctx.session.user.id,
            })) as Record<string, unknown>;
          } else {
            // Cleared assignment — drop the previous reason.
            await tx.issue.update({
              where: { id },
              data: { dispatchReason: Prisma.JsonNull },
            });
          }
          // Resolve the engagement mode for this assignment (AXI-53) —
          // explicit override > workspace assignment default. Only on
          // assign (not unassign). Mirrors the MCP `issues.assign` path.
          let engagementMode: EngagementMode | undefined;
          if (patch.assignedAgentId) {
            const { resolveEngagementMode } = await import(
              "@/server/services/engagement-mode"
            );
            const ws = await tx.workspace.findUniqueOrThrow({
              where: { id: ctx.workspaceId },
              select: {
                assignmentEngagementMode: true,
                mentionEngagementPolicy: true,
                mentionDefaultMode: true,
              },
            });
            engagementMode = resolveEngagementMode({
              surface: "assignment",
              explicit: explicitMode ?? null,
              workspace: ws,
            }).mode;
          }
          const assignmentPayload: Prisma.InputJsonObject = {
            agentId: patch.assignedAgentId ?? null,
            previousAgentId: before.assignedAgentId,
            ...(manualReason ? { dispatchReason: manualReason as Prisma.InputJsonObject } : {}),
            ...(engagementMode ? { engagementMode } : {}),
          };
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: id,
            action: "assign-agent",
            before: { assignedAgentId: before.assignedAgentId },
            after: { assignedAgentId: patch.assignedAgentId ?? null },
            eventKind: EventKind.AGENT_ASSIGNED,
            subjectType: "issue",
            subjectId: id,
            payload: assignmentPayload,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          // Apply template on assignment (or re-assignment) when the
          // new agent has one and the current description is empty.
          // The helper itself no-ops on both missing template and non-
          // empty description, so re-assignment to a different agent on
          // an already-populated issue won't clobber prior content.
          if (patch.assignedAgentId) {
            await maybeApplyAgentTemplate(tx, id, patch.assignedAgentId);
            // Auto-watch the newly-assigned agent so subsequent
            // issue-subject events route to it via the watcher branch
            // (in addition to the AGENT_ASSIGNED-and-route-to-assignee
            // branch). Sticky — unassignment doesn't strip the watch.
            await autoWatchAgent(tx, {
              workspaceId: ctx.workspaceId,
              issueId: id,
              agentId: patch.assignedAgentId,
            });
          }
        }

        // AgentRun lifecycle: when the issue lands in a terminal status
        // (DONE / CANCELED) close any ACTIVE runs so the live pulse
        // strip drops off the issue page. ABANDONED on cancel keeps the
        // distinction between "agent finished" and "operator killed it."
        if (nextCategory === "DONE" || nextCategory === "CANCELED") {
          await finishRunsForIssue(tx, {
            workspaceId: ctx.workspaceId,
            issueId: id,
            status: nextCategory === "DONE" ? "COMPLETED" : "ABANDONED",
            actorId: ctx.session.user.id,
          });
        } else if (
          // Touch the run on transition by the assigned agent so the
          // status-change is reflected in the timeline as a STEP event.
          before.assignedAgentId &&
          patch.statusId &&
          patch.statusId !== before.statusId
        ) {
          await recordAgentAction(tx, {
            workspaceId: ctx.workspaceId,
            issueId: id,
            agentId: before.assignedAgentId,
            kind: "TRANSITION",
            payload: { from: before.statusId, to: patch.statusId, category: nextCategory },
            actorId: ctx.session.user.id,
          });
        }

        return after;
      });
    }),

  assign: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), userIds: z.array(z.string().cuid()) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        // Snapshot current assignees so we can identify newly-added user
        // ids (those get auto-watched). Removed assignees keep watching —
        // once watching, stays watching until manual unwatch.
        const before = await tx.issueAssignee.findMany({
          where: { issueId: input.id },
          select: { userId: true },
        });
        const previousUserIds = new Set(before.map((a) => a.userId));

        await tx.issueAssignee.deleteMany({ where: { issueId: input.id } });
        if (input.userIds.length) {
          await tx.issueAssignee.createMany({
            data: input.userIds.map((userId) => ({ issueId: input.id, userId })),
          });
        }

        // Auto-watch the newly-added assignees. Existing assignees are
        // either already watching (from a prior assign / create / etc.)
        // or have manually unwatched at some point — we don't re-watch
        // those on every re-assign, only the brand-new additions.
        for (const userId of input.userIds) {
          if (!previousUserIds.has(userId)) {
            await autoWatchUser(tx, {
              workspaceId: ctx.workspaceId,
              issueId: input.id,
              userId,
            });
          }
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: input.id,
          action: "assign",
          after: { assigneeIds: input.userIds },
          eventKind: EventKind.ISSUE_ASSIGNED,
          subjectType: "issue",
          subjectId: input.id,
          payload: { assigneeIds: input.userIds },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return tx.issue.findUniqueOrThrow({
          where: { id: input.id },
          include: { assignees: { include: { user: true } } },
        });
      });
    }),

  softDelete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const res = await ctx.db.issue.updateMany({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        data: { deletedAt: new Date() },
      });
      if (res.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
      }
      return { ok: true };
    }),

  bulkStatus: workspaceProcedure
    .input(z.object({ ids: z.array(z.string().cuid()).max(200), statusId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.issue.updateMany({
        where: { id: { in: input.ids }, workspaceId: ctx.workspaceId },
        data: { statusId: input.statusId },
      }),
    ),

  /**
   * Bulk add/remove labels across many issues in one RPC. All referenced
   * label ids are validated to live in the same workspace as the issues
   * (one query, not N). Audit + activity events are written per issue via
   * `recordChange()` so the invariant "audit log and activity event live
   * together" holds — chunked into 50s inside a single transaction to
   * keep the tx small.
   */
  bulkSetLabels: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        add: z.array(z.string().cuid()).default([]),
        remove: z.array(z.string().cuid()).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) {
        return { updated: 0, added: 0, removed: 0 };
      }
      const labelIds = Array.from(new Set([...input.add, ...input.remove]));
      if (labelIds.length > 0) {
        const found = await ctx.db.label.findMany({
          where: { id: { in: labelIds }, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (found.length !== labelIds.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more labels do not belong to this workspace.",
          });
        }
      }

      return ctx.db.$transaction(async (tx) => {
        // Filter issueIds to those that actually exist in this workspace.
        // updateMany's where-scope on the join rows already enforces
        // workspaceId via the issue fk; we validate to report real counts
        // and to avoid writing audit rows for issues that don't exist.
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.issueIds },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) {
          return { updated: 0, added: 0, removed: 0 };
        }

        let added = 0;
        let removed = 0;

        if (input.remove.length > 0) {
          const res = await tx.issueLabel.deleteMany({
            where: {
              issueId: { in: validIds },
              labelId: { in: input.remove },
            },
          });
          removed = res.count;
        }

        if (input.add.length > 0) {
          // Build all (issueId, labelId) pairs; skipDuplicates handles
          // existing rows via the composite @@id([issueId, labelId]).
          const data = validIds.flatMap((issueId) =>
            input.add.map((labelId) => ({ issueId, labelId })),
          );
          const res = await tx.issueLabel.createMany({
            data,
            skipDuplicates: true,
          });
          added = res.count;
        }

        // Chunk audit+event writes so large selections don't blow up a
        // single tx or block other writers for too long.
        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-set-labels",
              after: { add: input.add, remove: input.remove },
              eventKind: EventKind.ISSUE_UPDATED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { add: input.add, remove: input.remove },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: validIds.length, added, removed };
      });
    }),

  /**
   * Bulk human assignment — sets `Issue.claimedById` (the single-user
   * claim field) on every selected issue. `null` releases the claim.
   * Writes ISSUE_ASSIGNED audit+event per issue.
   */
  /**
   * Bulk move issues to a project (or clear it with `projectId: null`).
   * Mirrors `bulkAssign`: validates the target lives in the workspace,
   * updates only the rows that resolve, and emits one `ISSUE_UPDATED`
   * per moved issue so boards / inbox / activity stay in sync.
   */
  bulkSetProject: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        projectId: z.string().cuid().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) return { updated: 0 };
      if (input.projectId) {
        const proj = await ctx.db.project.findFirst({
          where: { id: input.projectId, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (!proj) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Project not found in this workspace.",
          });
        }
      }
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: { id: { in: input.issueIds }, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };
        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: { projectId: input.projectId },
        });
        for (const issueId of validIds) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issueId,
            action: "bulk-set-project",
            after: { projectId: input.projectId },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: issueId,
            payload: { projectId: input.projectId },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        return { updated: validIds.length };
      });
    }),

  /**
   * Bulk move issues to a sprint/cycle (or remove with `cycleId: null`).
   * Same shape as `bulkSetProject`.
   */
  bulkSetCycle: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        cycleId: z.string().cuid().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) return { updated: 0 };
      if (input.cycleId) {
        const cyc = await ctx.db.cycle.findFirst({
          where: { id: input.cycleId, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (!cyc) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Sprint not found in this workspace.",
          });
        }
      }
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: { id: { in: input.issueIds }, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };
        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: { cycleId: input.cycleId },
        });
        for (const issueId of validIds) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issueId,
            action: "bulk-set-cycle",
            after: { cycleId: input.cycleId },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: issueId,
            payload: { cycleId: input.cycleId },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        return { updated: validIds.length };
      });
    }),

  bulkAssign: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        claimedById: z.string().cuid().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) {
        return { updated: 0 };
      }
      // Cross-tenant guard: claimedById must be a workspace member when set.
      if (input.claimedById) {
        const member = await ctx.db.membership.findFirst({
          where: {
            userId: input.claimedById,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!member) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "User is not a member of this workspace.",
          });
        }
      }

      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.issueIds },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };

        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: {
            claimedById: input.claimedById,
            // Clearing the claim also clears timestamps; setting a new
            // owner refreshes the claim start time.
            claimedAt: input.claimedById ? new Date() : null,
            claimExpiresAt: null,
          },
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-assign",
              after: { claimedById: input.claimedById },
              eventKind: EventKind.ISSUE_ASSIGNED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { claimedById: input.claimedById },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: validIds.length };
      });
    }),

  /**
   * Bulk agent assignment — sets `Issue.assignedAgentId` on every
   * selected issue. `null` releases. Writes AGENT_ASSIGNED per issue,
   * which feeds the existing agent-dispatch webhook fan-out in
   * `recordChange()`.
   */
  bulkAssignAgent: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        assignedAgentId: agentIdSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) {
        return { updated: 0 };
      }
      if (input.assignedAgentId) {
        const agent = await ctx.db.agent.findFirst({
          where: {
            id: input.assignedAgentId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!agent) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Agent not found in this workspace.",
          });
        }
      }

      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.issueIds },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, assignedAgentId: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };

        // Resolve the bulk-set agent's profileKey once for the
        // dispatchReason stamp (only when assigning, not on clear).
        let agentProfileKey: string | null = null;
        if (input.assignedAgentId) {
          const a = await tx.agent.findUnique({
            where: { id: input.assignedAgentId },
            select: { profileKey: true },
          });
          agentProfileKey = a?.profileKey ?? null;
        }

        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: {
            assignedAgentId: input.assignedAgentId,
            ...(input.assignedAgentId ? {} : { dispatchReason: Prisma.JsonNull }),
          },
        });

        // Per-issue dispatchReason stamp (auto-dispatch sets it
        // per-row; mirror that for manual bulk assignment so
        // attribution stays consistent regardless of code path).
        let manualReason: Prisma.InputJsonObject | null = null;
        if (input.assignedAgentId && agentProfileKey) {
          for (const row of issues) {
            manualReason = await recordManualDispatchReason(tx, {
              issueId: row.id,
              agentProfileKey,
              actorId: ctx.session.user.id,
            });
          }
        }

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = issues.slice(i, i + CHUNK);
          for (const row of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: row.id,
              action: "assign-agent",
              before: { assignedAgentId: row.assignedAgentId },
              after: { assignedAgentId: input.assignedAgentId },
              eventKind: EventKind.AGENT_ASSIGNED,
              subjectType: "issue",
              subjectId: row.id,
              payload: {
                agentId: input.assignedAgentId,
                previousAgentId: row.assignedAgentId,
                ...(manualReason ? { dispatchReason: manualReason } : {}),
              },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: validIds.length };
      });
    }),

  setQueued: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), queued: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirstOrThrow({
          where: { id: input.id, workspaceId: ctx.workspaceId },
        });
        const updated = await tx.issue.update({
          where: { id: issue.id },
          data: {
            queued: input.queued,
            // Releasing from queue while claimed leaves the claim intact (agent still owns it).
            ...(!input.queued && issue.claimedAt == null
              ? { claimedAt: null, claimedById: null, claimExpiresAt: null }
              : {}),
          },
        });
        // Emit ISSUE_QUEUED only on the off -> on transition so repeated
        // setQueued(true) calls don't spam agent webhooks. This event is
        // domain-specific; generic ISSUE_UPDATED subscribers are unaffected.
        if (input.queued && !issue.queued) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "queue",
            before: { queued: issue.queued },
            after: { queued: true },
            eventKind: EventKind.ISSUE_QUEUED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              number: issue.number,
              assignedAgentId: issue.assignedAgentId,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        await maybeAutoDispatch(tx, issue.id);
        return updated;
      });
    }),

  release: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.issue.update({
        where: { id: issue.id },
        data: { claimedAt: null, claimedById: null, claimExpiresAt: null },
      });
    }),

  queue: workspaceProcedure
    .input(
      z.object({
        includeClaimed: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const keyWhere = buildKeyScopeWhere(ctx, "issue");
      const rows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          ...keyWhere,
          ...(input.includeClaimed ? {} : { claimedAt: null }),
        },
        orderBy: [{ claimedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
        take: input.limit,
        include: {
          status: true,
          project: { select: { id: true, name: true, key: true, color: true } },
          claimedBy: { select: { id: true, name: true, email: true, image: true } },
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              status: true,
              provider: true,
              runtimeMode: true,
              lastHeartbeatAt: true,
              webhookUrl: true,
              runtimeId: true,
            },
          },
        },
      });
      return annotateUnblocked(ctx, rows);
    }),

  /**
   * Claim an issue for this user (or for the API key's linked user).
   *
   * - If `issueId` is omitted, pick the highest-priority, oldest-queued,
   *   unclaimed, unblocked issue that respects any active ApiKey narrowing.
   * - If `issueId` is provided, validate the key scope and claim it.
   * An issue is "blocked" when any incoming BLOCKED_BY (or outgoing BLOCKS
   * where it's the `fromIssue`) relation points to another issue whose
   * status category is not DONE or CANCELED.
   */
  claim: workspaceProcedure
    .input(
      z
        .object({
          issueId: z.string().cuid().optional(),
          claimTtlMinutes: z.number().int().min(1).max(1440).default(60),
        })
        .default({}),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const expiresAt = new Date(Date.now() + input.claimTtlMinutes * 60_000);

      if (input.issueId) {
        await assertKeyScope(ctx, { entity: "issue", id: input.issueId });
        return ctx.db.$transaction(async (tx) => {
          const issue = await tx.issue.findFirstOrThrow({
            where: {
              id: input.issueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
          });
          if (issue.claimedAt && issue.claimedById !== userId) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Issue already claimed by another agent.",
            });
          }
          return tx.issue.update({
            where: { id: issue.id },
            data: {
              claimedById: userId,
              claimedAt: new Date(),
              claimExpiresAt: expiresAt,
            },
            include: { status: true },
          });
        });
      }

      // Agent "give me something to work on" flow — scan the queue for an
      // unclaimed, unblocked candidate.
      const keyWhere = buildKeyScopeWhere(ctx, "issue");
      const blockedIds = await findBlockedIssueIds(ctx);
      const candidate = await ctx.db.issue.findFirst({
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
      if (!candidate) return { claimed: null } as const;
      const updated = await ctx.db.issue.update({
        where: { id: candidate.id },
        data: {
          claimedById: userId,
          claimedAt: new Date(),
          claimExpiresAt: expiresAt,
        },
        include: { status: true, project: true },
      });
      return { claimed: updated };
    }),

  /**
   * Prev/next sibling lookup for the issue-detail keyboard nav (`[` / `]`).
   * Siblings share the issue's project (when scope = "project") or its
   * cycle (when scope = "cycle"); ordered by issue number ascending so
   * the chevron walk reads in the natural identifier order
   * (AXI-41 → AXI-42 → AXI-43). Soft-deleted issues are excluded on both
   * sides. Returns `null` for either end when none exists. Tenant-scoped:
   * a member can't peek into siblings of a different workspace.
   *
   * Why number, not createdAt: number is monotonic per workspace and is
   * the visible identifier — users who hit `]` expect "the next one in
   * the list" to match the issue key sequence they already see.
   * `issue.list` orders by priority/createdAt for the queue surface, but
   * a detail-page keyboard walk wants identifier order.
   */
  siblings: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        scope: z.enum(["project", "cycle"]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const current = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: {
          id: true,
          number: true,
          projectId: true,
          cycleId: true,
        },
      });
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });

      const scopeWhere =
        input.scope === "project"
          ? { projectId: current.projectId ?? null }
          : { cycleId: current.cycleId ?? null };

      const baseWhere = {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        ...scopeWhere,
      } as const;

      const [prev, next] = await Promise.all([
        ctx.db.issue.findFirst({
          where: { ...baseWhere, number: { lt: current.number } },
          orderBy: { number: "desc" },
          select: { id: true, number: true, title: true, workspace: { select: { key: true } } },
        }),
        ctx.db.issue.findFirst({
          where: { ...baseWhere, number: { gt: current.number } },
          orderBy: { number: "asc" },
          select: { id: true, number: true, title: true, workspace: { select: { key: true } } },
        }),
      ]);

      const shape = (
        row: { id: string; number: number; title: string; workspace: { key: string } } | null,
      ) =>
        row
          ? {
              id: row.id,
              key: `${row.workspace.key}-${row.number}`,
              title: row.title,
            }
          : null;

      return { prev: shape(prev), next: shape(next) };
    }),

  /**
   * Snooze an issue until the given timestamp. While `snoozedUntil` is
   * in the future, inbox + stalled buckets exclude the row (the operator
   * has explicitly asked the system to stop nagging them). Settings-
   * driven consumers (issue.list with `excludeSnoozed: true`) honor the
   * same gate. Snoozing past now is rejected — the front-end is
   * expected to provide a future date.
   */
  snooze: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        until: z.coerce.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.until.getTime() <= Date.now()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "snoozedUntil must be a future timestamp.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.issue.findFirstOrThrow({
          where: {
            id: input.id,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, snoozedUntil: true },
        });
        const updated = await tx.issue.update({
          where: { id: before.id },
          data: { snoozedUntil: input.until },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: before.id,
          action: "snooze",
          before: { snoozedUntil: before.snoozedUntil },
          after: { snoozedUntil: input.until },
          eventKind: EventKind.ISSUE_SNOOZED,
          subjectType: "issue",
          subjectId: before.id,
          payload: { until: input.until.toISOString() },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    }),

  /**
   * Clear the snooze flag on an issue, returning it to the inbox /
   * stalled buckets. No-op when the issue isn't currently snoozed
   * (still emits ISSUE_UNSNOOZED so the activity stream reads cleanly).
   */
  unsnooze: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.issue.findFirstOrThrow({
          where: {
            id: input.id,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, snoozedUntil: true },
        });
        const updated = await tx.issue.update({
          where: { id: before.id },
          data: { snoozedUntil: null },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: before.id,
          action: "unsnooze",
          before: { snoozedUntil: before.snoozedUntil },
          after: { snoozedUntil: null },
          eventKind: EventKind.ISSUE_UNSNOOZED,
          subjectType: "issue",
          subjectId: before.id,
          payload: {
            previousSnoozedUntil: before.snoozedUntil?.toISOString() ?? null,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    }),

  /**
   * Bulk snooze — sets `snoozedUntil` on every selected issue. `until: null`
   * clears the snooze (equivalent to calling `unsnooze` for each id). Used
   * by the inbox bulk-action toolbar so the operator can snooze a whole
   * selection without firing N round-trips.
   *
   * Audit + ISSUE_SNOOZED / ISSUE_UNSNOOZED events are written per issue so
   * downstream consumers (activity stream, webhook bus) treat each row as
   * a discrete snooze — same shape as the singleton `snooze` / `unsnooze`.
   */
  snoozeMany: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).min(1).max(200),
        until: z.coerce.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.until && input.until.getTime() <= Date.now()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "snoozedUntil must be a future timestamp.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const rows = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, snoozedUntil: true },
        });
        const validIds = rows.map((r) => r.id);
        if (validIds.length === 0) return { updated: 0 };

        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: { snoozedUntil: input.until },
        });

        for (const row of rows) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: row.id,
            action: input.until ? "snooze" : "unsnooze",
            before: { snoozedUntil: row.snoozedUntil },
            after: { snoozedUntil: input.until },
            eventKind: input.until
              ? EventKind.ISSUE_SNOOZED
              : EventKind.ISSUE_UNSNOOZED,
            subjectType: "issue",
            subjectId: row.id,
            payload: input.until
              ? { until: input.until.toISOString() }
              : {
                  previousSnoozedUntil: row.snoozedUntil?.toISOString() ?? null,
                },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        return { updated: validIds.length };
      });
    }),

  /**
   * "Gentle nudge" — appends a comment to the issue tagging the
   * assigned agent (when present), which the existing comment fan-out
   * routes to the agent's webhookUrl as a COMMENT_CREATED with a
   * `mentions` array. Default body cites the days-since-update so the
   * agent has context. We piggy-back on comment.create's plumbing
   * (mention resolution, audit fan-out) rather than duplicate it.
   *
   * Per Phase 0 brief: nudge does NOT add a separate webhook event —
   * comment fan-out already reaches the assigned agent.
   */
  nudge: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        body: z.string().min(1).max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirstOrThrow({
          where: {
            id: input.id,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: {
            id: true,
            updatedAt: true,
            assignedAgent: { select: { id: true, profileKey: true } },
          },
        });
        const daysSince = Math.max(
          1,
          Math.round(
            (Date.now() - issue.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
          ),
        );
        const mention = issue.assignedAgent
          ? `@${issue.assignedAgent.profileKey} `
          : "";
        const body =
          input.body ??
          `${mention}Gentle nudge — this issue has been quiet for ${daysSince} day${daysSince === 1 ? "" : "s"}.`;

        const comment = await tx.comment.create({
          data: {
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            authorId: ctx.session.user.id,
            body,
          },
        });

        // Build the mentions array the same way comment.create does so
        // the audit fan-out branch (c) routes to the assigned agent's
        // webhook. We only auto-mention the assigned agent here; if
        // the operator wrote a custom body with explicit @mentions
        // they'll be picked up by comment.create's normal flow next
        // time — for nudge we keep it predictable.
        const mentions = issue.assignedAgent
          ? [
              {
                agentId: issue.assignedAgent.id,
                profileKey: issue.assignedAgent.profileKey,
              },
            ]
          : [];

        // Both events fire: COMMENT_CREATED (so the comment shows up
        // in the activity stream + reaches the agent's webhook) and
        // ISSUE_NUDGED (so consumers can distinguish a nudge from a
        // freeform comment without parsing the body).
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Comment",
          entityId: comment.id,
          action: "create",
          after: comment,
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            commentId: comment.id,
            issueId: issue.id,
            preview: body.slice(0, 120),
            mentions,
            isNudge: true,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: issue.id,
          action: "nudge",
          eventKind: EventKind.ISSUE_NUDGED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            commentId: comment.id,
            daysSinceUpdate: daysSince,
            agentId: issue.assignedAgent?.id ?? null,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return { ok: true, commentId: comment.id, daysSinceUpdate: daysSince };
      });
    }),

  /**
   * Bulk status transition. Distinct from the legacy `bulkStatus`
   * (which is a thin `updateMany` with no audit/event side effects).
   * Fires `recordChange(ISSUE_STATUS_CHANGED)` per row so subscribers
   * (webhooks, dispatch escalation, agent run lifecycle) react the
   * same way they would for single-issue transitions. Honors
   * lifecycle timestamps (`startedAt`, `completedAt`, `canceledAt`)
   * based on the destination category, mirroring the single-issue
   * `update` proc.
   */
  bulkTransition: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).max(500),
        statusId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0 };
      // Tenant-scope guard for the destination status.
      const status = await ctx.db.status.findFirst({
        where: { id: input.statusId, workspaceId: ctx.workspaceId },
        select: { id: true, category: true },
      });
      if (!status) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Status not found in this workspace.",
        });
      }

      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: {
            id: true,
            statusId: true,
            startedAt: true,
            completedAt: true,
            canceledAt: true,
          },
        });
        // Skip rows already in this status — no-op transitions shouldn't
        // emit audit/event noise.
        const moving = issues.filter((i) => i.statusId !== input.statusId);
        if (moving.length === 0) return { updated: 0 };

        const lifecyclePatch: {
          startedAt?: Date | null;
          completedAt?: Date | null;
          canceledAt?: Date | null;
        } = {};
        // For DONE/CANCELED, set the appropriate stamp. Per-row branch:
        // updateMany doesn't support per-row conditional writes for
        // startedAt (only set when null), so we apply it row-by-row in
        // the audit loop and use updateMany only for the constant fields.
        if (status.category === "DONE") lifecyclePatch.completedAt = new Date();
        if (status.category === "CANCELED") lifecyclePatch.canceledAt = new Date();
        if (status.category !== "DONE") lifecyclePatch.completedAt = null;
        if (status.category !== "CANCELED") lifecyclePatch.canceledAt = null;

        await tx.issue.updateMany({
          where: { id: { in: moving.map((i) => i.id) }, workspaceId: ctx.workspaceId },
          data: { statusId: input.statusId, ...lifecyclePatch },
        });

        // startedAt is conditional ("only set when null") — handled per
        // row so we don't reset an already-running issue's clock.
        if (status.category === "IN_PROGRESS") {
          for (const row of moving) {
            if (!row.startedAt) {
              await tx.issue.update({
                where: { id: row.id },
                data: { startedAt: new Date() },
              });
            }
          }
        }

        const CHUNK = 50;
        for (let i = 0; i < moving.length; i += CHUNK) {
          const chunk = moving.slice(i, i + CHUNK);
          for (const row of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: row.id,
              action: "bulk-transition",
              before: { statusId: row.statusId },
              after: { statusId: input.statusId },
              eventKind: EventKind.ISSUE_STATUS_CHANGED,
              subjectType: "issue",
              subjectId: row.id,
              payload: {
                statusId: input.statusId,
                previousStatusId: row.statusId,
              },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: moving.length };
      });
    }),

  /**
   * Bulk add a single label to many issues. Idempotent — issues that
   * already carry the label are skipped (composite @@id on IssueLabel
   * + skipDuplicates). Fires ISSUE_UPDATED audit per row; we don't
   * have a dedicated `ISSUE_LABEL_ADDED` enum value, so subscribers
   * key off the action="bulk-add-label" + payload.labelId pair, same
   * as `bulkSetLabels` does.
   */
  bulkAddLabel: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).max(500),
        labelId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0, added: 0 };
      const label = await ctx.db.label.findFirst({
        where: { id: input.labelId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!label) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Label not found in this workspace.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0, added: 0 };

        const res = await tx.issueLabel.createMany({
          data: validIds.map((issueId) => ({ issueId, labelId: input.labelId })),
          skipDuplicates: true,
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-add-label",
              after: { labelId: input.labelId },
              eventKind: EventKind.ISSUE_UPDATED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { labelId: input.labelId, op: "add" },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }
        return { updated: validIds.length, added: res.count };
      });
    }),

  /**
   * Bulk remove a single label from many issues. Mirror of
   * `bulkAddLabel` for the inverse operation.
   */
  bulkRemoveLabel: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).max(500),
        labelId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0, removed: 0 };
      const label = await ctx.db.label.findFirst({
        where: { id: input.labelId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!label) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Label not found in this workspace.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0, removed: 0 };

        const res = await tx.issueLabel.deleteMany({
          where: {
            issueId: { in: validIds },
            labelId: input.labelId,
          },
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-remove-label",
              before: { labelId: input.labelId },
              eventKind: EventKind.ISSUE_UPDATED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { labelId: input.labelId, op: "remove" },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }
        return { updated: validIds.length, removed: res.count };
      });
    }),

  /**
   * Bulk archive (soft-delete) many issues. The Issue schema uses
   * `deletedAt` for soft-delete (no `archivedAt` column on Issue), so
   * "archive" here is the same column the single-issue `softDelete`
   * proc writes to. Per-row ISSUE_DELETED audit fires so subscribers
   * downstream see each issue go away independently.
   */
  bulkArchive: workspaceProcedure
    .input(z.object({ ids: z.array(z.string().cuid()).max(500) }))
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0 };
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };

        const now = new Date();
        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: { deletedAt: now },
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-archive",
              after: { deletedAt: now },
              eventKind: EventKind.ISSUE_DELETED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { archivedAt: now.toISOString() },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }
        return { updated: validIds.length };
      });
    }),

  // ----------------------------------------------------- Slash commands apply
  /**
   * Apply a list of slash commands to an existing issue. Used by the
   * comment composer (parses leading slash lines, posts the cleaned
   * body, then calls this for the commands). Each command is
   * best-effort — failures log a skip but don't fail the call.
   * Returns the structured outcome so the UI can surface skips.
   */
  applyCommands: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        commands: z.array(slashCommandSchema).max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!issue) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found." });
      }
      const results = await applySlashCommandsToIssue({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        issueId: input.issueId,
        actorId: ctx.session.user.id,
        callerAgentId: ctx.apiKey?.linkedAgentId ?? null,
        commands: input.commands,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { results };
    }),

  // ----------------------------------------------------------------- Watching
  // Per-(issue, user OR agent) subscription. Watch and Pin are
  // orthogonal — pin is a UI shortcut, watch is event subscription.
  // Watchers receive event fan-out via the per-agent dispatch shim
  // (agents) or via the inbox/notification surface (humans). The
  // actor of an event is filtered out of fan-out so people don't get
  // pinged for their own moves.

  /**
   * Add the caller as a watcher of `issueId`. Idempotent — calling
   * twice is a no-op. When the call is via an API key linked to an
   * agent, the row is agent-scoped; otherwise it's user-scoped.
   */
  watch: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!issue) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found." });
      }
      const callerAgentId = ctx.apiKey?.linkedAgentId ?? null;
      if (callerAgentId) {
        return ctx.db.issueWatcher.upsert({
          where: { issueId_agentId: { issueId: input.issueId, agentId: callerAgentId } },
          create: {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId: callerAgentId,
          },
          update: {},
        });
      }
      return ctx.db.issueWatcher.upsert({
        where: {
          issueId_userId: { issueId: input.issueId, userId: ctx.session.user.id },
        },
        create: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          userId: ctx.session.user.id,
        },
        update: {},
      });
    }),

  /**
   * Remove the caller's watch on `issueId`. No-op if they weren't
   * watching. Returns `{ ok: true }` either way.
   */
  unwatch: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const callerAgentId = ctx.apiKey?.linkedAgentId ?? null;
      if (callerAgentId) {
        await ctx.db.issueWatcher.deleteMany({
          where: { issueId: input.issueId, agentId: callerAgentId },
        });
      } else {
        await ctx.db.issueWatcher.deleteMany({
          where: { issueId: input.issueId, userId: ctx.session.user.id },
        });
      }
      return { ok: true as const };
    }),

  /**
   * List watchers for an issue. Returns `user` + `agent` identity
   * fields so the UI can render a tooltip of names without an extra
   * round-trip. Read-only for any workspace member.
   */
  watchers: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.issueWatcher.findMany({
        where: { issueId: input.issueId, workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "asc" },
        include: {
          user: { select: { id: true, name: true, handle: true, image: true } },
          agent: { select: { id: true, profileKey: true, name: true, avatar: true } },
        },
      });
      return { items: rows };
    }),

  /**
   * Issues the caller is currently watching. Defaults to the latest
   * `limit` rows ordered by issue.updatedAt desc, so the inbox
   * "Watching" tab can show fresh activity at the top.
   */
  watching: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const callerAgentId = ctx.apiKey?.linkedAgentId ?? null;
      const where: Prisma.IssueWatcherWhereInput = callerAgentId
        ? { workspaceId: ctx.workspaceId, agentId: callerAgentId }
        : { workspaceId: ctx.workspaceId, userId: ctx.session.user.id };
      const rows = await ctx.db.issueWatcher.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: input.limit,
        include: {
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              priority: true,
              updatedAt: true,
              snoozedUntil: true,
              status: { select: { id: true, name: true, color: true, category: true } },
              project: { select: { id: true, name: true, key: true } },
              assignedAgent: { select: { id: true, profileKey: true, name: true, avatar: true } },
            },
          },
        },
      });
      // Filter out issues that have been soft-deleted; sort by issue
      // updatedAt desc so most-recently-active rises to the top.
      const items = rows
        .filter((r) => r.issue !== null)
        .map((r) => ({
          watchId: r.id,
          createdAt: r.createdAt,
          issue: r.issue!,
        }));
      items.sort(
        (a, b) =>
          new Date(b.issue.updatedAt).getTime() -
          new Date(a.issue.updatedAt).getTime(),
      );
      return { items };
    }),

  /**
   * "Unread" issue ids — issues the caller is watching that have had
   * activity since the caller last viewed them.
   *
   * "Last viewed" is the `RecentItem.visitedAt` row written by
   * `recentItem.track`, which the issue-detail page upserts on mount.
   * An issue with no RecentItem row is treated as never-viewed and
   * therefore unread (any update — including the original creation —
   * surfaces a dot).
   *
   * Activity definition is intentionally cheap: `Issue.updatedAt`
   * advances on title / description / status / assignee / label
   * changes, and `recordChange()` bumps it via the audit transaction
   * for comments and watcher events too — so a single timestamp
   * compare suffices for v1. If a user authors the change themselves
   * we filter that out client-side by toasting nothing; the dot is
   * harmless because the user is about to view the issue anyway when
   * they click into it (which clears the unread state).
   *
   * Returns an unwrapped `string[]` of issue ids for cheap `Set`
   * construction on the client. Empty array when the user watches
   * nothing.
   */
  unreadIds: workspaceProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const watches = await ctx.db.issueWatcher.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
        select: {
          issueId: true,
          issue: { select: { id: true, updatedAt: true, deletedAt: true } },
        },
      });
      if (watches.length === 0) return { ids: [] as string[] };

      const watchedIds = watches
        .filter((w) => w.issue && w.issue.deletedAt === null)
        .map((w) => w.issueId);
      if (watchedIds.length === 0) return { ids: [] as string[] };

      // Pull the user's `RecentItem.visitedAt` for each watched issue
      // in one query. Missing rows = never-viewed = always unread.
      const recents = await ctx.db.recentItem.findMany({
        where: {
          userId: ctx.session.user.id,
          workspaceId: ctx.workspaceId,
          targetType: "ISSUE",
          targetId: { in: watchedIds },
        },
        select: { targetId: true, visitedAt: true },
      });
      const visitedAtByIssue = new Map<string, Date>();
      for (const r of recents) {
        visitedAtByIssue.set(r.targetId, r.visitedAt);
      }

      const ids: string[] = [];
      for (const w of watches) {
        if (!w.issue || w.issue.deletedAt !== null) continue;
        const visitedAt = visitedAtByIssue.get(w.issueId);
        if (!visitedAt) {
          ids.push(w.issueId);
          continue;
        }
        if (w.issue.updatedAt.getTime() > visitedAt.getTime()) {
          ids.push(w.issueId);
        }
      }
      return { ids };
    }),
});

// -- Helpers ----------------------------------------------------------------

type IssueRow = { id: string };

/**
 * Return the set of issue ids in `ctx.workspaceId` that are blocked by at
 * least one non-completed dependency. Computed in one query so callers can
 * exclude via `id: { notIn: [...] }` without iterating.
 */
async function findBlockedIssueIds(ctx: {
  db: PrismaClient;
  workspaceId: string;
}): Promise<Set<string>> {
  // Row shape written by `relation.add`:
  //   BLOCKS     : from = blocker, to = blocked
  //   BLOCKED_BY : from = blocked, to = blocker
  // An issue is blocked iff at least one of its blockers is still open
  // (status category not in DONE/CANCELED).
  const blockers = await ctx.db.issueRelation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      OR: [
        {
          kind: RelationKind.BLOCKS,
          fromIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
        {
          kind: RelationKind.BLOCKED_BY,
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
    if (r.kind === RelationKind.BLOCKS) ids.add(r.toIssueId);
    if (r.kind === RelationKind.BLOCKED_BY) ids.add(r.fromIssueId);
  }
  return ids;
}

/**
 * Attach an `unblocked` boolean to a batch of issues. Used in agent-facing
 * surfaces (queue, list) so the UI can render a shield indicator without
 * re-fetching the relation graph.
 */
async function annotateUnblocked<T extends IssueRow>(
  ctx: { db: PrismaClient; workspaceId: string },
  rows: T[],
): Promise<Array<T & { unblocked: boolean }>> {
  if (!rows.length) return [];
  const blocked = await findBlockedIssueIds(ctx);
  return rows.map((r) => ({ ...r, unblocked: !blocked.has(r.id) }));
}
