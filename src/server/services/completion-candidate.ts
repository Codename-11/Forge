import "server-only";
import {
  ActionRequestKind,
  ActionRequestStatus,
  CompletionAutomation,
  EventKind,
  NotificationSeverity,
  type PrismaClient,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  createActionRequest,
  transitionActionRequest,
} from "@/server/services/action-request-service";

const COMPLETION_SOURCE = "completion-candidate";
const RECOVERY_SOURCE = "github-pr-recovery";

export type CompletionEvidence = {
  label: string;
  value: string;
  tone?: "SUCCESS" | "WARNING" | "NEUTRAL";
};

export type CompletionCandidateResult =
  | { outcome: "DISABLED" | "TERMINAL" | "NO_STATUS" }
  | { outcome: "AUTO_COMPLETED"; statusId: string }
  | { outcome: "RECOMMENDED"; requestId: string; autoHeldReasons: string[] };

function completionDedupeKey(issueId: string): string {
  return `issue-completion:${issueId}`;
}

function recoveryDedupeKey(issueId: string): string {
  return `github-pr-recovery:${issueId}`;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function checkConclusion(metadata: unknown): string | null {
  const checks = metadataRecord(metadataRecord(metadata).checks);
  return checks.source === "api-aggregate" && typeof checks.conclusion === "string"
    ? checks.conclusion
    : null;
}

function checksArePassing(conclusion: string | null): boolean {
  return conclusion !== null && ["success", "neutral", "skipped"].includes(conclusion);
}

async function dismissOpenRequests(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    dedupeKey?: string;
    sourceType?: string;
    sourceId?: string;
    resolution: string;
  },
): Promise<void> {
  const rows = await db.actionRequest.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: ActionRequestStatus.OPEN,
      ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
      ...(params.sourceType ? { sourceType: params.sourceType } : {}),
      ...(params.sourceId ? { sourceId: params.sourceId } : {}),
    },
    select: { id: true },
  });
  for (const row of rows) {
    await transitionActionRequest(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      requestId: row.id,
      status: ActionRequestStatus.DISMISSED,
      resolution: params.resolution,
    });
  }
}

async function completionContext(db: PrismaClient, workspaceId: string, issueId: string) {
  const issue = await db.issue.findFirst({
    where: { id: issueId, workspaceId, deletedAt: null },
    select: {
      id: true,
      number: true,
      title: true,
      statusId: true,
      status: { select: { category: true, name: true } },
      project: { select: { completionAutomation: true } },
      workspace: {
        select: {
          key: true,
          completionAutomation: true,
          completionStatusId: true,
          startedStatusId: true,
        },
      },
      agentRuns: { select: { id: true, status: true } },
      executionPlans: { select: { id: true } },
      executionSteps: { select: { id: true } },
      externalLinks: {
        where: { kind: "IMPLEMENTS", externalResource: { resourceType: "PULL_REQUEST" } },
        select: {
          externalResource: {
            select: {
              id: true,
              repoFullName: true,
              number: true,
              state: true,
              url: true,
              metadata: true,
            },
          },
        },
      },
    },
  });
  if (!issue) return null;

  const liveRunIds = issue.agentRuns
    .filter((run) => run.status === "ACTIVE" || run.status === "WAITING")
    .map((run) => run.id);
  const gateTargets = [
    { targetType: "issue", targetId: issue.id },
    ...liveRunIds.map((targetId) => ({ targetType: "agent-run", targetId })),
    ...issue.executionPlans.map(({ id: targetId }) => ({ targetType: "execution-plan", targetId })),
    ...issue.executionSteps.map(({ id: targetId }) => ({ targetType: "execution-step", targetId })),
  ];
  const [pendingGates, otherRequests, blockingRelations] = await Promise.all([
    db.reviewGate.count({
      where: {
        workspaceId,
        status: "PENDING",
        OR: gateTargets,
      },
    }),
    db.actionRequest.count({
      where: {
        workspaceId,
        issueId,
        status: ActionRequestStatus.OPEN,
        OR: [{ sourceType: null }, { sourceType: { notIn: [COMPLETION_SOURCE, RECOVERY_SOURCE] } }],
      },
    }),
    db.issueRelation.findMany({
      where: { workspaceId, fromIssueId: issueId, kind: "BLOCKED_BY" },
      select: { toIssue: { select: { status: { select: { category: true } } } } },
    }),
  ]);

  const completionStatus = issue.workspace.completionStatusId
    ? await db.status.findFirst({
        where: {
          id: issue.workspace.completionStatusId,
          workspaceId,
          category: "DONE",
        },
        select: { id: true, name: true },
      })
    : null;
  const pullRequests = issue.externalLinks.map((link) => link.externalResource);
  const unresolvedBlockers = blockingRelations.filter(
    (relation) => !["DONE", "CANCELED"].includes(relation.toIssue.status.category),
  ).length;
  const automation = issue.project?.completionAutomation ?? issue.workspace.completionAutomation;

  return {
    issue,
    completionStatus,
    automation,
    pullRequests,
    liveRuns: liveRunIds.length,
    pendingGates,
    otherRequests,
    unresolvedBlockers,
  };
}

