import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

const MAX_TARGETS = 100;
const MAX_FALLBACK_STEPS = 500;
const MAX_CONTEXT_ITEMS = 50;
const MAX_PLAN_STEPS = 100;

export interface OrchestrationIssueRef {
  id: string;
  key: string;
  title: string;
  status: { id: string; name: string; category: string };
}

export interface OrchestrationRunEvidence {
  id: string;
  summary: string | null;
  producedArtifactIds: string[];
  verificationResult: Prisma.JsonValue | null;
  completionMeta: Prisma.JsonValue | null;
  completedAt: Date | null;
}

export interface OrchestrationStepSummary {
  id: string;
  title: string;
  position: number;
  status: string;
  dependsOnStepIds: string[];
  issue: OrchestrationIssueRef | null;
  sourceRun: OrchestrationRunEvidence | null;
}

export interface IssueOrchestrationContext {
  goal: {
    id: string;
    title: string;
    description: string | null;
    successCriteria: string | null;
    status: string;
  } | null;
  plan: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    isActiveAttempt: boolean;
    maxStepRetries: number;
    progress: { done: number; total: number; visible: number; truncated: boolean };
  };
  step:
    | (OrchestrationStepSummary & {
        body: string | null;
        expectedOutput: string | null;
        verification: Prisma.JsonValue | null;
        retryCount: number;
        lastFeedback: string | null;
        judgeVerdict: Prisma.JsonValue | null;
        completionContract: {
          expectedOutput: string | null;
          verification: Prisma.JsonValue | null;
          artifactRequired: boolean;
        };
      })
    | null;
  dependencies: OrchestrationStepSummary[];
  dependents: OrchestrationStepSummary[];
  planSteps: OrchestrationStepSummary[];
  contextSet: {
    id: string;
    name: string;
    description: string | null;
    items: Array<{
      id: string;
      targetType: string;
      targetId: string;
      includeMode: string;
      note: string | null;
      position: number;
    }>;
    truncated: boolean;
  } | null;
}

export interface OrchestrationContextTarget {
  issueId: string;
  executionStepId?: string | null;
}

interface OrchestrationContextSnapshotEnvelope {
  schemaVersion: 1;
  capturedAt: string;
  context: IssueOrchestrationContext;
}

export interface InboxOrchestrationContext {
  goal: { id: string; title: string; status: string } | null;
  plan: {
    id: string;
    title: string;
    status: string;
    progress: IssueOrchestrationContext["plan"]["progress"];
  };
  step: {
    id: string;
    title: string;
    position: number;
    status: string;
    retryCount: number;
    lastFeedback: string | null;
  } | null;
  dependencies: OrchestrationStepSummary[];
  dependents: OrchestrationStepSummary[];
}

const PLAN_CONTEXT_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  issueId: true,
  isActiveAttempt: true,
  maxStepRetries: true,
  goal: {
    select: {
      id: true,
      title: true,
      description: true,
      successCriteria: true,
      status: true,
    },
  },
  workspace: { select: { key: true } },
  contextSet: {
    select: {
      id: true,
      name: true,
      description: true,
      items: {
        where: { includeMode: { not: "EXCLUDE" } },
        orderBy: [{ position: "asc" as const }, { id: "asc" as const }],
        take: MAX_CONTEXT_ITEMS + 1,
        select: {
          id: true,
          targetType: true,
          targetId: true,
          includeMode: true,
          note: true,
          position: true,
        },
      },
    },
  },
  steps: {
    orderBy: [{ position: "asc" as const }, { id: "asc" as const }],
    take: MAX_PLAN_STEPS,
    select: {
      id: true,
      title: true,
      body: true,
      position: true,
      status: true,
      expectedOutput: true,
      verification: true,
      sourceRunId: true,
      dependsOnStepIds: true,
      judgeVerdict: true,
      retryCount: true,
      lastFeedback: true,
      issueId: true,
      issue: {
        select: {
          id: true,
          number: true,
          title: true,
          expectedOutput: true,
          verificationChecklist: true,
          artifactRequired: true,
          status: { select: { id: true, name: true, category: true } },
        },
      },
    },
  },
  _count: { select: { steps: true } },
} satisfies Prisma.ExecutionPlanSelect;

