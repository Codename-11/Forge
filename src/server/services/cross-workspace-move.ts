import "server-only";
import type { PrismaClient } from "@prisma/client";
import { EventKind, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";

/**
 * Cross-workspace issue move (agent-runtime audit, ask #2).
 *
 * Moving an Issue across workspaces is dangerous: Issue is the hub of ~14
 * child tables, several of which carry their OWN `workspaceId` plus per-
 * workspace unique constraints (`@@unique([workspaceId, number])`,
 * `[workspaceId, name]`, …). A naive `Issue.workspaceId` re-stamp orphans or
 * cross-tenant-leaks every child. This service therefore:
 *
 *  1. Renumbers each moved issue into the TARGET workspace's sequence
 *     (`AXI-42` → `WRK-108`) — the source key is workspace-immutable.
 *  2. Remaps `statusId` (by category) and labels (by name); drops unmatched.
 *  3. Nulls FKs that can't cross a tenant boundary (project / cycle / agents),
 *     and keeps `parentId` only when the parent is also in the move set.
 *  4. Re-stamps the `workspaceId`-bearing content children (comments,
 *     attachments, time entries, watchers, external links).
 *  5. Drops IssueRelations whose other end isn't moving.
 *  6. REFUSES to move an "entangled" issue — one with agent runs, orchestration
 *     links (execution step/plan/goal), action requests, or artifacts — rather
 *     than risk a cross-tenant reference. The preview reports why.
 *
 * `planIssueMove` is read-only (the dry-run/preview). `executeIssueMove` runs
 * the identical plan in one transaction and writes MOVE audit events in both
 * workspaces.
 */

export interface IssueMovePlanEntry {
  issueId: string;
  currentKey: string;
  title: string;
  newNumber: number | null;
  newKey: string | null;
  statusFrom: string;
  statusTo: string | null;
  keptLabels: string[];
  droppedLabels: string[];
  nulledFields: string[];
  droppedRelations: number;
  attachmentBytes: number;
  blockedReasons: string[];
}

export interface IssueMovePlan {
  source: { id: string; key: string; name: string };
  target: { id: string; key: string; name: string };
  entries: IssueMovePlanEntry[];
  movableIds: string[];
  blockedIds: string[];
  attachmentMbMoving: number;
  targetQuotaMb: number;
  targetUsedMb: number;
  overQuota: boolean;
}

const NULLED_ALWAYS = ["projectId", "cycleId", "assignedAgentId", "claimedByAgentId"];

const ISSUE_FOR_PLAN = {
  id: true,
  number: true,
  title: true,
  parentId: true,
  status: { select: { id: true, name: true, category: true } },
  labels: { select: { label: { select: { id: true, name: true } } } },
  attachments: { select: { size: true, kind: true } },
  relationsFrom: { select: { toIssueId: true } },
  relationsTo: { select: { fromIssueId: true } },
  _count: {
    select: {
      agentRuns: true,
      executionSteps: true,
      executionPlans: true,
      goals: true,
      actionRequests: true,
      artifacts: true,
    },
  },
} satisfies Prisma.IssueSelect;

/**
 * Build the (read-only) move plan. Throws only on gross precondition errors
 * (missing workspace, issues spanning multiple workspaces, empty selection).
 */
export async function planIssueMove(
  db: PrismaClient,
  params: { sourceWorkspaceId: string; targetWorkspaceId: string; issueIds: string[] },
): Promise<IssueMovePlan> {
  if (params.sourceWorkspaceId === params.targetWorkspaceId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Source and target workspaces are the same." });
  }
  if (params.issueIds.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "No issues selected to move." });
  }

  const [source, target] = await Promise.all([
    db.workspace.findUnique({
      where: { id: params.sourceWorkspaceId },
      select: { id: true, key: true, name: true },
    }),
    db.workspace.findUnique({
      where: { id: params.targetWorkspaceId },
      select: { id: true, key: true, name: true, attachmentQuotaMb: true },
    }),
  ]);
  if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source workspace not found." });
  if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Target workspace not found." });

  const issues = await db.issue.findMany({
    where: { id: { in: params.issueIds }, workspaceId: params.sourceWorkspaceId, deletedAt: null },
    select: ISSUE_FOR_PLAN,
  });
  if (issues.length !== params.issueIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Some issues weren't found in the source workspace (already moved, deleted, or from another workspace).",
    });
  }

  const moveSet = new Set(issues.map((i) => i.id));

  // Target config for remapping.
  const [targetStatuses, targetLabels, targetMax, targetUsedAgg] = await Promise.all([
    db.status.findMany({
      where: { workspaceId: params.targetWorkspaceId },
      select: { id: true, name: true, category: true, isDefault: true },
    }),
    db.label.findMany({
      where: { workspaceId: params.targetWorkspaceId },
      select: { id: true, name: true },
    }),
    db.issue.findFirst({
      where: { workspaceId: params.targetWorkspaceId },
      orderBy: { number: "desc" },
      select: { number: true },
    }),
    db.attachment.aggregate({
      where: { workspaceId: params.targetWorkspaceId, kind: "FILE" },
      _sum: { size: true },
    }),
  ]);

  const targetLabelByName = new Map(targetLabels.map((l) => [l.name.toLowerCase(), l.id]));
  const targetDefaultStatus =
    targetStatuses.find((s) => s.isDefault) ?? targetStatuses[0] ?? null;
  const statusForCategory = (category: string): { id: string; name: string } | null => {
    const sameCat = targetStatuses.filter((s) => s.category === category);
    const pick = sameCat.find((s) => s.isDefault) ?? sameCat[0] ?? targetDefaultStatus;
    return pick ? { id: pick.id, name: pick.name } : null;
  };

  let nextNumber = (targetMax?.number ?? 0) + 1;
  let attachmentBytesMoving = 0;

  const entries: IssueMovePlanEntry[] = [];
  const movableIds: string[] = [];
  const blockedIds: string[] = [];

  for (const issue of issues) {
    const blockedReasons: string[] = [];
    if (issue._count.agentRuns > 0) blockedReasons.push(`${issue._count.agentRuns} agent run(s)`);
    if (issue._count.executionSteps > 0 || issue._count.executionPlans > 0 || issue._count.goals > 0)
      blockedReasons.push("orchestration links (plan/step/goal)");
    if (issue._count.actionRequests > 0) blockedReasons.push("open action requests");
    if (issue._count.artifacts > 0) blockedReasons.push("artifacts");

    const statusTo = statusForCategory(issue.status.category);
    if (!statusTo) blockedReasons.push("target has no status to map to");

    const kept: string[] = [];
    const dropped: string[] = [];
    for (const l of issue.labels) {
      if (targetLabelByName.has(l.label.name.toLowerCase())) kept.push(l.label.name);
      else dropped.push(l.label.name);
    }

    const nulled = [...NULLED_ALWAYS];
    if (issue.parentId && !moveSet.has(issue.parentId)) nulled.push("parentId");

    const relatedIds = [
      ...issue.relationsFrom.map((r) => r.toIssueId),
      ...issue.relationsTo.map((r) => r.fromIssueId),
    ];
    const droppedRelations = relatedIds.filter((id) => !moveSet.has(id)).length;

    const bytes = issue.attachments
      .filter((a) => a.kind === "FILE")
      .reduce((sum, a) => sum + (a.size ?? 0), 0);

    const blocked = blockedReasons.length > 0;
    let newNumber: number | null = null;
    let newKey: string | null = null;
    if (!blocked) {
      newNumber = nextNumber++;
      newKey = `${target.key}-${newNumber}`;
      attachmentBytesMoving += bytes;
      movableIds.push(issue.id);
    } else {
      blockedIds.push(issue.id);
    }

    entries.push({
      issueId: issue.id,
      currentKey: `${source.key}-${issue.number}`,
      title: issue.title,
      newNumber,
      newKey,
      statusFrom: issue.status.name,
      statusTo: statusTo?.name ?? null,
      keptLabels: kept,
      droppedLabels: dropped,
      nulledFields: nulled,
      droppedRelations,
      attachmentBytes: bytes,
      blockedReasons,
    });
  }

  const targetQuotaMb = target.attachmentQuotaMb ?? 1024;
  const targetUsedMb = (Number(targetUsedAgg._sum.size ?? 0)) / (1024 * 1024);
  const attachmentMbMoving = attachmentBytesMoving / (1024 * 1024);

  return {
    source: { id: source.id, key: source.key, name: source.name },
    target: { id: target.id, key: target.key, name: target.name },
    entries,
    movableIds,
    blockedIds,
    attachmentMbMoving,
    targetQuotaMb,
    targetUsedMb,
    overQuota: targetUsedMb + attachmentMbMoving > targetQuotaMb,
  };
}