function autoHeldReasons(
  context: NonNullable<Awaited<ReturnType<typeof completionContext>>>,
): string[] {
  const reasons: string[] = [];
  if (context.liveRuns > 0)
    reasons.push(
      `${context.liveRuns} agent run${context.liveRuns === 1 ? " is" : "s are"} still active`,
    );
  if (context.pendingGates > 0)
    reasons.push(
      `${context.pendingGates} review gate${context.pendingGates === 1 ? " is" : "s are"} still pending`,
    );
  if (context.otherRequests > 0)
    reasons.push(
      `${context.otherRequests} other decision${context.otherRequests === 1 ? " is" : "s are"} still open`,
    );
  if (context.unresolvedBlockers > 0)
    reasons.push(
      `${context.unresolvedBlockers} blocking issue${context.unresolvedBlockers === 1 ? " is" : "s are"} unresolved`,
    );
  const unmerged = context.pullRequests.filter((pr) => pr.state !== "merged");
  if (unmerged.length > 0)
    reasons.push(
      `${unmerged.length} implementation PR${unmerged.length === 1 ? " is" : "s are"} not merged`,
    );
  const checksUnknownOrFailed = context.pullRequests.filter(
    (pr) => pr.state === "merged" && !checksArePassing(checkConclusion(pr.metadata)),
  );
  if (checksUnknownOrFailed.length > 0) {
    reasons.push(
      `${checksUnknownOrFailed.length} merged PR${checksUnknownOrFailed.length === 1 ? " has" : "s have"} unconfirmed checks`,
    );
  }
  return reasons;
}

async function autoCompleteIssue(
  db: PrismaClient,
  params: {
    workspaceId: string;
    issueId: string;
    statusId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    sourceType: string;
    sourceId: string;
    evidence: CompletionEvidence[];
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.issue.findFirst({
      where: { id: params.issueId, workspaceId: params.workspaceId, deletedAt: null },
      include: { status: true },
    });
    if (!before || before.status.category === "DONE" || before.status.category === "CANCELED")
      return;
    const status = await tx.status.findFirst({
      where: { id: params.statusId, workspaceId: params.workspaceId, category: "DONE" },
    });
    if (!status) return;
    const after = await tx.issue.update({
      where: { id: before.id },
      data: { statusId: status.id, completedAt: new Date(), canceledAt: null },
      include: { status: true },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      entity: "Issue",
      entityId: before.id,
      action: "completion-auto-transition",
      before,
      after,
      eventKind: EventKind.ISSUE_STATUS_CHANGED,
      subjectType: "issue",
      subjectId: before.id,
      payload: {
        source: params.sourceType,
        sourceId: params.sourceId,
        statusId: status.id,
        completionAutomation: CompletionAutomation.AUTO_WHEN_SAFE,
        evidence: params.evidence,
      },
    });
  });
  await dismissOpenRequests(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    dedupeKey: completionDedupeKey(params.issueId),
    resolution: "Issue was automatically marked done after all safety checks passed.",
  });
}