type SelectedPlan = Prisma.ExecutionPlanGetPayload<{ select: typeof PLAN_CONTEXT_SELECT }>;
type SelectedPlanStep = SelectedPlan["steps"][number];

/**
 * Load orchestration context for issue-routed work units without N+1 queries.
 * Results align with `targets`. An AgentRun's executionStepId wins; the issue
 * link is only a fallback for legacy/direct runs that predate that pointer.
 */
export async function loadIssueOrchestrationContexts(
  client: DbClient,
  params: { workspaceId: string; targets: readonly OrchestrationContextTarget[] },
): Promise<Array<IssueOrchestrationContext | null>> {
  if (params.targets.length === 0) return [];
  const targets = params.targets.slice(0, MAX_TARGETS);
  const exactIds = Array.from(
    new Set(targets.flatMap((target) => (target.executionStepId ? [target.executionStepId] : []))),
  );

  const exactCandidates = exactIds.length
    ? await client.executionStep.findMany({
        where: { workspaceId: params.workspaceId, id: { in: exactIds } },
        select: {
          id: true,
          issueId: true,
          planId: true,
          updatedAt: true,
          plan: {
            select: { issueId: true, isActiveAttempt: true, status: true, updatedAt: true },
          },
        },
      })
    : [];
  const exactById = new Map(exactCandidates.map((candidate) => [candidate.id, candidate]));

  const fallbackIssueIds = Array.from(
    new Set(
      targets
        .filter((target) => {
          if (!target.executionStepId) return true;
          const exact = exactById.get(target.executionStepId);
          return (
            !exact || (exact.issueId !== target.issueId && exact.plan.issueId !== target.issueId)
          );
        })
        .map((target) => target.issueId),
    ),
  );
  const fallbackCandidates = fallbackIssueIds.length
    ? await client.executionStep.findMany({
        where: {
          workspaceId: params.workspaceId,
          issueId: { in: fallbackIssueIds },
          status: { in: ["TODO", "READY", "RUNNING", "BLOCKED", "REVIEW"] },
        },
        orderBy: { updatedAt: "desc" },
        take: MAX_FALLBACK_STEPS,
        select: {
          id: true,
          issueId: true,
          planId: true,
          updatedAt: true,
          plan: {
            select: { issueId: true, isActiveAttempt: true, status: true, updatedAt: true },
          },
        },
      })
    : [];

  const selectedStepIds = targets.map((target) => {
    const exact = target.executionStepId ? exactById.get(target.executionStepId) : null;
    if (exact && (exact.issueId === target.issueId || exact.plan.issueId === target.issueId)) {
      return exact.id;
    }
    const matches = fallbackCandidates.filter((candidate) => candidate.issueId === target.issueId);
    return matches.length === 1 ? matches[0]!.id : null;
  });

  const candidateById = new Map(
    [...exactCandidates, ...fallbackCandidates].map((candidate) => [candidate.id, candidate]),
  );
  const anchorIssueIds = Array.from(
    new Set(targets.flatMap((target, index) => (selectedStepIds[index] ? [] : [target.issueId]))),
  );
  const anchorCandidates = anchorIssueIds.length
    ? await client.executionPlan.findMany({
        where: {
          workspaceId: params.workspaceId,
          issueId: { in: anchorIssueIds },
          archivedAt: null,
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          issueId: true,
          isActiveAttempt: true,
          status: true,
          updatedAt: true,
        },
      })
    : [];
  const selectedPlanIds = targets.map((target, index) => {
    const stepId = selectedStepIds[index];
    if (stepId) return candidateById.get(stepId)?.planId ?? null;
    const matches = anchorCandidates.filter((plan) => plan.issueId === target.issueId);
    matches.sort((a, b) => {
      const activeDiff = Number(b.isActiveAttempt) - Number(a.isActiveAttempt);
      if (activeDiff) return activeDiff;
      const runningDiff = Number(b.status === "RUNNING") - Number(a.status === "RUNNING");
      if (runningDiff) return runningDiff;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    return matches[0]?.id ?? null;
  });
  const planIds = Array.from(new Set(selectedPlanIds.filter((id): id is string => Boolean(id))));
  const plans = planIds.length
    ? await client.executionPlan.findMany({
        where: { workspaceId: params.workspaceId, id: { in: planIds } },
        select: PLAN_CONTEXT_SELECT,
      })
    : [];
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const sourceRunIds = Array.from(
    new Set(
      plans.flatMap((plan) =>
        plan.steps.flatMap((step) => (step.sourceRunId ? [step.sourceRunId] : [])),
      ),
    ),
  );
  const sourceRuns = sourceRunIds.length
    ? await client.agentRun.findMany({
        where: { workspaceId: params.workspaceId, id: { in: sourceRunIds } },
        select: {
          id: true,
          summary: true,
          producedArtifactIds: true,
          verificationResult: true,
          completionMeta: true,
          completedAt: true,
        },
      })
    : [];
  const sourceRunById = new Map(sourceRuns.map((run) => [run.id, run]));

  const results = selectedPlanIds.map((planId, index) => {
    const plan = planId ? planById.get(planId) : null;
    if (!plan) return null;
    return normalizeContext(plan, selectedStepIds[index] ?? null, sourceRunById);
  });
  // Preserve alignment even when a caller accidentally exceeds the documented
  // inbox maximum; overflow targets intentionally receive no context.
  return [...results, ...params.targets.slice(MAX_TARGETS).map(() => null)];
}

export async function loadIssueOrchestrationContext(
  client: DbClient,
  params: { workspaceId: string; issueId: string; executionStepId?: string | null },
): Promise<IssueOrchestrationContext | null> {
  const [context] = await loadIssueOrchestrationContexts(client, {
    workspaceId: params.workspaceId,
    targets: [{ issueId: params.issueId, executionStepId: params.executionStepId }],
  });
  return context ?? null;
}

/**
 * Serialize the already-bounded shared context for durable storage on an
 * AgentRun. The envelope gives us an explicit evolution point without
 * coupling historical rows to the current Prisma result shape.
 */
export function createOrchestrationContextSnapshot(
  context: IssueOrchestrationContext,
  capturedAt = new Date(),
): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      capturedAt: capturedAt.toISOString(),
      context,
    } satisfies OrchestrationContextSnapshotEnvelope),
  ) as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reviveEvidenceDate(summary: unknown): void {
  const sourceRun = asRecord(summary)?.sourceRun;
  const sourceRunRecord = asRecord(sourceRun);
  if (!sourceRunRecord || typeof sourceRunRecord.completedAt !== "string") return;
  const completedAt = new Date(sourceRunRecord.completedAt);
  sourceRunRecord.completedAt = Number.isNaN(completedAt.getTime()) ? null : completedAt;
}