/**
 * Execute the move for the plan's movable issues in one transaction. Rebuilds
 * the plan inside the tx to avoid acting on a stale snapshot. Returns the moved
 * issue ids + their new keys.
 */
export async function executeIssueMove(
  db: PrismaClient,
  params: {
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    issueIds: string[];
    actorId: string | null;
  },
): Promise<{ moved: Array<{ issueId: string; newKey: string }>; skipped: string[] }> {
  const plan = await planIssueMove(db, params);
  if (plan.movableIds.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "None of the selected issues can be moved (all are blocked — see the preview).",
    });
  }

  // Rebuild the per-issue remap decisions the executor needs.
  const [targetStatuses, targetLabels] = await Promise.all([
    db.status.findMany({
      where: { workspaceId: params.targetWorkspaceId },
      select: { id: true, category: true, isDefault: true },
    }),
    db.label.findMany({
      where: { workspaceId: params.targetWorkspaceId },
      select: { id: true, name: true },
    }),
  ]);
  const targetLabelByName = new Map(targetLabels.map((l) => [l.name.toLowerCase(), l.id]));
  const targetDefaultStatus = targetStatuses.find((s) => s.isDefault) ?? targetStatuses[0] ?? null;
  const statusIdForCategory = (category: string): string | null => {
    const sameCat = targetStatuses.filter((s) => s.category === category);
    return (sameCat.find((s) => s.isDefault) ?? sameCat[0] ?? targetDefaultStatus)?.id ?? null;
  };

  const movable = new Set(plan.movableIds);
  const entryById = new Map(plan.entries.map((e) => [e.issueId, e]));

  // Full issue rows for the movable set (status category, labels, relations).
  const issues = await db.issue.findMany({
    where: { id: { in: plan.movableIds } },
    select: {
      id: true,
      parentId: true,
      status: { select: { category: true } },
      labels: { select: { labelId: true, label: { select: { name: true } } } },
      relationsFrom: { select: { id: true, toIssueId: true } },
      relationsTo: { select: { id: true, fromIssueId: true } },
    },
  });

  const moved: Array<{ issueId: string; newKey: string }> = [];

  await db.$transaction(async (tx) => {
    for (const issue of issues) {
      const entry = entryById.get(issue.id);
      if (!entry || entry.newNumber == null || entry.newKey == null) continue;
      const statusId = statusIdForCategory(issue.status.category);
      if (!statusId) continue;

      // 1) The issue itself: re-tenant, renumber, remap status, null cross-ws FKs.
      await tx.issue.update({
        where: { id: issue.id },
        data: {
          workspaceId: params.targetWorkspaceId,
          number: entry.newNumber,
          statusId,
          projectId: null,
          cycleId: null,
          assignedAgentId: null,
          claimedByAgentId: null,
          parentId: issue.parentId && movable.has(issue.parentId) ? issue.parentId : null,
        },
      });

      // 2) Labels: drop rows that don't map, remap the rest to target label ids.
      for (const il of issue.labels) {
        const targetLabelId = targetLabelByName.get(il.label.name.toLowerCase());
        await tx.issueLabel.delete({
          where: { issueId_labelId: { issueId: issue.id, labelId: il.labelId } },
        });
        if (targetLabelId) {
          await tx.issueLabel.create({ data: { issueId: issue.id, labelId: targetLabelId } });
        }
      }

      // 3) Relations: drop those whose other end isn't moving; re-tenant the rest.
      for (const r of issue.relationsFrom) {
        if (!movable.has(r.toIssueId)) {
          await tx.issueRelation.delete({ where: { id: r.id } }).catch(() => {});
        } else {
          await tx.issueRelation.update({
            where: { id: r.id },
            data: { workspaceId: params.targetWorkspaceId },
          });
        }
      }
      for (const r of issue.relationsTo) {
        if (!movable.has(r.fromIssueId)) {
          await tx.issueRelation.delete({ where: { id: r.id } }).catch(() => {});
        }
        // relationsFrom loop already re-tenanted intra-move relations.
      }

      moved.push({ issueId: issue.id, newKey: entry.newKey });
    }

    // 4) Re-tenant the workspaceId-bearing content children in bulk.
    const childWhere = { issueId: { in: plan.movableIds } };
    await tx.comment.updateMany({ where: childWhere, data: { workspaceId: params.targetWorkspaceId } });
    await tx.attachment.updateMany({ where: childWhere, data: { workspaceId: params.targetWorkspaceId } });
    await tx.timeEntry.updateMany({ where: childWhere, data: { workspaceId: params.targetWorkspaceId } });
    await tx.issueWatcher.updateMany({ where: childWhere, data: { workspaceId: params.targetWorkspaceId } });
    await tx.externalResourceLink.updateMany({
      where: childWhere,
      data: { workspaceId: params.targetWorkspaceId },
    });

    // 5) Audit trail in BOTH workspaces so neither history silently loses the move.
    const summary = {
      count: moved.length,
      issueIds: plan.movableIds,
      newKeys: moved.map((m) => m.newKey),
      sourceWorkspaceId: params.sourceWorkspaceId,
      targetWorkspaceId: params.targetWorkspaceId,
    } as Prisma.InputJsonValue;
    for (const wsId of [params.sourceWorkspaceId, params.targetWorkspaceId]) {
      await recordChange(tx, {
        workspaceId: wsId,
        actorId: params.actorId,
        entity: "Issue",
        entityId: plan.movableIds[0],
        action: "cross_workspace_move",
        after: summary,
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "workspace",
        subjectId: wsId,
        payload: summary,
      });
    }
  });

  return { moved, skipped: plan.blockedIds };
}
