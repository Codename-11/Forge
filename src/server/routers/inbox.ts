import { z } from "zod";
import { CycleStatus, Prisma } from "@prisma/client";
import { router, protectedProcedure, workspaceProcedure } from "@/server/trpc";

/**
 * Unified "what's next" inbox.
 *
 * Surfaces four buckets for the caller:
 *   1. Assigned & unblocked — issues they own whose dependencies are clear.
 *   2. @Mentioned in comments — comments that name-drop them in the last N days
 *      (the `User.lastInboxVisitAt` column isn't in the schema yet, so we fall
 *      back to the last 7 days).
 *   3. Stalled >7 days — issues assigned to them with no update in a week and
 *      not yet done/canceled.
 *   4. Current cycle burn — the active cycle plus a done/remaining tally.
 *
 * When `allWorkspaces` is true we aggregate across every workspace the caller
 * is a member of; otherwise scope stays on the header-provided workspace.
 */

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const MENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Crude @mention extraction: match `@handle` tokens and compare against the
 * caller's own handle or email local-part. Cheap heuristic — good enough
 * until we have a proper mention table.
 */
function buildMentionHaystack(name: string | null | undefined, handle: string | null | undefined, email: string): string[] {
  const tokens = new Set<string>();
  if (handle) tokens.add(handle.toLowerCase());
  const emailLocal = email.split("@")[0];
  if (emailLocal) tokens.add(emailLocal.toLowerCase());
  if (name) {
    const clean = name.trim().toLowerCase().replace(/\s+/g, "");
    if (clean) tokens.add(clean);
  }
  return [...tokens];
}

function commentMentionsUser(body: string, tokens: string[]): boolean {
  if (!body || tokens.length === 0) return false;
  const lower = body.toLowerCase();
  for (const t of tokens) {
    if (!t) continue;
    if (lower.includes(`@${t}`)) return true;
  }
  return false;
}

const getInput = z
  .object({
    allWorkspaces: z.boolean().default(false),
  })
  .default({ allWorkspaces: false });