/** Parse a v1 snapshot. Invalid/unknown snapshots intentionally return null. */
export function readOrchestrationContextSnapshot(
  snapshot: unknown,
): IssueOrchestrationContext | null {
  const envelope = asRecord(snapshot);
  if (envelope?.schemaVersion !== 1 || typeof envelope.capturedAt !== "string") return null;
  const rawContext = asRecord(envelope.context);
  if (
    !rawContext ||
    !asRecord(rawContext.plan) ||
    !Array.isArray(rawContext.dependencies) ||
    !Array.isArray(rawContext.dependents) ||
    !Array.isArray(rawContext.planSteps)
  ) {
    return null;
  }

  // Clone before reviving timestamps so the Prisma JSON value remains a plain
  // data object and callers get the same Date-bearing shape as live hydration.
  const context = JSON.parse(JSON.stringify(rawContext)) as Record<string, unknown>;
  reviveEvidenceDate(context.step);
  for (const field of ["dependencies", "dependents", "planSteps"] as const) {
    const summaries = context[field];
    if (Array.isArray(summaries)) summaries.forEach(reviveEvidenceDate);
  }
  return context as unknown as IssueOrchestrationContext;
}

/** Prefer a run's immutable dispatch snapshot, with live hydration for legacy rows. */
export async function loadRunOrchestrationContext(
  client: DbClient,
  params: {
    workspaceId: string;
    issueId: string;
    executionStepId?: string | null;
    snapshot?: unknown;
  },
): Promise<IssueOrchestrationContext | null> {
  const snapshot = readOrchestrationContextSnapshot(params.snapshot);
  if (snapshot) return snapshot;
  return loadIssueOrchestrationContext(client, params);
}

