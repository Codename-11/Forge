import { z } from "zod";
import { CycleStatus, type Prisma } from "@prisma/client";
import { router, protectedProcedure, workspaceProcedure } from "@/server/trpc";

/**
 * Unified "what's next" inbox.
 *
 * Surfaces several buckets for the caller:
 *   1. Assigned & unblocked — issues they own whose dependencies are clear.
 *   2. @Mentioned in comments — comments that name-drop them in the last
 *      `MENTION_WINDOW_MS`.
 *   3. Stalled — issues with no update in `Workspace.stalledThresholdDays`
 *      days. Split into:
 *        - `humanStalled` : the calling user is an assignee.
 *        - `agentStalled` : the issue has an assignedAgent and the agent
 *                           has been silent past threshold (regardless of
 *                           whether the caller is also a human assignee).
 *        - `stalled`      : preserved for legacy consumers; equal to the
 *                           union of the two split buckets.
 *   4. Snoozed — issues the caller is an assignee on, currently snoozed
 *      (snoozedUntil > now). Lets the UI render a collapsed section.
 *   5. Current cycle burn — the active cycle plus a done/remaining tally.
 *
 * Per-bucket `unreadSinceVisit` counts items whose `updatedAt` is greater
 * than `User.lastInboxVisitAt`. Drives the "new since last visit" badging
 * the Phase 1B inbox uses. `inbox.visit` bumps the timestamp.
 *
 * Snoozed issues are filtered out of `assigned*`, `humanStalled`, and
 * `agentStalled` — they only appear in the dedicated `snoozed` bucket.
 *
 * When `allWorkspaces` is true we aggregate across every workspace the
 * caller is a member of; otherwise scope stays on the header-provided
 * workspace. The `stalledThresholdDays` knob is read from the *current*
 * workspace; for the all-workspaces aggregate we fall back to the same
 * value (consistent with how the UI scopes the threshold control).
 */

const MENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * `inbox.visit` debounces server-side. Two visits within this many ms of
 * each other are coalesced (no DB write on the second). Keeps the page
 * focus / refresh story cheap without hammering the User row.
 */