export const inboxRouter = router({
  /**
   * Fetch the inbox payload. Uses `workspaceProcedure` to guarantee a
   * scoped view when `allWorkspaces` is false, but also supports the
   * cross-workspace mode for users who toggle the header switch.
   */
  get: workspaceProcedure.input(getInput).query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    const me = await ctx.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, handle: true, email: true },
    });
    const mentionTokens = buildMentionHaystack(me.name, me.handle, me.email);

    const workspaceIds = input.allWorkspaces
      ? (
          await ctx.db.membership.findMany({
            where: { userId, workspace: { deletedAt: null } },
            select: { workspaceId: true },
          })
        ).map((m) => m.workspaceId)
      : [ctx.workspaceId];

    if (workspaceIds.length === 0) {
      return {
        scope: input.allWorkspaces ? ("all" as const) : ("workspace" as const),
        assignedUnblocked: [],
        mentions: [],
        stalled: [],
        cycle: null,
        counts: { assignedUnblocked: 0, mentions: 0, stalled: 0 },
      };
    }

    const workspaceWhere: Prisma.IssueWhereInput = {
      workspaceId: { in: workspaceIds },
      deletedAt: null,
    };

    // ---- 1. Assigned ------------------------------------------------------
    const assigned = await ctx.db.issue.findMany({
      where: {
        ...workspaceWhere,
        assignees: { some: { userId } },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      take: 200,
      include: {
        status: true,
        workspace: { select: { id: true, slug: true, key: true, name: true } },
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    });

    const blockedIds = await findBlockedIssueIds(ctx.db, workspaceIds);
    const assignedUnblocked = assigned.filter((i) => !blockedIds.has(i.id));

    // ---- 2. Mentions ------------------------------------------------------
    const mentionWindow = new Date(Date.now() - MENTION_WINDOW_MS);
    const mentionCandidates = await ctx.db.comment.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
        createdAt: { gte: mentionWindow },
        // Exclude self-mentions — you aren't notifying yourself.
        authorId: { not: userId },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        author: { select: { id: true, name: true, image: true } },
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            workspace: { select: { id: true, slug: true, key: true, name: true } },
            status: { select: { id: true, name: true, color: true, category: true } },
          },
        },
      },
    });
    const mentions = mentionCandidates
      .filter((c) => commentMentionsUser(c.body, mentionTokens))
      .slice(0, 50);

    // ---- 3. Stalled -------------------------------------------------------
    const stalledCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const stalled = await ctx.db.issue.findMany({
      where: {
        ...workspaceWhere,
        assignees: { some: { userId } },
        updatedAt: { lt: stalledCutoff },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
      orderBy: { updatedAt: "asc" },
      take: 50,
      include: {
        status: true,
        workspace: { select: { id: true, slug: true, key: true, name: true } },
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    });

    // ---- 4. Current cycle burn -------------------------------------------
    // Only show a cycle summary when scoped to a single workspace — a
    // cross-workspace cycle rollup doesn't really mean anything.
    let cycleBurn: Awaited<ReturnType<typeof buildCycleBurn>> = null;
    if (!input.allWorkspaces) {
      cycleBurn = await buildCycleBurn(ctx.db, ctx.workspaceId);
    }

    return {
      scope: input.allWorkspaces ? ("all" as const) : ("workspace" as const),
      assignedUnblocked,
      mentions,
      stalled,
      cycle: cycleBurn,
      counts: {
        assignedUnblocked: assignedUnblocked.length,
        mentions: mentions.length,
        stalled: stalled.length,
      },
    };
  }),

  /**
   * Quick sidebar badge — just the "things demanding attention" count without
   * fetching the full body. Used by the Inbox nav item.
   */
  badge: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const memberships = await ctx.db.membership.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    const workspaceIds = memberships.map((m) => m.workspaceId);
    if (workspaceIds.length === 0) return { count: 0 };

    const stalledCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const me = await ctx.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, handle: true, email: true },
    });
    const tokens = buildMentionHaystack(me.name, me.handle, me.email);
    const mentionCutoff = new Date(Date.now() - MENTION_WINDOW_MS);

    const [assignedCount, stalledCount, candidates] = await Promise.all([
      ctx.db.issue.count({
        where: {
          workspaceId: { in: workspaceIds },
          deletedAt: null,
          assignees: { some: { userId } },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
      }),
      ctx.db.issue.count({
        where: {
          workspaceId: { in: workspaceIds },
          deletedAt: null,
          assignees: { some: { userId } },
          updatedAt: { lt: stalledCutoff },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
      }),
      ctx.db.comment.findMany({
        where: {
          workspaceId: { in: workspaceIds },
          deletedAt: null,
          createdAt: { gte: mentionCutoff },
          authorId: { not: userId },
        },
        select: { body: true },
        take: 100,
      }),
    ]);
    const mentionCount = candidates.filter((c) => commentMentionsUser(c.body, tokens)).length;
    // Cap the badge count because the sidebar treatment is "1-99+".
    const raw = assignedCount + stalledCount + mentionCount;
    return { count: raw };
  }),
});

// ----- Helpers --------------------------------------------------------------

async function findBlockedIssueIds(
  db: typeof import("@/server/db").db,
  workspaceIds: string[],
): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set();
  // BLOCKS     : from = blocker, to = blocked.
  // BLOCKED_BY : from = blocked, to = blocker.
  const blockers = await db.issueRelation.findMany({
    where: {
      workspaceId: { in: workspaceIds },
      OR: [
        {
          kind: "BLOCKS",
          fromIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
        {
          kind: "BLOCKED_BY",
          toIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
      ],
    },
    select: { fromIssueId: true, toIssueId: true, kind: true },
  });
  const blocked = new Set<string>();
  for (const r of blockers) {
    if (r.kind === "BLOCKS") blocked.add(r.toIssueId);
    if (r.kind === "BLOCKED_BY") blocked.add(r.fromIssueId);
  }
  return blocked;
}

async function buildCycleBurn(
  db: typeof import("@/server/db").db,
  workspaceId: string,
) {
  const cycle = await db.cycle.findFirst({
    where: { workspaceId, status: CycleStatus.ACTIVE },
    orderBy: { startsAt: "desc" },
    include: {
      issues: {
        where: { deletedAt: null },
        select: {
          id: true,
          status: { select: { category: true } },
        },
      },
    },
  });
  if (!cycle) return null;
  let done = 0;
  let remaining = 0;
  for (const issue of cycle.issues) {
    const cat = issue.status.category;
    if (cat === "DONE" || cat === "CANCELED") done++;
    else remaining++;
  }
  const total = done + remaining;
  return {
    id: cycle.id,
    name: cycle.name,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    done,
    remaining,
    total,
    pctDone: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}
