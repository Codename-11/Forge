import "server-only";
import {
  ActionRequestKind,
  ActionRequestStatus,
  CompletionAutomation,
  EventKind,
  NotificationSeverity,
  type PrismaClient,
  type Prisma,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  createActionRequest,
  transitionActionRequest,
} from "@/server/services/action-request-service";
import { IMPLEMENTATION_LINK_KINDS } from "@/server/services/github/types";

const COMPLETION_SOURCE = "completion-candidate";
const RECOVERY_SOURCE = "github-pr-recovery";

export type CompletionEvidence = {
  label: string;
  value: string;
  tone?: "SUCCESS" | "WARNING" | "NEUTRAL";
};

export type CompletionFactStatus = "PASS" | "FAIL" | "VERIFYING" | "UNAVAILABLE" | "STALE";

export type CompletionAssessmentState = "READY" | "BLOCKED" | "VERIFYING" | "UNAVAILABLE" | "STALE";

export type CompletionFact = {
  key: string;
  label: string;
  summary: string;
  status: CompletionFactStatus;
  detail?: string;
  observedAt?: string;
  nextRetryAt?: string;
  diagnostic?: string;
  href?: string;
};

export type CompletionAssessment = {
  version: 1;
  state: CompletionAssessmentState;
  evaluatedAt: string;
  facts: CompletionFact[];
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

function metadataString(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function metadataNumber(value: Record<string, unknown>, key: string): number | null {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? (value[key] as number)
    : null;
}

function pluralCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value ?? null;
}

async function dismissOpenRequests(
  db: PrismaClient | Prisma.TransactionClient,
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

export async function dismissIssueCompletionCandidate(
  db: PrismaClient | Prisma.TransactionClient,
  params: { workspaceId: string; issueId: string; actorId: string | null; resolution: string },
): Promise<void> {
  await dismissOpenRequests(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    dedupeKey: completionDedupeKey(params.issueId),
    resolution: params.resolution,
  });
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
          githubSyncStaleMinutes: true,
          githubClosedReprobeMinutes: true,
        },
      },
      agentRuns: { select: { id: true, status: true } },
      executionPlans: { select: { id: true } },
      executionSteps: { select: { id: true } },
      externalLinks: {
        where: {
          kind: { in: [...IMPLEMENTATION_LINK_KINDS] },
          externalResource: { resourceType: "PULL_REQUEST" },
        },
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

function pullRequestCheckFact(
  pr: NonNullable<Awaited<ReturnType<typeof completionContext>>>["pullRequests"][number],
  staleMinutes: number,
  now: Date,
): CompletionFact {
  const checks = metadataRecord(metadataRecord(pr.metadata).checks);
  const source = metadataString(checks, "source");
  const status = metadataString(checks, "status");
  const conclusion = source === "api-aggregate" ? metadataString(checks, "conclusion") : null;
  const observedAt = metadataString(checks, "updatedAt");
  const nextRetryAt = metadataString(checks, "retryAt");
  const diagnostic = metadataString(checks, "diagnostic");
  const suiteCount = metadataNumber(checks, "suiteCount");
  const statusCount = metadataNumber(checks, "statusCount");
  const totalSignals = (suiteCount ?? 0) + (statusCount ?? 0);
  const prefix = totalSignals > 0 ? `${pluralCount(totalSignals, "check signal")} · ` : "";
  const parsedObservedAt = observedAt ? Date.parse(observedAt) : Number.NaN;
  const stale =
    source === "api-aggregate" &&
    staleMinutes > 0 &&
    Number.isFinite(parsedObservedAt) &&
    now.getTime() - parsedObservedAt > staleMinutes * 60_000;
  const unavailable =
    source !== "api-aggregate" ||
    status === "unknown" ||
    checks.partial === true ||
    checks.permissionDenied === true ||
    checks.rateLimited === true ||
    checks.timedOut === true;

  let factStatus: CompletionFactStatus;
  let summary: string;
  if (stale) {
    factStatus = "STALE";
    summary = `${prefix}last trusted result is stale`;
  } else if (source === "webhook-hint" || status === "pending") {
    factStatus = "VERIFYING";
    summary = `${prefix}verification in progress`;
  } else if (conclusion !== null && !checksArePassing(conclusion)) {
    factStatus = "FAIL";
    summary = `${prefix}checks ${conclusion}`;
  } else if (unavailable || conclusion === null) {
    factStatus = "UNAVAILABLE";
    summary = `${prefix}could not verify all checks`;
  } else {
    factStatus = "PASS";
    summary = `${prefix}checks passed`;
  }

  return {
    key: `checks:${pr.id}`,
    label: `Checks · ${pr.repoFullName}#${pr.number}`,
    summary,
    status: factStatus,
    ...(observedAt ? { observedAt } : {}),
    ...(nextRetryAt ? { nextRetryAt } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    href: pr.url,
  };
}

function completionAssessment(
  context: NonNullable<Awaited<ReturnType<typeof completionContext>>>,
  now = new Date(),
): CompletionAssessment {
  const facts: CompletionFact[] = [];
  for (const pr of context.pullRequests) {
    facts.push({
      key: `pull-request:${pr.id}`,
      label: "Pull request",
      summary: `${pr.repoFullName}#${pr.number} ${pr.state}`,
      status: pr.state === "merged" ? "PASS" : "FAIL",
      href: pr.url,
    });
    if (pr.state === "merged") {
      facts.push(pullRequestCheckFact(pr, context.issue.workspace.githubClosedReprobeMinutes, now));
    }
  }
  facts.push(
    {
      key: "agent-runs",
      label: "Agent runs",
      summary:
        context.liveRuns === 0
          ? "No active runs"
          : `${pluralCount(context.liveRuns, "run")} still active`,
      status: context.liveRuns === 0 ? "PASS" : "FAIL",
    },
    {
      key: "review-gates",
      label: "Review gates",
      summary:
        context.pendingGates === 0
          ? "No pending gates"
          : `${pluralCount(context.pendingGates, "gate")} pending`,
      status: context.pendingGates === 0 ? "PASS" : "FAIL",
    },
    {
      key: "decisions",
      label: "Open decisions",
      summary:
        context.otherRequests === 0
          ? "No other decisions"
          : `${pluralCount(context.otherRequests, "decision")} open`,
      status: context.otherRequests === 0 ? "PASS" : "FAIL",
    },
    {
      key: "blockers",
      label: "Blocking issues",
      summary:
        context.unresolvedBlockers === 0
          ? "No unresolved blockers"
          : `${pluralCount(context.unresolvedBlockers, "blocker")} unresolved`,
      status: context.unresolvedBlockers === 0 ? "PASS" : "FAIL",
    },
  );

  const statuses = new Set(facts.map((fact) => fact.status));
  const state: CompletionAssessmentState = statuses.has("FAIL")
    ? "BLOCKED"
    : statuses.has("VERIFYING")
      ? "VERIFYING"
      : statuses.has("STALE")
        ? "STALE"
        : statuses.has("UNAVAILABLE")
          ? "UNAVAILABLE"
          : "READY";
  return { version: 1, state, evaluatedAt: now.toISOString(), facts };
}

function assessmentWithStableTimestamp(
  next: CompletionAssessment,
  payload: unknown,
): CompletionAssessment {
  const previous = metadataRecord(metadataRecord(payload).assessment);
  const previousEvaluatedAt = metadataString(previous, "evaluatedAt");
  if (
    previous.version === 1 &&
    previous.state === next.state &&
    previousEvaluatedAt &&
    JSON.stringify(canonicalJson(previous.facts)) === JSON.stringify(canonicalJson(next.facts))
  ) {
    return { ...next, evaluatedAt: previousEvaluatedAt };
  }
  return next;
}

function autoHeldReasons(
  context: NonNullable<Awaited<ReturnType<typeof completionContext>>>,
  assessment: CompletionAssessment,
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
  for (const fact of assessment.facts.filter((item) => item.key.startsWith("checks:"))) {
    if (fact.status === "VERIFYING") reasons.push(`${fact.label} are still verifying`);
    if (fact.status === "FAIL") reasons.push(`${fact.label} failed`);
    if (fact.status === "STALE") reasons.push(`${fact.label} are stale`);
    if (fact.status === "UNAVAILABLE") reasons.push(`${fact.label} could not be confirmed`);
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
    assessment: CompletionAssessment;
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
        assessment: params.assessment,
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

  const existingRequest = await db.actionRequest.findFirst({
    where: {
      workspaceId: params.workspaceId,
      dedupeKey: completionDedupeKey(params.issueId),
      status: ActionRequestStatus.OPEN,
    },
    select: { payload: true },
  });
  const assessment = assessmentWithStableTimestamp(
    completionAssessment(context),
    existingRequest?.payload,
  );
  const sourceEvidence = (params.evidence ?? []).slice(0, 12);
  const evidence: CompletionEvidence[] = [
    ...sourceEvidence,
    ...assessment.facts.map((fact) => ({
      label: fact.label,
      value: fact.summary,
      tone:
        fact.status === "PASS"
          ? ("SUCCESS" as const)
          : fact.status === "FAIL"
            ? ("WARNING" as const)
            : ("NEUTRAL" as const),
    })),
  ].slice(0, 12);
  const held = autoHeldReasons(context, assessment);

  if (
    context.automation === CompletionAutomation.AUTO_WHEN_SAFE &&
    assessment.state === "READY" &&
    held.length === 0
  ) {
    await autoCompleteIssue(db, {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      statusId: context.completionStatus.id,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      evidence,
      assessment,
    });
    return { outcome: "AUTO_COMPLETED", statusId: context.completionStatus.id };
  }

  const issueKey = `${context.issue.workspace.key}-${context.issue.number}`;
  const title =
    assessment.state === "READY"
      ? `${issueKey} is ready to close`
      : assessment.state === "VERIFYING"
        ? `${issueKey} readiness is being verified`
        : assessment.state === "BLOCKED"
          ? `${issueKey} is not ready to close`
          : assessment.state === "STALE"
            ? `${issueKey} readiness evidence is stale`
            : `${issueKey} readiness could not be verified`;
  const body =
    assessment.state === "READY"
      ? `${params.sourceLabel} recommends completion. All current safety evidence passes.`
      : assessment.state === "VERIFYING"
        ? `${params.sourceLabel} recommends completion. Forge is verifying the remaining evidence before enabling normal completion.`
        : assessment.state === "BLOCKED"
          ? `${params.sourceLabel} recommends completion, but ${held.join("; ")}. Resolve the blockers or use the authorized override.`
          : assessment.state === "STALE"
            ? `${params.sourceLabel} recommends completion, but the last trusted evidence is stale. Refresh it before closing or use the authorized override.`
            : `${params.sourceLabel} recommends completion, but Forge could not verify all required evidence. Retry verification or use the authorized override.`;
  const severity =
    assessment.state === "READY"
      ? NotificationSeverity.SUCCESS
      : assessment.state === "VERIFYING"
        ? NotificationSeverity.INFO
        : NotificationSeverity.WARNING;
  const request = await createActionRequest(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    title,
    body,
    severity,
    kind: ActionRequestKind.TRANSITION,
    payload: {
      statusId: context.completionStatus.id,
      intent: "COMPLETE",
      sourceLabel: params.sourceLabel,
      ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
      assessment,
      sourceEvidence,
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
        where: { kind: { in: [...IMPLEMENTATION_LINK_KINDS] } },
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
      evidence: Array.isArray(payload.sourceEvidence)
        ? payload.sourceEvidence.flatMap((item) => {
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
    });
    reconciled += 1;
  }
  return { inspected: rows.length, reconciled };
}