export async function evaluateIssueCompletionCandidate(
  db: PrismaClient,
  params: {
    workspaceId: string;
    issueId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    sourceType: "agent-run" | "github-pull-request";
    sourceId: string;
    sourceLabel: string;
    sourceUrl?: string | null;
    evidence?: CompletionEvidence[];
    /** Internal reconciler hint: persisted evidence already contains PR rows. */
    evidenceIncludesPullRequests?: boolean;
  },
): Promise<CompletionCandidateResult> {
  const context = await completionContext(db, params.workspaceId, params.issueId);
  if (!context) return { outcome: "TERMINAL" };
  if (context.issue.status.category === "DONE" || context.issue.status.category === "CANCELED") {
    await dismissOpenRequests(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      dedupeKey: completionDedupeKey(params.issueId),
      resolution: "Issue is already in a terminal state.",
    });
    return { outcome: "TERMINAL" };
  }
  if (context.automation === CompletionAutomation.OFF) {
    await dismissOpenRequests(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      dedupeKey: completionDedupeKey(params.issueId),
      resolution: "Completion recommendations are disabled by policy.",
    });
    return { outcome: "DISABLED" };
  }
  if (!context.completionStatus) return { outcome: "NO_STATUS" };

  const prEvidence: CompletionEvidence[] = context.pullRequests.map((pr) => {
    const conclusion = checkConclusion(pr.metadata);
    return {
      label: `${pr.repoFullName}#${pr.number}`,
      value: `${pr.state}${conclusion ? ` · checks ${conclusion}` : " · checks unknown"}`,
      tone:
        pr.state === "merged" && checksArePassing(conclusion)
          ? "SUCCESS"
          : pr.state === "merged"
            ? "NEUTRAL"
            : "WARNING",
    };
  });
  const evidence = [
    ...(params.evidence ?? []),
    ...(params.evidenceIncludesPullRequests ? [] : prEvidence),
  ].slice(0, 12);
  const held = autoHeldReasons(context);

  if (context.automation === CompletionAutomation.AUTO_WHEN_SAFE && held.length === 0) {
    await autoCompleteIssue(db, {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      statusId: context.completionStatus.id,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      evidence,
    });
    return { outcome: "AUTO_COMPLETED", statusId: context.completionStatus.id };
  }

  const issueKey = `${context.issue.workspace.key}-${context.issue.number}`;
  const request = await createActionRequest(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    title: `${issueKey} appears ready to close`,
    body:
      held.length > 0
        ? `${params.sourceLabel} recommends completion. Automatic completion was held because ${held.join("; ")}. Review the evidence before marking the issue done.`
        : `${params.sourceLabel} recommends completion. Review the evidence, then mark the issue done or keep it in review.`,
    severity: NotificationSeverity.SUCCESS,
    kind: ActionRequestKind.TRANSITION,
    payload: {
      statusId: context.completionStatus.id,
      intent: "COMPLETE",
      sourceLabel: params.sourceLabel,
      ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
      evidence,
      autoHeldReasons: held,
    },
    sourceType: COMPLETION_SOURCE,
    sourceId: params.sourceId,
    dedupeKey: completionDedupeKey(params.issueId),
    issueId: params.issueId,
  });
  return { outcome: "RECOMMENDED", requestId: request.id, autoHeldReasons: held };
}

export async function reconcileGitHubPullRequestCompletion(
  db: PrismaClient,
  params: {
    workspaceId: string;
    externalResourceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
  },
): Promise<void> {
  const resource = await db.externalResource.findFirst({
    where: {
      id: params.externalResourceId,
      workspaceId: params.workspaceId,
      provider: "GITHUB",
      resourceType: "PULL_REQUEST",
    },
    select: {
      id: true,
      repoFullName: true,
      number: true,
      title: true,
      state: true,
      url: true,
      metadata: true,
      links: {
        where: { kind: "IMPLEMENTS" },
        select: {
          issueId: true,
          issue: {
            select: {
              status: { select: { category: true } },
              workspace: { select: { key: true, startedStatusId: true } },
            },
          },
        },
      },
    },
  });
  if (!resource) return;
  const sourceLabel = `${resource.repoFullName}#${resource.number}`;
  for (const link of resource.links) {
    if (resource.state === "merged") {
      await dismissOpenRequests(db, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        dedupeKey: recoveryDedupeKey(link.issueId),
        resolution: "The implementation PR was merged.",
      });
      await evaluateIssueCompletionCandidate(db, {
        workspaceId: params.workspaceId,
        issueId: link.issueId,
        actorId: params.actorId,
        actorAgentId: params.actorAgentId,
        sourceType: "github-pull-request",
        sourceId: resource.id,
        sourceLabel: `Merged PR ${sourceLabel}`,
        sourceUrl: resource.url,
        evidence: [{ label: "Pull request", value: `${sourceLabel} merged`, tone: "SUCCESS" }],
      });
      continue;
    }

    await dismissOpenRequests(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      dedupeKey: completionDedupeKey(link.issueId),
      resolution: `Completion recommendation withdrawn because ${sourceLabel} is ${resource.state}.`,
    });

    if (resource.state !== "closed") {
      await dismissOpenRequests(db, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        dedupeKey: recoveryDedupeKey(link.issueId),
        resolution: `Recovery prompt withdrawn because ${sourceLabel} is ${resource.state}.`,
      });
      continue;
    }

    const startedStatusId = link.issue.workspace.startedStatusId;
    if (!startedStatusId || !["IN_REVIEW", "DONE"].includes(link.issue.status.category)) {
      continue;
    }
    await createActionRequest(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      title: `${sourceLabel} closed without merging`,
      body: "The linked implementation PR closed without merging. Return the issue to active work, link a replacement PR from the issue GitHub panel, or keep the current status.",
      severity: NotificationSeverity.WARNING,
      kind: ActionRequestKind.TRANSITION,
      payload: {
        statusId: startedStatusId,
        intent: "RECOVER",
        sourceLabel,
        sourceUrl: resource.url,
        evidence: [
          { label: "Pull request", value: `${sourceLabel} closed`, tone: "WARNING" },
          {
            label: "Checks",
            value: checkConclusion(resource.metadata) ?? "unknown",
            tone: "NEUTRAL",
          },
        ],
      },
      sourceType: RECOVERY_SOURCE,
      sourceId: resource.id,
      dedupeKey: recoveryDedupeKey(link.issueId),
      issueId: link.issueId,
    });
  }
}