function normalizeContext(
  plan: SelectedPlan,
  stepId: string | null,
  sourceRunById: ReadonlyMap<string, OrchestrationRunEvidence>,
): IssueOrchestrationContext | null {
  const current = stepId ? plan.steps.find((step) => step.id === stepId) : null;
  if (stepId && !current) return null;
  const toSummary = (step: SelectedPlanStep): OrchestrationStepSummary => ({
    id: step.id,
    title: step.title,
    position: step.position,
    status: step.status,
    dependsOnStepIds: step.dependsOnStepIds,
    issue: step.issue
      ? {
          id: step.issue.id,
          key: `${plan.workspace.key}-${step.issue.number}`,
          title: step.issue.title,
          status: {
            id: step.issue.status.id,
            name: step.issue.status.name,
            category: step.issue.status.category,
          },
        }
      : null,
    sourceRun: step.sourceRunId ? (sourceRunById.get(step.sourceRunId) ?? null) : null,
  });
  const planSteps = plan.steps.map(toSummary);
  const byId = new Map(planSteps.map((step) => [step.id, step]));
  const dependencies = current
    ? current.dependsOnStepIds.flatMap((id) => {
        const dependency = byId.get(id);
        return dependency ? [dependency] : [];
      })
    : [];
  const dependents = current
    ? planSteps.filter((step) => step.dependsOnStepIds.includes(current.id))
    : [];
  const stepSummary = current ? toSummary(current) : null;
  const contextItems = plan.contextSet?.items.slice(0, MAX_CONTEXT_ITEMS) ?? [];

  return {
    goal: plan.goal,
    plan: {
      id: plan.id,
      title: plan.title,
      description: plan.description,
      status: plan.status,
      isActiveAttempt: plan.isActiveAttempt,
      maxStepRetries: plan.maxStepRetries,
      progress: {
        done: plan.steps.filter((step) => step.status === "DONE").length,
        total: plan._count.steps,
        visible: plan.steps.length,
        truncated: plan._count.steps > plan.steps.length,
      },
    },
    step:
      current && stepSummary
        ? {
            ...stepSummary,
            body: current.body,
            expectedOutput: current.expectedOutput,
            verification: current.verification,
            retryCount: current.retryCount,
            lastFeedback: current.lastFeedback,
            judgeVerdict: current.judgeVerdict,
            completionContract: {
              expectedOutput: current.expectedOutput ?? current.issue?.expectedOutput ?? null,
              verification: current.verification ?? current.issue?.verificationChecklist ?? null,
              artifactRequired: current.issue?.artifactRequired ?? false,
            },
          }
        : null,
    dependencies,
    dependents,
    planSteps,
    contextSet: plan.contextSet
      ? {
          id: plan.contextSet.id,
          name: plan.contextSet.name,
          description: plan.contextSet.description,
          items: contextItems,
          truncated: plan.contextSet.items.length > contextItems.length,
        }
      : null,
  };
}

export function toInboxOrchestrationContext(
  context: IssueOrchestrationContext | null,
): InboxOrchestrationContext | null {
  if (!context) return null;
  return {
    goal: context.goal
      ? { id: context.goal.id, title: context.goal.title, status: context.goal.status }
      : null,
    plan: {
      id: context.plan.id,
      title: context.plan.title,
      status: context.plan.status,
      progress: context.plan.progress,
    },
    step: context.step
      ? {
          id: context.step.id,
          title: context.step.title,
          position: context.step.position,
          status: context.step.status,
          retryCount: context.step.retryCount,
          lastFeedback: context.step.lastFeedback,
        }
      : null,
    dependencies: context.dependencies,
    dependents: context.dependents,
  };
}