const VISIT_DEBOUNCE_MS = 5 * 1000;

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
      select: {
        id: true,
        name: true,
        handle: true,
        email: true,
        lastInboxVisitAt: true,
      },
    });
    const mentionTokens = buildMentionHaystack(me.name, me.handle, me.email);
    const lastVisitAt = me.lastInboxVisitAt;

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
        humanStalled: [],
        agentStalled: [],
        snoozed: [],
        cycle: null,
        counts: {
          assignedUnblocked: 0,
          mentions: 0,
          stalled: 0,
          humanStalled: 0,
          agentStalled: 0,
          snoozed: 0,
        },
        unreadSinceVisit: {
          assignedUnblocked: 0,
          mentions: 0,
          stalled: 0,
          humanStalled: 0,
          agentStalled: 0,
        },
        lastVisitAt,
        stalledThresholdDays: 0,
      };
    }

    // Pull the caller's "current" workspace for the threshold knob. In
    // all-workspaces mode the threshold from `ctx.workspaceId` is used
    // for every workspace — the threshold is a UX preference, not a
    // hard isolation boundary, so this is acceptable v1.
    const ws = await ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { stalledThresholdDays: true },
    });
    const stalledThresholdDays = ws.stalledThresholdDays;

    const now = new Date();
    // Reusable "not snoozed" predicate for any bucket that should hide
    // on-hold issues. Postgres treats nulls correctly with `OR is null`.
    const notSnoozed: Prisma.IssueWhereInput = {
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    };

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
        ...notSnoozed,
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

    // ---- 3. Stalled (split) ---------------------------------------------
    // Settings-driven threshold (Workspace.stalledThresholdDays). 0
    // disables the bucket entirely.
    let humanStalled: typeof assigned = [];
    let agentStalled: typeof assigned = [];
    if (stalledThresholdDays > 0) {
      const stalledCutoff = new Date(
        Date.now() - stalledThresholdDays * 24 * 60 * 60 * 1000,
      );
      // humanStalled: issues with at least one human assignee that
      // includes the calling user (back-compat semantic) and which are
      // older than the threshold. Snoozed rows excluded.
      humanStalled = await ctx.db.issue.findMany({
        where: {
          ...workspaceWhere,
          assignees: { some: { userId } },
          updatedAt: { lt: stalledCutoff },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
          ...notSnoozed,
        },
        orderBy: { updatedAt: "asc" },
        take: 50,
        include: {
          status: true,
          workspace: { select: { id: true, slug: true, key: true, name: true } },
          project: { select: { id: true, key: true, name: true, color: true } },
        },
      });
      // agentStalled: assignedAgentId is set and the issue has been
      // quiet past the threshold. We don't gate on the calling user
      // being a human assignee here — agent-owned stalls are a team
      // signal regardless of who's watching. Phase 1B can scope further
      // (e.g. "only agents in projects I'm watching") if needed.
      agentStalled = await ctx.db.issue.findMany({
        where: {
          ...workspaceWhere,
          assignedAgentId: { not: null },
          updatedAt: { lt: stalledCutoff },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
          ...notSnoozed,
        },
        orderBy: { updatedAt: "asc" },
        take: 50,
        include: {
          status: true,
          workspace: { select: { id: true, slug: true, key: true, name: true } },
          project: { select: { id: true, key: true, name: true, color: true } },
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
            },
          },
        },
      });
    }
    // `stalled` (legacy field) = union, oldest-first, deduped. Kept so
    // existing consumers don't break when the buckets split. Phase 1B
    // will switch to humanStalled / agentStalled directly.
    const stalledMap = new Map<string, (typeof humanStalled)[number]>();
    for (const r of humanStalled) stalledMap.set(r.id, r);
    for (const r of agentStalled) {
      if (!stalledMap.has(r.id)) {
        stalledMap.set(r.id, r as unknown as (typeof humanStalled)[number]);
      }
    }
    const stalled = Array.from(stalledMap.values()).sort(
      (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime(),
    );

    // ---- 4. Snoozed (caller as assignee) ---------------------------------
    const snoozed = await ctx.db.issue.findMany({
      where: {
        ...workspaceWhere,
        assignees: { some: { userId } },
        snoozedUntil: { gt: now },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
      orderBy: { snoozedUntil: "asc" },
      take: 50,
      include: {
        status: true,
        workspace: { select: { id: true, slug: true, key: true, name: true } },
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    });

    // ---- 5. Current cycle burn -------------------------------------------
    // Only show a cycle summary when scoped to a single workspace — a
    // cross-workspace cycle rollup doesn't really mean anything.
    let cycleBurn: Awaited<ReturnType<typeof buildCycleBurn>> = null;
    if (!input.allWorkspaces) {
      cycleBurn = await buildCycleBurn(ctx.db, ctx.workspaceId);
    }

    // ---- 6. unreadSinceVisit counts --------------------------------------
    const countNew = <T extends { updatedAt: Date }>(rows: T[]): number => {
      if (!lastVisitAt) return rows.length; // never visited → all are new
      return rows.filter((r) => r.updatedAt > lastVisitAt).length;
    };

    return {
      scope: input.allWorkspaces ? ("all" as const) : ("workspace" as const),
      assignedUnblocked,
      mentions,
      stalled,
      humanStalled,
      agentStalled,
      snoozed,
      cycle: cycleBurn,
      counts: {
        assignedUnblocked: assignedUnblocked.length,
        mentions: mentions.length,
        stalled: stalled.length,
        humanStalled: humanStalled.length,
        agentStalled: agentStalled.length,
        snoozed: snoozed.length,
      },
      unreadSinceVisit: {
        assignedUnblocked: countNew(assignedUnblocked),
        // Mentions key on createdAt, not updatedAt — coerce shape.
        mentions: lastVisitAt
          ? mentions.filter((m) => m.createdAt > lastVisitAt).length
          : mentions.length,
        stalled: countNew(stalled),
        humanStalled: countNew(humanStalled),
        agentStalled: countNew(agentStalled),
      },
      lastVisitAt,
      stalledThresholdDays,
    };
  }),

  /**
   * Bump `User.lastInboxVisitAt = now()` for the calling user. Debounced
   * server-side: if the user already visited within `VISIT_DEBOUNCE_MS`
   * we skip the write but still report the (cached) timestamp so the
   * client can render consistently.
   */
  visit: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const before = await ctx.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { lastInboxVisitAt: true },
    });
    const now = new Date();
    if (
      before.lastInboxVisitAt &&
      now.getTime() - before.lastInboxVisitAt.getTime() < VISIT_DEBOUNCE_MS
    ) {
      return { visitedAt: before.lastInboxVisitAt, debounced: true } as const;
    }
    await ctx.db.user.update({
      where: { id: userId },
      data: { lastInboxVisitAt: now },
    });
    return { visitedAt: now, debounced: false } as const;
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

    // Use the first workspace's threshold as a reasonable default for
    // the badge; the precise per-workspace number lives in `inbox.get`.
    const ws = await ctx.db.workspace.findFirst({
      where: { id: { in: workspaceIds } },
      select: { stalledThresholdDays: true },
    });
    const thresholdDays = ws?.stalledThresholdDays ?? 7;
    const stalledCutoff = new Date(
      Date.now() - thresholdDays * 24 * 60 * 60 * 1000,
    );
    const now = new Date();
    const me = await ctx.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, handle: true, email: true },
    });
    const tokens = buildMentionHaystack(me.name, me.handle, me.email);
    const mentionCutoff = new Date(Date.now() - MENTION_WINDOW_MS);
    const notSnoozed: Prisma.IssueWhereInput = {
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    };

    const [assignedCount, stalledCount, candidates] = await Promise.all([
      ctx.db.issue.count({
        where: {
          workspaceId: { in: workspaceIds },
          deletedAt: null,
          assignees: { some: { userId } },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
          ...notSnoozed,
        },
      }),
      ctx.db.issue.count({
        where: {
          workspaceId: { in: workspaceIds },
          deletedAt: null,
          assignees: { some: { userId } },
          updatedAt: { lt: stalledCutoff },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
          ...notSnoozed,
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

type DB = typeof import("@/server/db").db;

async function findBlockedIssueIds(
  db: DB,
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
  db: DB,
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