/**
 * Restart-safe reconciliation for open lifecycle cards. Event handlers perform
 * the fast path; this sweep closes the gap when a process exits between a
 * status/resource write and its evaluator, and re-runs AUTO_WHEN_SAFE after a
 * previously-held dependency is resolved.
 */
export async function sweepCompletionCandidates(
  db: PrismaClient,
  params: { workspaceId?: string; limit?: number } = {},
): Promise<{ inspected: number; reconciled: number }> {
  const rows = await db.actionRequest.findMany({
    where: {
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      status: ActionRequestStatus.OPEN,
      sourceType: { in: [COMPLETION_SOURCE, RECOVERY_SOURCE] },
      issueId: { not: null },
    },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(params.limit ?? 250, 1), 1_000),
    select: {
      id: true,
      workspaceId: true,
      issueId: true,
      sourceType: true,
      sourceId: true,
      payload: true,
      requestedByUserId: true,
      requestedByAgentId: true,
    },
  });
  let reconciled = 0;
  for (const row of rows) {
    if (!row.issueId) continue;
    if (row.sourceType === RECOVERY_SOURCE && row.sourceId) {
      const resource = await db.externalResource.findFirst({
        where: { id: row.sourceId, workspaceId: row.workspaceId },
        select: { id: true },
      });
      if (resource) {
        await reconcileGitHubPullRequestCompletion(db, {
          workspaceId: row.workspaceId,
          externalResourceId: resource.id,
          actorId: row.requestedByUserId,
          actorAgentId: row.requestedByAgentId,
        });
      } else {
        await dismissOpenRequests(db, {
          workspaceId: row.workspaceId,
          actorId: null,
          dedupeKey: recoveryDedupeKey(row.issueId),
          resolution: "Recovery prompt dismissed because its linked PR no longer exists.",
        });
      }
      reconciled += 1;
      continue;
    }

    const payload = metadataRecord(row.payload);
    const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl : null;
    await evaluateIssueCompletionCandidate(db, {
      workspaceId: row.workspaceId,
      issueId: row.issueId,
      actorId: row.requestedByUserId,
      actorAgentId: row.requestedByAgentId,
      sourceType: sourceUrl ? "github-pull-request" : "agent-run",
      sourceId: row.sourceId ?? row.id,
      sourceLabel:
        typeof payload.sourceLabel === "string" ? payload.sourceLabel : "Completion evidence",
      sourceUrl,
      evidence: Array.isArray(payload.evidence)
        ? payload.evidence.flatMap((item) => {
            const evidence = metadataRecord(item);
            if (typeof evidence.label !== "string" || typeof evidence.value !== "string") {
              return [];
            }
            return [
              {
                label: evidence.label,
                value: evidence.value,
                tone:
                  evidence.tone === "SUCCESS" || evidence.tone === "WARNING"
                    ? evidence.tone
                    : ("NEUTRAL" as const),
              },
            ];
          })
        : [],
      evidenceIncludesPullRequests: true,
    });
    reconciled += 1;
  }
  return { inspected: rows.length, reconciled };
}