function compactText(value: string | null | undefined, max = 2_000): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function jsonLine(value: Prisma.JsonValue | null): string | null {
  if (value === null) return null;
  const raw = JSON.stringify(value);
  return compactText(raw, 2_000);
}

function stepLine(step: OrchestrationStepSummary): string {
  const issue = step.issue ? ` · ${step.issue.key}: ${step.issue.title}` : "";
  const output = compactText(step.sourceRun?.summary, 400);
  return `- [${step.status}] ${step.position + 1}. ${step.title}${issue}${output ? ` · outcome: ${output}` : ""}`;
}

/** Compact prompt block shared by every provider-backed runtime turn. */
export function formatOrchestrationContextForPrompt(
  context: IssueOrchestrationContext | null,
): string {
  if (!context) return "";
  const sections: string[] = [
    context.step
      ? "Orchestration context — this issue is one step of a larger plan; work toward the goal and preserve dependency boundaries."
      : "Orchestration context — this issue anchors a larger plan; work toward its goal without assuming a specific step assignment.",
  ];
  if (context.goal) {
    sections.push(`Goal: ${context.goal.title} [${context.goal.status}]`);
    const goalDescription = compactText(context.goal.description, 1_200);
    if (goalDescription) sections.push(`Goal context:\n${goalDescription}`);
    const success = compactText(context.goal.successCriteria, 1_200);
    if (success) sections.push(`Goal success criteria:\n${success}`);
  }
  sections.push(
    `Plan: ${context.plan.title} [${context.plan.status}] · ${context.plan.progress.done}/${context.plan.progress.total} steps done`,
  );
  if (context.step) {
    sections.push(
      `Current step: ${context.step.position + 1}. ${context.step.title} [${context.step.status}] · retry ${context.step.retryCount}/${context.plan.maxStepRetries}`,
    );
    const body = compactText(context.step.body);
    if (body) sections.push(`Step instructions:\n${body}`);
    const expectedOutput = compactText(context.step.completionContract.expectedOutput);
    if (expectedOutput) sections.push(`Expected output:\n${expectedOutput}`);
    const verification = jsonLine(context.step.completionContract.verification);
    if (verification) sections.push(`Verification:\n${verification}`);
    if (context.step.completionContract.artifactRequired) {
      sections.push("Completion requires a durable artifact linked to the issue/run.");
    }
    const feedback = compactText(context.step.lastFeedback, 2_500);
    if (feedback) sections.push(`Retry feedback to address:\n${feedback}`);
  }
  if (context.step?.sourceRun) {
    const evidence = context.step.sourceRun;
    const evidenceLines = [
      `Worker source run: ${evidence.id}`,
      compactText(evidence.summary, 1_500)
        ? `Worker summary: ${compactText(evidence.summary, 1_500)}`
        : null,
      evidence.producedArtifactIds.length
        ? `Produced artifacts: ${evidence.producedArtifactIds.join(", ")}`
        : null,
      jsonLine(evidence.verificationResult)
        ? `Worker verification evidence: ${jsonLine(evidence.verificationResult)}`
        : null,
    ].filter((line): line is string => Boolean(line));
    sections.push(evidenceLines.join("\n"));
  }
  if (context.dependencies.length) {
    sections.push(`Prerequisite steps:\n${context.dependencies.map(stepLine).join("\n")}`);
  }
  if (context.dependents.length) {
    sections.push(
      `Downstream steps relying on this work:\n${context.dependents.map(stepLine).join("\n")}`,
    );
  }
  sections.push(`Plan map:\n${context.planSteps.map(stepLine).join("\n")}`);
  if (context.contextSet) {
    const refs = context.contextSet.items
      .slice(0, 12)
      .map(
        (item) =>
          `- ${item.includeMode} ${item.targetType}:${item.targetId}${item.note ? ` — ${item.note}` : ""}`,
      )
      .join("\n");
    sections.push(
      `Shared context set: ${context.contextSet.name} (${context.contextSet.id})${refs ? `\n${refs}` : ""}`,
    );
  }
  return `\n\n${sections.join("\n\n")}`;
}
