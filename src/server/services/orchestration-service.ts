import "server-only";
import type { PrismaClient } from "@prisma/client";
import {
  ActionRequestKind,
  type AgentProvider,
  AgentRunStatus,
  type AgentStatus,
  EngagementMode,
  EventKind,
  ExecutionPlanStatus,
  ExecutionStepStatus,
  GoalStatus,
  Prisma,
  RunEngine,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { recordChange, agentDispatchUrlFor } from "@/server/audit";
import { openReviewGateTx } from "@/server/services/agent-crew-service";
import { createActionRequest } from "@/server/services/action-request-service";
import { finishRun, openOrTouchRun } from "@/server/services/agent-run";
import {
  resolveRunEngineWithSource,
  type AgentRuntimeRef,
} from "@/server/services/dispatch/registry";
import { runPlanGeneration } from "@/server/services/ai";
import { resolveWorkspaceProviderClient } from "@/server/services/ai-providers";
import { materializeStepAsIssueTx } from "@/server/services/execution-step-issue-service";

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Worker fields needed to open an observable orchestration run with its
 * engine/source stamped (so the run row shows the engine chip + a truthful
 * tooltip, same as assignment/grant runs). Execution steps are concrete work,
 * so the engagement mode is always EXECUTE, decided by the surface.
 */
const ORCH_WORKER_SELECT = {
  webhookUrl: true,
  runtimeId: true,
  provider: true,
  runEngine: true,
  runtime: {
    select: {
      name: true,
      adapterKey: true,
      config: true,
      disabledAt: true,
      endpoint: true,
      secret: true,
    },
  },
} as const;

/** Resolve the engine + the EXECUTE-mode stamp for an orchestration worker. */
function orchestrationRunStamp(
  worker: {
    provider: AgentProvider;
    runEngine: RunEngine | null;
    runtime: AgentRuntimeRef;
  },
  engagementMode: EngagementMode = EngagementMode.EXECUTE,
) {
  const engine = resolveRunEngineWithSource({
    runEngine: worker.runEngine,
    provider: worker.provider,
    runtime: worker.runtime,
  });
  return {
    engagementMode,
    engagementSource: "surface-default" as const,
    runEngine: engine.engine,
    runEngineSource: engine.source,
  };
}

// ---------------------------------------------------------------------------
// judgeVerdict JSON shape — the contract the UI agents render against.
// ---------------------------------------------------------------------------

export interface JudgeVerdictJson {
  verdict: "PASS" | "FAIL";
  feedback: string;
  score?: number;
  judgedByAgentId?: string;
  judgedAt: string;
}

// ---------------------------------------------------------------------------
// Per-agent dispatch shim. Steps may not have an issue, so we can't reuse
// the issue-keyed `recordChange` fan-out branches. Instead we directly
// enqueue a WebhookDelivery against the per-agent dispatch shim — the
// worker resolves the agent from the url suffix regardless of subject
// type. The ActivityEvent (emitted by the caller via recordChange) is the
// delivery's event row; this helper just wires the WebhookDelivery.
// ---------------------------------------------------------------------------

async function upsertAgentDispatchWebhook(
  tx: Tx,
  workspaceId: string,
  url: string,
): Promise<string> {
  const existing = await tx.webhook.findFirst({
    where: { workspaceId, url },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await tx.webhook.create({
    data: {
      workspaceId,
      url,
      secret: nanoid(32),
      events: [
        EventKind.AGENT_ASSIGNED,
        EventKind.EXECUTION_STEP_READY,
        EventKind.EXECUTION_STEP_JUDGED,
        EventKind.CHAT_MESSAGE_POSTED,
      ],
      active: true,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Queue a webhook delivery to a specific agent for a just-recorded
 * ActivityEvent. Best-effort — when the agent has no webhookUrl the worker
 * dead-letters the delivery; the event row + audit log still exist so the
 * dispatch intent is recoverable. Call AFTER `recordChange` so `eventId`
 * references a persisted ActivityEvent.
 */
async function queueAgentDispatch(
  tx: Tx,
  params: { workspaceId: string; agentId: string; eventId: string },
): Promise<void> {
  const agent = await tx.agent.findFirst({
    where: { id: params.agentId, workspaceId: params.workspaceId, archivedAt: null },
    select: { id: true, webhookUrl: true },
  });
  if (!agent) return;
  // Always create the per-agent shim row (idempotent) so the worker can
  // resolve the target; it dead-letters cleanly when webhookUrl is null.
  const webhookId = await upsertAgentDispatchWebhook(
    tx,
    params.workspaceId,
    agentDispatchUrlFor(params.agentId),
  );
  await tx.webhookDelivery.create({
    data: { webhookId, eventId: params.eventId },
  });
}

// ---------------------------------------------------------------------------
// Crew role resolution.
// ---------------------------------------------------------------------------

async function pickCrewMember(
  tx: Tx,
  crewId: string,
  role: "PLANNER" | "WORKER" | "REVIEWER",
): Promise<string | null> {
  const member = await tx.agentCrewMember.findFirst({
    where: { crewId, role },
    orderBy: { position: "asc" },
    select: { agentId: true },
  });
  return member?.agentId ?? null;
}

// ---------------------------------------------------------------------------
// Goal CRUD.
// ---------------------------------------------------------------------------

export interface CreateGoalInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  title: string;
  description?: string | null;
  successCriteria?: string | null;
  outcomeSummary?: string | null;
  targetDate?: Date | null;
  issueId?: string | null;
  initiativeId?: string | null;
  crewId?: string | null;
  maxTotalCostUsd?: number | null;
  maxWallTimeMinutes?: number | null;
}

export async function createGoal(
  db: PrismaClient,
  input: CreateGoalInput,
): Promise<{ id: string }> {
  if (input.issueId) {
    const found = await db.issue.findFirst({
      where: { id: input.issueId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
    }
  }
  if (input.crewId) {
    const found = await db.agentCrew.findFirst({
      where: { id: input.crewId, workspaceId: input.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Agent crew not found in this workspace.",
      });
    }
  }
  if (input.initiativeId) {
    const found = await db.initiative.findFirst({
      where: { id: input.initiativeId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Initiative not found in this workspace.",
      });
    }
  }
  const { id } = await db.$transaction(async (tx) => {
    const goal = await tx.goal.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title.trim(),
        description: input.description ?? null,
        successCriteria: input.successCriteria ?? null,
        outcomeSummary: input.outcomeSummary ?? null,
        targetDate: input.targetDate ?? null,
        issueId: input.issueId ?? null,
        initiativeId: input.initiativeId ?? null,
        crewId: input.crewId ?? null,
        createdById: input.actorAgentId ? null : input.actorId,
        createdByAgentId: input.actorAgentId ?? null,
        maxTotalCostUsd: input.maxTotalCostUsd ?? null,
        maxWallTimeMinutes: input.maxWallTimeMinutes ?? null,
      },
    });
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entity: "goal",
      entityId: goal.id,
      action: "created",
      after: {
        title: goal.title,
        status: goal.status,
        successCriteria: goal.successCriteria,
        targetDate: goal.targetDate,
      },
      eventKind: EventKind.GOAL_CREATED,
      subjectType: "goal",
      subjectId: goal.id,
      payload: {
        goalTitle: goal.title,
        issueId: goal.issueId,
        crewId: goal.crewId,
      } as Prisma.InputJsonValue,
    });
    return { id: goal.id };
  });
  return { id };
}

export interface UpdateGoalInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  id: string;
  title?: string;
  description?: string | null;
  successCriteria?: string | null;
  outcomeSummary?: string | null;
  targetDate?: Date | null;
  initiativeId?: string | null;
  crewId?: string | null;
  maxTotalCostUsd?: number | null;
  maxWallTimeMinutes?: number | null;
}

export async function updateGoal(
  db: PrismaClient,
  input: UpdateGoalInput,
): Promise<{ id: string }> {
  const goal = await db.goal.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId },
    select: {
      id: true,
      title: true,
      description: true,
      successCriteria: true,
      outcomeSummary: true,
      targetDate: true,
      status: true,
      initiativeId: true,
      crewId: true,
      maxTotalCostUsd: true,
      maxWallTimeMinutes: true,
    },
  });
  if (!goal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found." });
  }
  if (goal.status === GoalStatus.ACHIEVED || goal.status === GoalStatus.ABANDONED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot edit a ${goal.status.toLowerCase()} goal.`,
    });
  }

  if (input.crewId) {
    const found = await db.agentCrew.findFirst({
      where: { id: input.crewId, workspaceId: input.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Agent crew not found in this workspace.",
      });
    }
  }
  if (input.initiativeId) {
    const found = await db.initiative.findFirst({
      where: { id: input.initiativeId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Initiative not found in this workspace.",
      });
    }
  }

  const goalData: Prisma.GoalUpdateInput = {
    title: input.title?.trim() ?? undefined,
    description: input.description === undefined ? undefined : input.description,
    successCriteria: input.successCriteria === undefined ? undefined : input.successCriteria,
    outcomeSummary: input.outcomeSummary === undefined ? undefined : input.outcomeSummary,
    targetDate: input.targetDate === undefined ? undefined : input.targetDate,
    initiative:
      input.initiativeId === undefined
        ? undefined
        : input.initiativeId
          ? { connect: { id: input.initiativeId } }
          : { disconnect: true },
    crew:
      input.crewId === undefined
        ? undefined
        : input.crewId
          ? { connect: { id: input.crewId } }
          : { disconnect: true },
    maxTotalCostUsd: input.maxTotalCostUsd === undefined ? undefined : input.maxTotalCostUsd,
    maxWallTimeMinutes:
      input.maxWallTimeMinutes === undefined ? undefined : input.maxWallTimeMinutes,
  };
  const planBudgetData: Prisma.ExecutionPlanUpdateManyMutationInput = {
    ...(input.maxTotalCostUsd === undefined ? {} : { maxTotalCostUsd: input.maxTotalCostUsd }),
    ...(input.maxWallTimeMinutes === undefined
      ? {}
      : { maxWallTimeMinutes: input.maxWallTimeMinutes }),
  };

  await db.$transaction(async (tx) => {
    await tx.goal.update({
      where: { id: goal.id },
      data: goalData,
    });
    if (Object.keys(planBudgetData).length > 0) {
      await tx.executionPlan.updateMany({
        where: {
          goalId: goal.id,
          isActiveAttempt: true,
          status: {
            in: [
              ExecutionPlanStatus.DRAFT,
              ExecutionPlanStatus.APPROVED,
              ExecutionPlanStatus.RUNNING,
              ExecutionPlanStatus.BLOCKED,
            ],
          },
        },
        data: planBudgetData,
      });
    }
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorAgentId: input.actorAgentId ?? null,
      entity: "goal",
      entityId: goal.id,
      action: "updated",
      before: {
        title: goal.title,
        description: goal.description,
        successCriteria: goal.successCriteria,
        outcomeSummary: goal.outcomeSummary,
        targetDate: goal.targetDate,
        initiativeId: goal.initiativeId,
        crewId: goal.crewId,
        maxTotalCostUsd: goal.maxTotalCostUsd,
        maxWallTimeMinutes: goal.maxWallTimeMinutes,
      },
      after: {
        title: input.title?.trim() ?? goal.title,
        description: input.description === undefined ? goal.description : input.description,
        successCriteria:
          input.successCriteria === undefined ? goal.successCriteria : input.successCriteria,
        outcomeSummary:
          input.outcomeSummary === undefined ? goal.outcomeSummary : input.outcomeSummary,
        targetDate: input.targetDate === undefined ? goal.targetDate : input.targetDate,
        initiativeId: input.initiativeId === undefined ? goal.initiativeId : input.initiativeId,
        crewId: input.crewId === undefined ? goal.crewId : input.crewId,
        maxTotalCostUsd:
          input.maxTotalCostUsd === undefined ? goal.maxTotalCostUsd : input.maxTotalCostUsd,
        maxWallTimeMinutes:
          input.maxWallTimeMinutes === undefined
            ? goal.maxWallTimeMinutes
            : input.maxWallTimeMinutes,
      },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "goal",
      subjectId: goal.id,
      payload: {
        action: "updated",
        budgetMirroredToActivePlan: Object.keys(planBudgetData).length > 0,
      } as Prisma.InputJsonValue,
    });
  });

  return { id: goal.id };
}

export async function getGoal(db: PrismaClient, params: { workspaceId: string; id: string }) {
  const goal = await db.goal.findFirst({
    where: { id: params.id, workspaceId: params.workspaceId },
    include: {
      plans: {
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { steps: true } },
          steps: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              title: true,
              status: true,
              assignedAgentId: true,
              updatedAt: true,
              issue: {
                select: {
                  id: true,
                  number: true,
                  title: true,
                  assignedAgentId: true,
                  workspace: { select: { key: true, slug: true } },
                  agentRuns: {
                    orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
                    take: 1,
                    select: {
                      id: true,
                      status: true,
                      summary: true,
                      producedArtifactIds: true,
                      verificationResult: true,
                      currentStep: true,
                      startedAt: true,
                      lastEventAt: true,
                      acknowledgedAt: true,
                      outputStartedAt: true,
                      lastWakeAt: true,
                      wakeAttempts: true,
                      finishedAt: true,
                      awaitingApprovalAt: true,
                      pendingApproval: true,
                      externalRunId: true,
                      controlState: true,
                      engagementMode: true,
                      clearedAt: true,
                      agentId: true,
                      issueId: true,
                      agent: {
                        select: {
                          id: true,
                          name: true,
                          profileKey: true,
                          avatar: true,
                          status: true,
                          runtimeId: true,
                        },
                      },
                      issue: {
                        select: {
                          id: true,
                          number: true,
                          title: true,
                          assignedAgentId: true,
                          workspace: { select: { key: true, slug: true } },
                        },
                      },
                    },
                  },
                },
              },
              runs: {
                orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
                take: 1,
                select: {
                  id: true,
                  status: true,
                  summary: true,
                  producedArtifactIds: true,
                  verificationResult: true,
                  currentStep: true,
                  triggerKind: true,
                  externalRunId: true,
                  startedAt: true,
                  lastEventAt: true,
                  acknowledgedAt: true,
                  outputStartedAt: true,
                  lastWakeAt: true,
                  wakeAttempts: true,
                  finishedAt: true,
                  awaitingApprovalAt: true,
                  pendingApproval: true,
                  controlState: true,
                  engagementMode: true,
                  clearedAt: true,
                  agentId: true,
                  issueId: true,
                  agent: {
                    select: {
                      id: true,
                      name: true,
                      profileKey: true,
                      avatar: true,
                      status: true,
                      runtimeId: true,
                    },
                  },
                  issue: {
                    select: {
                      id: true,
                      number: true,
                      title: true,
                      assignedAgentId: true,
                      workspace: { select: { key: true, slug: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      crew: {
        select: {
          id: true,
          name: true,
          maxParallel: true,
          members: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              role: true,
              position: true,
              agent: {
                select: {
                  id: true,
                  name: true,
                  profileKey: true,
                  avatar: true,
                  status: true,
                  lastHeartbeatAt: true,
                },
              },
            },
          },
        },
      },
      issue: { select: { id: true, number: true, title: true } },
    },
  });
  if (!goal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found." });
  }
  // Aggregate status across the active attempt's steps.
  const activePlan = goal.plans.find((p) => p.isActiveAttempt) ?? goal.plans[0] ?? null;
  let aggregate: {
    activePlanId: string | null;
    totalSteps: number;
    doneSteps: number;
    blockedSteps: number;
  } = { activePlanId: null, totalSteps: 0, doneSteps: 0, blockedSteps: 0 };
  if (activePlan) {
    const grouped = await db.executionStep.groupBy({
      by: ["status"],
      where: { planId: activePlan.id },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
    const total = grouped.reduce((acc, g) => acc + g._count._all, 0);
    aggregate = {
      activePlanId: activePlan.id,
      totalSteps: total,
      doneSteps: counts.get(ExecutionStepStatus.DONE) ?? 0,
      blockedSteps: counts.get(ExecutionStepStatus.BLOCKED) ?? 0,
    };
  }
  const activeSteps = activePlan?.steps ?? [];
  const activeStepIds = activeSteps.map((step) => step.id);
  const gates = activeStepIds.length
    ? await db.reviewGate.findMany({
        where: {
          workspaceId: params.workspaceId,
          targetType: "execution-step",
          targetId: { in: activeStepIds },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          targetId: true,
          status: true,
          prompt: true,
          resolution: true,
          createdAt: true,
          resolvedAt: true,
          resolvedBy: { select: { id: true, name: true } },
          resolvedByAgent: { select: { id: true, name: true, profileKey: true } },
        },
      })
    : [];
  const artifactIds = Array.from(
    new Set(
      activeSteps.flatMap((step) => {
        const direct = step.runs?.[0]?.producedArtifactIds ?? [];
        const issueRun = step.issue?.agentRuns?.[0]?.producedArtifactIds ?? [];
        return [...direct, ...issueRun];
      }),
    ),
  );
  const outputs = artifactIds.length
    ? await db.artifact.findMany({
        where: { workspaceId: params.workspaceId, id: { in: artifactIds }, archivedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, slug: true, type: true, status: true, summary: true },
      })
    : [];
  const pendingGates = gates.filter((gate) => gate.status === "PENDING");
  const blockedStep = activeSteps.find((step) => step.status === ExecutionStepStatus.BLOCKED);
  const reviewStep = activeSteps.find((step) => step.status === ExecutionStepStatus.REVIEW);
  const runningStep = activeSteps.find((step) => step.status === ExecutionStepStatus.RUNNING);
  const readyStep = activeSteps.find((step) => step.status === ExecutionStepStatus.READY);
  const health =
    goal.status === GoalStatus.ACHIEVED
      ? "ACHIEVED"
      : goal.status === GoalStatus.ABANDONED
        ? "ABANDONED"
        : pendingGates.length > 0
          ? "NEEDS_REVIEW"
          : blockedStep
            ? "BLOCKED"
            : runningStep
              ? "RUNNING"
              : reviewStep
                ? "WAITING_REVIEW"
                : readyStep
                  ? "READY"
                  : activePlan
                    ? "PLANNING"
                    : "NEEDS_PLAN";
  const focusStep = blockedStep ?? reviewStep ?? runningStep ?? readyStep ?? null;
  const nextAction = pendingGates.length
    ? "Review completed work"
    : blockedStep
      ? `Resolve blocked step: ${blockedStep.title}`
      : reviewStep
        ? `Review step: ${reviewStep.title}`
        : runningStep
          ? `In progress: ${runningStep.title}`
          : readyStep
            ? `Ready to run: ${readyStep.title}`
            : activePlan
              ? "Finish or approve the active plan"
              : "Create an execution plan";
  return {
    ...goal,
    aggregate,
    operating: {
      health,
      nextAction,
      focusStep: focusStep
        ? { id: focusStep.id, title: focusStep.title, status: focusStep.status }
        : null,
      pendingGates,
      recentDecisions: gates.filter((gate) => gate.status !== "PENDING").slice(0, 8),
      outputs,
    },
  };
}

export async function listGoals(
  db: PrismaClient,
  params: {
    workspaceId: string;
    status?: GoalStatus;
    issueId?: string;
    includeArchived?: boolean;
    limit?: number;
  },
) {
  const goals = await db.goal.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: params.status,
      issueId: params.issueId,
      archivedAt: params.includeArchived ? undefined : null,
    },
    orderBy: { updatedAt: "desc" },
    take: params.limit ?? 50,
    include: {
      _count: { select: { plans: true } },
      crew: { select: { id: true, name: true } },
      plans: {
        where: { isActiveAttempt: true },
        take: 1,
        select: {
          id: true,
          status: true,
          steps: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              title: true,
              status: true,
              assignedAgentId: true,
              updatedAt: true,
              runs: {
                orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
                take: 1,
                select: {
                  id: true,
                  status: true,
                  summary: true,
                  currentStep: true,
                  startedAt: true,
                  lastEventAt: true,
                  acknowledgedAt: true,
                  outputStartedAt: true,
                  lastWakeAt: true,
                  wakeAttempts: true,
                  finishedAt: true,
                  awaitingApprovalAt: true,
                  pendingApproval: true,
                  clearedAt: true,
                  agentId: true,
                  issueId: true,
                  agent: {
                    select: {
                      id: true,
                      name: true,
                      profileKey: true,
                      avatar: true,
                      status: true,
                    },
                  },
                },
              },
              issue: {
                select: {
                  id: true,
                  number: true,
                  title: true,
                  assignedAgentId: true,
                  workspace: { select: { key: true, slug: true } },
                  agentRuns: {
                    orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
                    take: 1,
                    select: {
                      id: true,
                      status: true,
                      summary: true,
                      currentStep: true,
                      startedAt: true,
                      lastEventAt: true,
                      acknowledgedAt: true,
                      outputStartedAt: true,
                      lastWakeAt: true,
                      wakeAttempts: true,
                      finishedAt: true,
                      awaitingApprovalAt: true,
                      pendingApproval: true,
                      clearedAt: true,
                      agentId: true,
                      issueId: true,
                      agent: {
                        select: {
                          id: true,
                          name: true,
                          profileKey: true,
                          avatar: true,
                          status: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const stepIds = goals.flatMap((goal) =>
    goal.plans.flatMap((plan) => plan.steps.map((s) => s.id)),
  );
  const pendingGates = stepIds.length
    ? await db.reviewGate.findMany({
        where: {
          workspaceId: params.workspaceId,
          targetType: "execution-step",
          targetId: { in: stepIds },
          status: "PENDING",
        },
        select: { id: true, targetId: true },
      })
    : [];
  const gatedStepIds = new Set(pendingGates.map((gate) => gate.targetId));
  return goals.map((goal) => {
    const plan = goal.plans[0] ?? null;
    const steps = plan?.steps ?? [];
    const gated = steps.find((step) => gatedStepIds.has(step.id));
    const blocked = steps.find((step) => step.status === ExecutionStepStatus.BLOCKED);
    const running = steps.find((step) => step.status === ExecutionStepStatus.RUNNING);
    const review = steps.find((step) => step.status === ExecutionStepStatus.REVIEW);
    const ready = steps.find((step) => step.status === ExecutionStepStatus.READY);
    const focus = gated ?? blocked ?? review ?? running ?? ready ?? null;
    const health = gated
      ? "NEEDS_REVIEW"
      : blocked
        ? "BLOCKED"
        : running
          ? "RUNNING"
          : review
            ? "WAITING_REVIEW"
            : ready
              ? "READY"
              : plan
                ? "PLANNING"
                : goal.status;
    return {
      ...goal,
      activePlan: plan,
      operating: {
        health,
        nextAction: focus
          ? `${focus.status === "REVIEW" ? "Review" : focus.status === "BLOCKED" ? "Unblock" : focus.status === "RUNNING" ? "Running" : "Next"}: ${focus.title}`
          : plan
            ? "Finish or approve the active plan"
            : "Create an execution plan",
        pendingGateCount: steps.filter((step) => gatedStepIds.has(step.id)).length,
      },
    };
  });
}

/**
 * Tear down the in-flight execution of a set of plans: cancel their
 * non-terminal steps, mark their live AgentRuns ABANDONED so the poll loop
 * stops tracking them, and best-effort `connector.stop` the provider runs so
 * they stop spending tokens. Used when a goal is abandoned or superseded by a
 * fresh decompose attempt — without it a "canceled" plan's runs keep burning
 * budget until the stale watchdog reaps them, and a late verdict could still
 * cascade. Provider stop is a network call, so it runs OUTSIDE the DB tx.
 */
async function reapPlanRuns(
  db: PrismaClient,
  params: { workspaceId: string; planIds: string[] },
): Promise<void> {
  if (params.planIds.length === 0) return;
  const steps = await db.executionStep.findMany({
    where: { planId: { in: params.planIds }, workspaceId: params.workspaceId },
    select: { id: true },
  });
  const stepIds = steps.map((s) => s.id);
  if (stepIds.length === 0) return;

  // Snapshot the live provider runs before we abandon them (need externalRunId
  // + agent/runtime to resolve a connector for the stop).
  const liveRuns = await db.agentRun.findMany({
    where: {
      workspaceId: params.workspaceId,
      executionStepId: { in: stepIds },
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      externalRunId: { not: null },
    },
    select: {
      id: true,
      externalRunId: true,
      agent: {
        select: {
          provider: true,
          runtime: {
            select: {
              adapterKey: true,
              endpoint: true,
              secret: true,
              config: true,
              disabledAt: true,
              name: true,
            },
          },
        },
      },
    },
  });

  await db.$transaction(async (tx) => {
    await tx.executionStep.updateMany({
      where: {
        planId: { in: params.planIds },
        status: {
          in: [
            ExecutionStepStatus.TODO,
            ExecutionStepStatus.READY,
            ExecutionStepStatus.RUNNING,
            ExecutionStepStatus.REVIEW,
            ExecutionStepStatus.BLOCKED,
          ],
        },
      },
      data: { status: ExecutionStepStatus.CANCELED },
    });
    await tx.agentRun.updateMany({
      where: {
        executionStepId: { in: stepIds },
        status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      },
      data: { status: AgentRunStatus.ABANDONED, finishedAt: new Date() },
    });
  });

  for (const run of liveRuns) {
    if (!run.externalRunId) continue;
    try {
      const { getRunsConnectorForAgent } = await import("@/server/services/dispatch/registry");
      const connector = getRunsConnectorForAgent({
        provider: run.agent.provider,
        runtime: run.agent.runtime,
      });
      await connector?.stop?.(run.externalRunId);
    } catch (err) {
      logger.warn({ err, runId: run.id }, "orchestration: provider stop on teardown failed");
    }
  }
}

/**
 * Demote a goal's prior decompose attempts AND cancel + reap any that were
 * still dispatching. A re-decompose / re-generate used to only flip
 * `isActiveAttempt=false`, leaving a prior RUNNING/APPROVED/BLOCKED plan
 * cascading steps and spending in the background — two plans driving one goal's
 * totals. Call this before creating the fresh attempt.
 */
async function demoteAndReapPriorAttempts(
  db: PrismaClient,
  params: { workspaceId: string; goalId: string },
): Promise<void> {
  const dispatching = await db.executionPlan.findMany({
    where: {
      goalId: params.goalId,
      isActiveAttempt: true,
      status: {
        in: [
          ExecutionPlanStatus.RUNNING,
          ExecutionPlanStatus.APPROVED,
          ExecutionPlanStatus.BLOCKED,
        ],
      },
    },
    select: { id: true },
  });
  const ids = dispatching.map((p) => p.id);
  await db.$transaction(async (tx) => {
    if (ids.length) {
      await tx.executionPlan.updateMany({
        where: { id: { in: ids } },
        data: { status: ExecutionPlanStatus.CANCELED },
      });
    }
    await tx.executionPlan.updateMany({
      where: { goalId: params.goalId, isActiveAttempt: true },
      data: { isActiveAttempt: false },
    });
  });
  await reapPlanRuns(db, { workspaceId: params.workspaceId, planIds: ids });
}

export async function abandonGoal(
  db: PrismaClient,
  params: { workspaceId: string; actorId: string | null; id: string; reason?: string | null },
): Promise<void> {
  const goal = await db.goal.findFirst({
    where: { id: params.id, workspaceId: params.workspaceId },
    select: { id: true, status: true, title: true },
  });
  if (!goal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found." });
  }
  if (goal.status === GoalStatus.ACHIEVED || goal.status === GoalStatus.ABANDONED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal is already ${goal.status.toLowerCase()}.`,
    });
  }
  const canceledPlanIds = await db.$transaction(async (tx) => {
    await tx.goal.update({
      where: { id: goal.id },
      data: { status: GoalStatus.ABANDONED },
    });
    // Cancel any active plan attempt so dispatch stops.
    const plans = await tx.executionPlan.findMany({
      where: {
        goalId: goal.id,
        status: {
          in: [
            ExecutionPlanStatus.DRAFT,
            ExecutionPlanStatus.APPROVED,
            ExecutionPlanStatus.RUNNING,
            ExecutionPlanStatus.BLOCKED,
          ],
        },
      },
      select: { id: true },
    });
    const ids = plans.map((p) => p.id);
    if (ids.length) {
      await tx.executionPlan.updateMany({
        where: { id: { in: ids } },
        data: { status: ExecutionPlanStatus.CANCELED },
      });
    }
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "goal",
      entityId: goal.id,
      action: "abandoned",
      before: { status: goal.status },
      after: { status: GoalStatus.ABANDONED },
      eventKind: EventKind.GOAL_STATUS_CHANGED,
      subjectType: "goal",
      subjectId: goal.id,
      payload: { from: goal.status, to: GoalStatus.ABANDONED, reason: params.reason ?? null },
    });
    return ids;
  });
  // Cancel non-terminal steps + stop their in-flight runs so an abandoned goal
  // stops spending immediately (was: runs kept burning tokens until the stale
  // watchdog reaped them, and a late verdict could still cascade).
  await reapPlanRuns(db, { workspaceId: params.workspaceId, planIds: canceledPlanIds });
}

// ---------------------------------------------------------------------------
// Decompose — create a DRAFT plan attempt + dispatch the PLANNER.
// ---------------------------------------------------------------------------

export async function decomposeGoal(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    goalId: string;
    plannerAgentId?: string | null;
    contextSetId?: string | null;
  },
): Promise<{
  planId: string;
  status: "PLANNING";
  plannerAgentId: string | null;
  /** Resolved planner + reachability so the UI can warn instead of silently
   *  producing a plan no one will ever fill. Null when no planner resolved. */
  planner: {
    id: string;
    name: string;
    profileKey: string;
    status: AgentStatus;
    runEngine: RunEngine | null;
    hasWebhook: boolean;
  } | null;
  /** True when the dispatch can actually reach the planner: RUNS-engine needs
   *  a runtime; others need a webhook. OFFLINE is a soft warning (see
   *  `planner.status`), not a hard blocker, so it doesn't flip this false. */
  dispatchable: boolean;
}> {
  const goal = await db.goal.findFirst({
    where: { id: params.goalId, workspaceId: params.workspaceId },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      crewId: true,
      issueId: true,
      maxTotalCostUsd: true,
      maxWallTimeMinutes: true,
    },
  });
  if (!goal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found." });
  }
  if (goal.status === GoalStatus.ACHIEVED || goal.status === GoalStatus.ABANDONED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot decompose a ${goal.status.toLowerCase()} goal.`,
    });
  }
  if (params.contextSetId) {
    const cs = await db.contextSet.findFirst({
      where: { id: params.contextSetId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!cs) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Context set not found in this workspace.",
      });
    }
  }

  // Resolve the planner: explicit override > crew PLANNER > caller's agent.
  let plannerAgentId: string | null = params.plannerAgentId ?? null;
  if (plannerAgentId) {
    const ok = await db.agent.findFirst({
      where: { id: plannerAgentId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!ok) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "plannerAgentId not in this workspace.",
      });
    }
  }
  if (!plannerAgentId && goal.crewId) {
    plannerAgentId = await pickCrewMember(db, goal.crewId, "PLANNER");
  }
  if (!plannerAgentId && params.actorAgentId) {
    plannerAgentId = params.actorAgentId;
  }

  // Resolve planner reachability so the caller/UI can warn up-front.
  let planner: {
    id: string;
    name: string;
    profileKey: string;
    status: AgentStatus;
    runEngine: RunEngine | null;
    hasWebhook: boolean;
  } | null = null;
  let dispatchable = false;
  if (plannerAgentId) {
    const agent = await db.agent.findFirst({
      where: { id: plannerAgentId, workspaceId: params.workspaceId },
      select: {
        id: true,
        name: true,
        profileKey: true,
        status: true,
        runEngine: true,
        webhookUrl: true,
        runtimeId: true,
      },
    });
    if (agent) {
      const hasWebhook = !!agent.webhookUrl;
      planner = {
        id: agent.id,
        name: agent.name,
        profileKey: agent.profileKey,
        status: agent.status,
        runEngine: agent.runEngine,
        hasWebhook,
      };
      // RUNS agents are reached via a Runtime (their dispatch webhook is
      // suppressed); everyone else needs a webhookUrl.
      dispatchable = agent.runEngine === RunEngine.RUNS ? !!agent.runtimeId : hasWebhook;
    }
  }

  // Cancel + reap any prior dispatching attempt before starting a fresh one,
  // so two plans don't drive the same goal at once (was: a prior RUNNING plan
  // kept dispatching steps + spending in the background after re-generate).
  await demoteAndReapPriorAttempts(db, { workspaceId: params.workspaceId, goalId: goal.id });
  const result = await db.$transaction(async (tx) => {
    const plan = await tx.executionPlan.create({
      data: {
        workspaceId: params.workspaceId,
        title: `Plan for: ${goal.title}`.slice(0, 300),
        description: goal.description,
        issueId: goal.issueId,
        status: ExecutionPlanStatus.DRAFT,
        createdById: params.actorAgentId ? null : params.actorId,
        createdByAgentId: params.actorAgentId ?? null,
        contextSetId: params.contextSetId ?? null,
        crewId: goal.crewId,
        goalId: goal.id,
        isActiveAttempt: true,
        maxTotalCostUsd: goal.maxTotalCostUsd,
        maxWallTimeMinutes: goal.maxWallTimeMinutes,
      },
    });
    // Flip goal → PLANNING.
    if (goal.status !== GoalStatus.PLANNING) {
      await tx.goal.update({
        where: { id: goal.id },
        data: { status: GoalStatus.PLANNING },
      });
      await recordChange(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        entity: "goal",
        entityId: goal.id,
        action: "status",
        before: { status: goal.status },
        after: { status: GoalStatus.PLANNING },
        eventKind: EventKind.GOAL_STATUS_CHANGED,
        subjectType: "goal",
        subjectId: goal.id,
        payload: { from: goal.status, to: GoalStatus.PLANNING },
      });
    }
    // Emit a plan-created event; the planner dispatch rides this event id.
    const event = await tx.activityEvent.create({
      data: {
        workspaceId: params.workspaceId,
        kind: EventKind.ISSUE_UPDATED,
        actorId: params.actorId,
        subjectType: "execution-plan",
        subjectId: plan.id,
        payload: {
          action: "decompose",
          goalId: goal.id,
          goalTitle: goal.title,
          goalDescription: goal.description,
          plannerAgentId,
          prompt:
            `You are the PLANNER for goal "${goal.title}". Decompose it into ` +
            `ordered ExecutionSteps and call plans.addSteps({ planId: "${plan.id}", steps: [...] }). ` +
            `Each step needs a title, body, expectedOutput, verification, ` +
            `dependsOnStepIndexes (by array position), and a suggested assignedRole ` +
            `(WORKER/REVIEWER). When done, the plan stays DRAFT until an operator approves it.`,
          contextSetId: params.contextSetId ?? null,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        entity: "execution-plan",
        entityId: plan.id,
        action: "decompose",
        after: { goalId: goal.id, plannerAgentId },
      },
    });
    if (plannerAgentId) {
      await queueAgentDispatch(tx, {
        workspaceId: params.workspaceId,
        agentId: plannerAgentId,
        eventId: event.id,
      });
    }
    return { planId: plan.id };
  });

  return { planId: result.planId, status: "PLANNING", plannerAgentId, planner, dispatchable };
}

// ---------------------------------------------------------------------------
// Generate — Forge IS the planner. Calls the workspace's configured model to
// decompose the goal synchronously, then writes the steps. The counterpart to
// `decompose` (which dispatches an external planner agent): "Generate with
// Forge" works with zero external agents. The slow model call happens OUTSIDE
// any transaction; the plan + goal flip + steps are written in one atomic tx
// so a failure never leaves a dead empty plan.
// ---------------------------------------------------------------------------

export async function generatePlanForGoal(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    goalId: string;
    contextSetId?: string | null;
  },
): Promise<{ planId: string; status: "PLANNING"; stepCount: number }> {
  const goal = await db.goal.findFirst({
    where: { id: params.goalId, workspaceId: params.workspaceId },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      crewId: true,
      issueId: true,
      maxTotalCostUsd: true,
      maxWallTimeMinutes: true,
    },
  });
  if (!goal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found." });
  }
  if (goal.status === GoalStatus.ACHIEVED || goal.status === GoalStatus.ABANDONED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot plan a ${goal.status.toLowerCase()} goal.`,
    });
  }
  if (params.contextSetId) {
    const cs = await db.contextSet.findFirst({
      where: { id: params.contextSetId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!cs) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Context set not found in this workspace.",
      });
    }
  }

  // AI must be enabled + a provider resolvable BEFORE any DB write, so a
  // misconfigured workspace gets a clear error and never a dead empty plan.
  const ws = await db.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { aiEnabled: true, aiProvider: true, aiModel: true },
  });
  if (!ws) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
  }
  if (!ws.aiEnabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "AI is disabled for this workspace. Enable it in Settings → Workspace → AI, or use Dispatch to crew planner instead.",
    });
  }

  // Best-effort double-click guard (no schema change): reject a second
  // generate while a fresh active DRAFT attempt already exists.
  const inFlight = await db.executionPlan.findFirst({
    where: {
      goalId: goal.id,
      isActiveAttempt: true,
      status: ExecutionPlanStatus.DRAFT,
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
    select: { id: true },
  });
  if (inFlight) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A plan is already being generated for this goal.",
    });
  }

  const client = await resolveWorkspaceProviderClient(db, params.workspaceId, ws.aiProvider);
  if (!client) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `No AI provider is configured (${ws.aiProvider}). Add a key in Settings → Workspace → AI, or use Dispatch to crew planner.`,
    });
  }

  // Role hints for assigned_role (purely advisory; workers are resolved from
  // the crew when steps go READY).
  let crewRoles: string[] = [];
  if (goal.crewId) {
    const members = await db.agentCrewMember.findMany({
      where: { crewId: goal.crewId },
      select: { role: true },
    });
    crewRoles = Array.from(new Set(members.map((m) => m.role)));
  }

  // The slow/external call — OUTSIDE any transaction.
  const generated = await runPlanGeneration(client, {
    goalTitle: goal.title,
    goalDescription: goal.description,
    crewRoles,
    model: ws.aiModel,
  });
  if (!generated || generated.length === 0) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "The model did not return any plan steps. Try again, or dispatch to a crew planner.",
    });
  }

  // Cancel + reap any prior dispatching attempt before starting a fresh one,
  // so two plans don't drive the same goal at once (was: a prior RUNNING plan
  // kept dispatching steps + spending in the background after re-generate).
  await demoteAndReapPriorAttempts(db, { workspaceId: params.workspaceId, goalId: goal.id });
  const result = await db.$transaction(async (tx) => {
    const plan = await tx.executionPlan.create({
      data: {
        workspaceId: params.workspaceId,
        title: `Plan for: ${goal.title}`.slice(0, 300),
        description: goal.description,
        issueId: goal.issueId,
        status: ExecutionPlanStatus.DRAFT,
        createdById: params.actorAgentId ? null : params.actorId,
        createdByAgentId: params.actorAgentId ?? null,
        contextSetId: params.contextSetId ?? null,
        crewId: goal.crewId,
        goalId: goal.id,
        isActiveAttempt: true,
        maxTotalCostUsd: goal.maxTotalCostUsd,
        maxWallTimeMinutes: goal.maxWallTimeMinutes,
      },
    });
    // Flip goal → PLANNING.
    if (goal.status !== GoalStatus.PLANNING) {
      await tx.goal.update({
        where: { id: goal.id },
        data: { status: GoalStatus.PLANNING },
      });
      await recordChange(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        entity: "goal",
        entityId: goal.id,
        action: "status",
        before: { status: goal.status },
        after: { status: GoalStatus.PLANNING },
        eventKind: EventKind.GOAL_STATUS_CHANGED,
        subjectType: "goal",
        subjectId: goal.id,
        payload: { from: goal.status, to: GoalStatus.PLANNING },
      });
    }
    // Plan-created event — action "generate" distinguishes Forge-built plans
    // from dispatched-planner ("decompose") plans for the UI / analytics.
    await tx.activityEvent.create({
      data: {
        workspaceId: params.workspaceId,
        kind: EventKind.ISSUE_UPDATED,
        actorId: params.actorId,
        subjectType: "execution-plan",
        subjectId: plan.id,
        payload: {
          action: "generate",
          goalId: goal.id,
          goalTitle: goal.title,
          provider: client.providerId,
          stepCount: generated.length,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        entity: "execution-plan",
        entityId: plan.id,
        action: "generate",
        after: { goalId: goal.id, stepCount: generated.length },
      },
    });
    // Steps in the SAME tx — whole generate rolls back atomically on failure.
    const stepIds = await insertStepsTx(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      planId: plan.id,
      steps: generated.map((s) => ({
        title: s.title,
        body: s.body,
        expectedOutput: s.expectedOutput,
        verification: s.verification.length ? (s.verification as Prisma.InputJsonValue) : null,
        dependsOnStepIndexes: s.dependsOnStepIndexes,
      })),
    });
    return { planId: plan.id, stepCount: stepIds.length };
  });

  return { planId: result.planId, status: "PLANNING", stepCount: result.stepCount };
}

// ---------------------------------------------------------------------------
// attachPlan — link an already-authored ExecutionPlan to a Goal. The
// counterpart to decompose for hand-built plans: instead of the LLM planner
// generating steps, an operator/agent authors the plan (e.g. via
// executionPlans.create + plans.addSteps) and then attaches it. When
// `makeActive` (default true) the plan becomes the goal's active attempt and
// any prior active attempt is demoted.
// ---------------------------------------------------------------------------

export async function attachPlanToGoal(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    goalId: string;
    planId: string;
    makeActive?: boolean;
  },
): Promise<{ planId: string; goalId: string }> {
  const makeActive = params.makeActive ?? true;

  const goal = await db.goal.findFirst({
    where: { id: params.goalId, workspaceId: params.workspaceId },
    select: { id: true, status: true },
  });
  if (!goal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found." });
  }
  if (goal.status === GoalStatus.ACHIEVED || goal.status === GoalStatus.ABANDONED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot attach a plan to a ${goal.status.toLowerCase()} goal.`,
    });
  }

  const plan = await db.executionPlan.findFirst({
    where: { id: params.planId, workspaceId: params.workspaceId, archivedAt: null },
    select: { id: true, goalId: true },
  });
  if (!plan) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
  }
  if (plan.goalId && plan.goalId !== goal.id) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Plan is already attached to a different goal.",
    });
  }

  await db.$transaction(async (tx) => {
    if (makeActive) {
      await tx.executionPlan.updateMany({
        where: { goalId: goal.id, isActiveAttempt: true, id: { not: plan.id } },
        data: { isActiveAttempt: false },
      });
    }
    await tx.executionPlan.update({
      where: { id: plan.id },
      data: { goalId: goal.id, isActiveAttempt: makeActive ? true : undefined },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      entity: "execution-plan",
      entityId: plan.id,
      action: "attach-goal",
      before: { goalId: plan.goalId },
      after: { goalId: goal.id, isActiveAttempt: makeActive },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "execution-plan",
      subjectId: plan.id,
      payload: { action: "attach-goal", goalId: goal.id, makeActive },
    });
  });

  return { planId: plan.id, goalId: goal.id };
}

// ---------------------------------------------------------------------------
// addSteps — the PLANNER bulk-fills a DRAFT plan with index-based deps.
// ---------------------------------------------------------------------------

export interface AddStepInput {
  title: string;
  body?: string | null;
  expectedOutput?: string | null;
  verification?: Prisma.InputJsonValue | null;
  dependsOnStepIndexes?: number[];
  assignedAgentId?: string | null;
  assignedRole?: string | null;
}

/**
 * The transactional core of bulk step insertion: two-pass create (so
 * index-based deps resolve to real ids) + plan touch + addSteps audit/event.
 * Shared by `addStepsToPlan` (validates first, then opens its own tx) and
 * `generatePlanForGoal` (calls this inside the plan-create tx so the whole
 * generate is one rollback-safe unit). Assumes the plan exists, is DRAFT, and
 * any explicit assignees were already validated by the caller.
 */
/**
 * Reject a set of steps whose index-based dependencies form a cycle (Kahn's
 * algorithm). A mutually-dependent pair (step 0 ↔ step 1) would otherwise leave
 * the plan RUNNING forever — cascadeReadiness flips nothing, maybeCompleteGoal
 * never fires, and no error surfaces. A bad LLM planner output silently wedges
 * the goal. Out-of-range / self indexes are ignored (dropped elsewhere too).
 */
export function assertNoStepCycles(steps: { dependsOnStepIndexes?: number[] }[]): void {
  const n = steps.length;
  const indeg = new Array<number>(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const d of steps[i].dependsOnStepIndexes ?? []) {
      if (!Number.isInteger(d) || d < 0 || d >= n || d === i) continue;
      adj[d].push(i);
      indeg[i]++;
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  let seen = 0;
  while (queue.length) {
    const u = queue.shift()!;
    seen++;
    for (const v of adj[u]) if (--indeg[v] === 0) queue.push(v);
  }
  if (seen !== n) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Plan steps contain a dependency cycle — steps can't depend on each other in a loop.",
    });
  }
}

async function insertStepsTx(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    planId: string;
    steps: AddStepInput[];
  },
): Promise<string[]> {
  assertNoStepCycles(params.steps);
  const last = await tx.executionStep.findFirst({
    where: { planId: params.planId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const basePosition = (last?.position ?? -1) + 1;

  // First pass: create steps without deps so we get real ids by index.
  const createdIds: string[] = [];
  for (let i = 0; i < params.steps.length; i++) {
    const s = params.steps[i];
    const created = await tx.executionStep.create({
      data: {
        workspaceId: params.workspaceId,
        planId: params.planId,
        title: s.title.trim(),
        body: s.body ?? null,
        position: basePosition + i,
        assignedAgentId: s.assignedAgentId ?? null,
        expectedOutput: s.expectedOutput ?? null,
        verification:
          s.verification === undefined || s.verification === null
            ? Prisma.JsonNull
            : s.verification,
        dependsOnStepIds: [],
      },
      select: { id: true },
    });
    createdIds.push(created.id);
  }

  // Second pass: resolve index-based deps to real ids. Indexes refer to
  // the position WITHIN this batch (0-based). Out-of-range or
  // self-referential indexes are dropped defensively.
  for (let i = 0; i < params.steps.length; i++) {
    const s = params.steps[i];
    const idxs = s.dependsOnStepIndexes ?? [];
    if (!idxs.length) continue;
    const dependsOnStepIds = idxs
      .filter((idx) => idx >= 0 && idx < createdIds.length && idx !== i)
      .map((idx) => createdIds[idx]);
    if (dependsOnStepIds.length === 0) continue;
    await tx.executionStep.update({
      where: { id: createdIds[i] },
      data: { dependsOnStepIds },
    });
  }

  await tx.executionPlan.update({
    where: { id: params.planId },
    data: { updatedAt: new Date() },
  });
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    entity: "execution-plan",
    entityId: params.planId,
    action: "addSteps",
    after: { stepCount: createdIds.length },
    eventKind: EventKind.ISSUE_UPDATED,
    subjectType: "execution-plan",
    subjectId: params.planId,
    payload: { stepCount: createdIds.length },
  });
  return createdIds;
}

export async function addStepsToPlan(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    planId: string;
    steps: AddStepInput[];
  },
): Promise<{ stepIds: string[] }> {
  const plan = await db.executionPlan.findFirst({
    where: { id: params.planId, workspaceId: params.workspaceId, archivedAt: null },
    select: { id: true, status: true },
  });
  if (!plan) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
  }
  if (plan.status !== ExecutionPlanStatus.DRAFT) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Steps can only be bulk-added to a DRAFT plan.",
    });
  }
  // Validate any explicit assignee agents belong to the workspace.
  const agentIds = Array.from(
    new Set(params.steps.map((s) => s.assignedAgentId).filter((x): x is string => !!x)),
  );
  if (agentIds.length) {
    const found = await db.agent.findMany({
      where: { id: { in: agentIds }, workspaceId: params.workspaceId },
      select: { id: true },
    });
    if (found.length !== agentIds.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "One or more assignedAgentId values are not agents in this workspace.",
      });
    }
  }

  const stepIds = await db.$transaction((tx) => insertStepsTx(tx, params));

  return { stepIds };
}

// ---------------------------------------------------------------------------
// Readiness cascade + step transition with dispatch.
// ---------------------------------------------------------------------------

/**
 * Re-evaluate every TODO step in a plan: flip to READY when all its
 * `dependsOnStepIds` are DONE. Steps with no deps become READY immediately.
 * Each newly-READY step emits EXECUTION_STEP_READY and dispatches its worker.
 * Returns the ids that flipped.
 */
export async function cascadeReadiness(
  tx: Tx,
  params: { workspaceId: string; planId: string; actorId: string | null },
): Promise<string[]> {
  // A plan only dispatches while RUNNING. Once it is BLOCKED (budget /
  // wall-time watchdog) or CANCELED (goal abandoned or superseded by a new
  // decompose attempt), a step that finishes must NOT cascade its dependents
  // into fresh dispatches — that would spend exactly the budget the operator
  // was asked to approve, and un-pause a plan the operator deliberately
  // stopped. DRAFT/APPROVED never dispatch either (activatePlan flips RUNNING
  // first, then cascades).
  const plan = await tx.executionPlan.findUnique({
    where: { id: params.planId },
    select: { status: true },
  });
  if (!plan || plan.status !== ExecutionPlanStatus.RUNNING) return [];
  const steps = await tx.executionStep.findMany({
    where: { planId: params.planId },
    select: { id: true, status: true, dependsOnStepIds: true },
  });
  const statusById = new Map(steps.map((s) => [s.id, s.status]));
  const flipped: string[] = [];
  for (const step of steps) {
    if (step.status !== ExecutionStepStatus.TODO) continue;
    const allDepsDone = step.dependsOnStepIds.every(
      (depId) => statusById.get(depId) === ExecutionStepStatus.DONE,
    );
    if (!allDepsDone) continue;
    await transitionStepToReady(tx, {
      workspaceId: params.workspaceId,
      stepId: step.id,
      actorId: params.actorId,
    });
    flipped.push(step.id);
  }
  return flipped;
}

/**
 * Flip a step to READY, emit EXECUTION_STEP_READY, resolve its worker
 * (explicit assignee or a crew WORKER), and queue the dispatch. Worker
 * payload carries body + expectedOutput + contextSet + lastFeedback.
 */
async function transitionStepToReady(
  tx: Tx,
  params: { workspaceId: string; stepId: string; actorId: string | null },
): Promise<void> {
  const step = await tx.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: {
      id: true,
      planId: true,
      title: true,
      body: true,
      expectedOutput: true,
      verification: true,
      assignedAgentId: true,
      lastFeedback: true,
      retryCount: true,
      status: true,
      issueId: true,
      plan: {
        select: { id: true, status: true, crewId: true, contextSetId: true, issueId: true },
      },
    },
  });
  if (!step) return;
  // Defence in depth for callers other than cascadeReadiness (e.g. the
  // recordVerdict RETRY path, which re-readies a step directly): never
  // dispatch a step whose plan is no longer RUNNING. A late verdict on a
  // step whose plan was CANCELED/BLOCKED mid-flight must not re-open work.
  if (step.plan.status !== ExecutionPlanStatus.RUNNING) return;

  // Resolve the worker: explicit assignee > crew WORKER.
  let workerAgentId = step.assignedAgentId;
  if (!workerAgentId && step.plan.crewId) {
    workerAgentId = await pickCrewMember(tx, step.plan.crewId, "WORKER");
  }

  await tx.executionStep.update({
    where: { id: step.id },
    data: {
      status: ExecutionStepStatus.READY,
      assignedAgentId: workerAgentId ?? step.assignedAgentId,
    },
  });
  await tx.executionPlan.update({
    where: { id: step.planId },
    data: { updatedAt: new Date() },
  });

  const event = await tx.activityEvent.create({
    data: {
      workspaceId: params.workspaceId,
      kind: EventKind.EXECUTION_STEP_READY,
      actorId: params.actorId,
      subjectType: "execution-step",
      subjectId: step.id,
      payload: {
        planId: step.planId,
        stepId: step.id,
        title: step.title,
        body: step.body,
        expectedOutput: step.expectedOutput,
        verification: step.verification ?? null,
        contextSetId: step.plan.contextSetId,
        assignedAgentId: workerAgentId,
        lastFeedback: step.lastFeedback,
        retryCount: step.retryCount,
      } as Prisma.InputJsonValue,
    },
  });
  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "execution-step",
      entityId: step.id,
      action: "ready",
      before: { status: step.status },
      after: { status: ExecutionStepStatus.READY },
    },
  });
  if (workerAgentId) {
    const worker = await tx.agent.findFirst({
      where: { id: workerAgentId, workspaceId: params.workspaceId, archivedAt: null },
      select: ORCH_WORKER_SELECT,
    });
    const isRuntimeOnlyWorker = Boolean(worker?.runtimeId && !worker.webhookUrl);
    // Open an observable AgentRun for this step (AXI-57) so orchestrated turns
    // show up in Mission Control / the watchdog / cost. Bind to the step's own
    // issue when materialized, otherwise the plan's anchor issue. Runtime-only
    // agents (Codex app-server, Hermes runs without a webhook) need an issue
    // to start a structured run, so auto-materialize only when no anchor exists.
    let runIssueId = step.issueId ?? step.plan.issueId ?? null;
    if (!runIssueId && isRuntimeOnlyWorker) {
      const materialized = await materializeStepAsIssueTx(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        stepId: step.id,
      });
      runIssueId = materialized.issueId;
    }
    if (runIssueId && worker) {
      await openOrTouchRun(tx, {
        workspaceId: params.workspaceId,
        issueId: runIssueId,
        agentId: workerAgentId,
        actorId: params.actorId,
        assignmentEventId: event.id,
        triggerEventId: event.id,
        triggerKind: EventKind.EXECUTION_STEP_READY,
        currentStep: step.title,
        executionStepId: step.id,
        ...orchestrationRunStamp(worker),
      });
    }
    if (!isRuntimeOnlyWorker) {
      await queueAgentDispatch(tx, {
        workspaceId: params.workspaceId,
        agentId: workerAgentId,
        eventId: event.id,
      });
    }
  }
}

/**
 * Operator retry for a plan step whose prior AgentRun failed/stalled. This is
 * intentionally step-aware: it opens the replacement AgentRun with
 * `executionStepId`, so Goals/Plans continue to observe the retry instead of
 * waking only the materialized issue.
 */
export async function retryExecutionStep(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    stepId: string;
  },
): Promise<{ stepId: string; planId: string; issueId: string; runId: string; agentId: string }> {
  return db.$transaction(async (tx) => {
    const step = await tx.executionStep.findFirst({
      where: { id: params.stepId, workspaceId: params.workspaceId },
      select: {
        id: true,
        planId: true,
        title: true,
        body: true,
        expectedOutput: true,
        verification: true,
        assignedAgentId: true,
        lastFeedback: true,
        retryCount: true,
        status: true,
        issueId: true,
        plan: {
          select: {
            id: true,
            status: true,
            crewId: true,
            contextSetId: true,
            issueId: true,
          },
        },
      },
    });
    if (!step) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
    }
    if (step.status === ExecutionStepStatus.DONE || step.status === ExecutionStepStatus.CANCELED) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Cannot retry a ${step.status.toLowerCase()} step.`,
      });
    }
    if (
      step.plan.status !== ExecutionPlanStatus.RUNNING &&
      step.plan.status !== ExecutionPlanStatus.BLOCKED
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Plan must be running or blocked to retry a step (is ${step.plan.status}).`,
      });
    }

    const activeRun = await tx.agentRun.findFirst({
      where: {
        workspaceId: params.workspaceId,
        executionStepId: step.id,
        status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      },
      select: { id: true },
    });
    if (activeRun) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This step already has an active run.",
      });
    }

    let workerAgentId = step.assignedAgentId;
    if (!workerAgentId && step.plan.crewId) {
      workerAgentId = await pickCrewMember(tx, step.plan.crewId, "WORKER");
    }
    if (!workerAgentId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No worker is assigned to this step or its crew.",
      });
    }
    const worker = await tx.agent.findFirst({
      where: { id: workerAgentId, workspaceId: params.workspaceId, archivedAt: null },
      select: ORCH_WORKER_SELECT,
    });
    if (!worker) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Assigned worker not found." });
    }

    let runIssueId = step.issueId ?? step.plan.issueId ?? null;
    if (!runIssueId) {
      const materialized = await materializeStepAsIssueTx(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        stepId: step.id,
      });
      runIssueId = materialized.issueId;
    }

    await tx.executionStep.update({
      where: { id: step.id },
      data: {
        status: ExecutionStepStatus.READY,
        assignedAgentId: workerAgentId,
        issueId: runIssueId,
      },
    });
    if (step.plan.status === ExecutionPlanStatus.BLOCKED) {
      await tx.executionPlan.update({
        where: { id: step.planId },
        data: { status: ExecutionPlanStatus.RUNNING, updatedAt: new Date() },
      });
      await recordChange(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        actorAgentId: params.actorAgentId ?? null,
        entity: "execution-plan",
        entityId: step.planId,
        action: "resume",
        before: { status: ExecutionPlanStatus.BLOCKED },
        after: { status: ExecutionPlanStatus.RUNNING },
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "execution-plan",
        subjectId: step.planId,
        payload: { from: ExecutionPlanStatus.BLOCKED, to: ExecutionPlanStatus.RUNNING },
      });
    } else {
      await tx.executionPlan.update({
        where: { id: step.planId },
        data: { updatedAt: new Date() },
      });
    }

    const event = await tx.activityEvent.create({
      data: {
        workspaceId: params.workspaceId,
        kind: EventKind.EXECUTION_STEP_READY,
        actorId: params.actorId,
        subjectType: "execution-step",
        subjectId: step.id,
        payload: {
          planId: step.planId,
          stepId: step.id,
          title: step.title,
          body: step.body,
          expectedOutput: step.expectedOutput,
          verification: step.verification ?? null,
          contextSetId: step.plan.contextSetId,
          assignedAgentId: workerAgentId,
          lastFeedback: step.lastFeedback,
          retryCount: step.retryCount,
          retry: true,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        actorAgentId: params.actorAgentId ?? null,
        entity: "execution-step",
        entityId: step.id,
        action: "retry",
        before: { status: step.status },
        after: { status: ExecutionStepStatus.READY, assignedAgentId: workerAgentId },
      },
    });

    const { run } = await openOrTouchRun(tx, {
      workspaceId: params.workspaceId,
      issueId: runIssueId,
      agentId: workerAgentId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      assignmentEventId: event.id,
      triggerEventId: event.id,
      triggerKind: EventKind.EXECUTION_STEP_READY,
      currentStep: step.title,
      executionStepId: step.id,
      ...orchestrationRunStamp(worker),
    });

    const isRuntimeOnlyWorker = Boolean(worker.runtimeId && !worker.webhookUrl);
    if (!isRuntimeOnlyWorker) {
      await queueAgentDispatch(tx, {
        workspaceId: params.workspaceId,
        agentId: workerAgentId,
        eventId: event.id,
      });
    }

    return {
      stepId: step.id,
      planId: step.planId,
      issueId: runIssueId,
      runId: run.id,
      agentId: workerAgentId,
    };
  });
}

// ---------------------------------------------------------------------------
// Judge loop.
// ---------------------------------------------------------------------------

/**
 * Dispatch a JUDGE/REVIEWER to evaluate a step in REVIEW. Resolves the
 * reviewer (explicit override > crew REVIEWER) and queues the dispatch.
 * Returns the resolved judge id (or null if none could be resolved).
 */
export async function dispatchJudge(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    stepId: string;
    judgeAgentId?: string | null;
  },
): Promise<{ judgeAgentId: string | null; runId: string | null; issueId: string | null }> {
  const step = await db.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: {
      id: true,
      planId: true,
      title: true,
      body: true,
      expectedOutput: true,
      verification: true,
      status: true,
      issueId: true,
      plan: { select: { id: true, crewId: true, issueId: true, contextSetId: true } },
    },
  });
  if (!step) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
  }
  if (step.status !== ExecutionStepStatus.REVIEW) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Step must be in review before a reviewer can start (is ${step.status.toLowerCase()}).`,
    });
  }
  let judgeAgentId: string | null = params.judgeAgentId ?? null;
  if (judgeAgentId) {
    const ok = await db.agent.findFirst({
      where: { id: judgeAgentId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "judgeAgentId not in this workspace." });
    }
  }
  if (!judgeAgentId && step.plan.crewId) {
    judgeAgentId = await pickCrewMember(db, step.plan.crewId, "REVIEWER");
  }

  if (!judgeAgentId) {
    return { judgeAgentId: null, runId: null, issueId: null };
  }
  const judge = await db.agent.findFirst({
    where: { id: judgeAgentId, workspaceId: params.workspaceId, archivedAt: null },
    select: ORCH_WORKER_SELECT,
  });
  if (!judge) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Reviewer not found." });
  }

  return db.$transaction(async (tx) => {
    let runIssueId = step.issueId ?? step.plan.issueId ?? null;
    if (!runIssueId) {
      const materialized = await materializeStepAsIssueTx(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        stepId: step.id,
      });
      runIssueId = materialized.issueId;
    }
    const event = await tx.activityEvent.create({
      data: {
        workspaceId: params.workspaceId,
        kind: EventKind.EXECUTION_STEP_READY,
        actorId: params.actorId,
        subjectType: "execution-step",
        subjectId: step.id,
        payload: {
          phase: "judge",
          planId: step.planId,
          stepId: step.id,
          title: step.title,
          body: step.body,
          expectedOutput: step.expectedOutput,
          verification: step.verification ?? null,
          contextSetId: step.plan.contextSetId,
          judgeAgentId,
          assignedAgentId: judgeAgentId,
          engagementMode: EngagementMode.REVIEW,
          prompt:
            `You are the JUDGE for step "${step.title}". Evaluate the worker's ` +
            `output against expectedOutput + verification, then call ` +
            `plans.recordVerdict({ stepId: "${step.id}", verdict: "PASS"|"FAIL", feedback, score? }).`,
        } as Prisma.InputJsonValue,
      },
    });
    const { run } = await openOrTouchRun(tx, {
      workspaceId: params.workspaceId,
      issueId: runIssueId,
      agentId: judgeAgentId,
      actorId: params.actorId,
      assignmentEventId: event.id,
      triggerEventId: event.id,
      triggerKind: EventKind.EXECUTION_STEP_READY,
      currentStep: `Reviewing: ${step.title}`,
      executionStepId: step.id,
      ...orchestrationRunStamp(judge, EngagementMode.REVIEW),
    });
    const isRuntimeOnlyJudge = Boolean(judge.runtimeId && !judge.webhookUrl);
    if (!isRuntimeOnlyJudge) {
      await queueAgentDispatch(tx, {
        workspaceId: params.workspaceId,
        agentId: judgeAgentId,
        eventId: event.id,
      });
    }
    return { judgeAgentId, runId: run.id, issueId: runIssueId };
  });
}

/**
 * Record a judge verdict on a step and run the loop transition:
 *   PASS  → step DONE, cascade readiness on the plan.
 *   FAIL  → if retries remain: step READY, retryCount++, store feedback,
 *           re-dispatch worker. Else: step BLOCKED + open a ReviewGate.
 */
export async function recordVerdict(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    stepId: string;
    verdict: "PASS" | "FAIL";
    feedback: string;
    score?: number | null;
  },
): Promise<{ outcome: "DONE" | "RETRY" | "BLOCKED"; retryCount: number }> {
  return db.$transaction((tx) => recordVerdictTx(tx, params));
}

/** Transactional verdict primitive shared by judges and human ReviewGates. */
export async function recordVerdictTx(
  tx: Tx,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    stepId: string;
    verdict: "PASS" | "FAIL";
    feedback: string;
    score?: number | null;
  },
): Promise<{ outcome: "DONE" | "RETRY" | "BLOCKED"; retryCount: number }> {
  const step = await tx.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: {
      id: true,
      planId: true,
      status: true,
      retryCount: true,
      title: true,
      plan: { select: { id: true, maxStepRetries: true, crewId: true, goalId: true } },
    },
  });
  if (!step) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
  }
  // A verdict may only land on an in-flight step (READY / RUNNING / REVIEW).
  // Reject it on an already-settled step (DONE / BLOCKED / CANCELED): a stale
  // or duplicated reviewer webhook posting FAIL on a DONE step would otherwise
  // move it back to TODO, bump retryCount, and re-dispatch a worker —
  // un-completing finished work and desyncing downstream steps. Also stops an
  // auto-judge double-fire from double-recording.
  if (
    step.status === ExecutionStepStatus.DONE ||
    step.status === ExecutionStepStatus.BLOCKED ||
    step.status === ExecutionStepStatus.CANCELED
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Step is ${step.status} — a verdict can't be recorded on a settled step.`,
    });
  }

  const verdictJson: JudgeVerdictJson = {
    verdict: params.verdict,
    feedback: params.feedback,
    ...(params.score != null ? { score: params.score } : {}),
    ...(params.actorAgentId ? { judgedByAgentId: params.actorAgentId } : {}),
    judgedAt: new Date().toISOString(),
  };

  let nextRetryCount = step.retryCount;
  const settleReviewerRuns = async () => {
    const activeReviewRuns = await tx.agentRun.findMany({
      where: {
        workspaceId: params.workspaceId,
        executionStepId: step.id,
        engagementMode: EngagementMode.REVIEW,
        status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      },
      select: { id: true, issueId: true, agentId: true },
    });
    for (const run of activeReviewRuns) {
      const completedByThisReviewer = params.actorAgentId === run.agentId;
      await finishRun(tx, {
        runId: run.id,
        workspaceId: params.workspaceId,
        issueId: run.issueId,
        agentId: run.agentId,
        status: completedByThisReviewer ? "COMPLETED" : "ABANDONED",
        summary: completedByThisReviewer
          ? `Review ${params.verdict.toLowerCase()}: ${params.feedback}`
          : `Review resolved by ${params.actorAgentId ? "another agent" : "a human reviewer"}.`,
        actorId: params.actorId,
        actorAgentId: params.actorAgentId ?? null,
      });
    }
    if (params.actorAgentId) {
      const pendingGates = await tx.reviewGate.findMany({
        where: {
          workspaceId: params.workspaceId,
          targetType: "execution-step",
          targetId: step.id,
          status: "PENDING",
        },
        select: { id: true, status: true },
      });
      for (const gate of pendingGates) {
        const status = params.verdict === "PASS" ? "APPROVED" : "REJECTED";
        await tx.reviewGate.update({
          where: { id: gate.id },
          data: {
            status,
            resolvedByAgentId: params.actorAgentId,
            resolvedAt: new Date(),
            resolution: params.feedback,
          },
        });
        await recordChange(tx, {
          workspaceId: params.workspaceId,
          actorId: params.actorId,
          actorAgentId: params.actorAgentId,
          entity: "review-gate",
          entityId: gate.id,
          action: "resolved",
          before: { status: gate.status },
          after: { status, verdict: params.verdict },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "review-gate",
          subjectId: gate.id,
          payload: { status, verdict: params.verdict, stepId: step.id },
        });
      }
    }
  };

  if (params.verdict === "PASS") {
    await tx.executionStep.update({
      where: { id: step.id },
      data: {
        status: ExecutionStepStatus.DONE,
        judgeVerdict: verdictJson as unknown as Prisma.InputJsonValue,
        lastFeedback: null,
      },
    });
    await recordStepJudged(tx, params, step, verdictJson, "DONE");
    await cascadeReadiness(tx, {
      workspaceId: params.workspaceId,
      planId: step.planId,
      actorId: params.actorId,
    });
    await maybeCompleteGoal(tx, {
      workspaceId: params.workspaceId,
      planId: step.planId,
      actorId: params.actorId,
    });
    await settleReviewerRuns();
    return { outcome: "DONE", retryCount: nextRetryCount };
  }

  // FAIL.
  if (step.retryCount < step.plan.maxStepRetries) {
    nextRetryCount = step.retryCount + 1;
    await tx.executionStep.update({
      where: { id: step.id },
      data: {
        status: ExecutionStepStatus.TODO,
        retryCount: nextRetryCount,
        lastFeedback: params.feedback,
        judgeVerdict: verdictJson as unknown as Prisma.InputJsonValue,
      },
    });
    await recordStepJudged(tx, params, step, verdictJson, "RETRY");
    await transitionStepToReady(tx, {
      workspaceId: params.workspaceId,
      stepId: step.id,
      actorId: params.actorId,
    });
    await settleReviewerRuns();
    return { outcome: "RETRY", retryCount: nextRetryCount };
  }

  // Retries exhausted → BLOCKED + ReviewGate.
  await tx.executionStep.update({
    where: { id: step.id },
    data: {
      status: ExecutionStepStatus.BLOCKED,
      judgeVerdict: verdictJson as unknown as Prisma.InputJsonValue,
      lastFeedback: params.feedback,
    },
  });
  await recordStepJudged(tx, params, step, verdictJson, "BLOCKED");
  await openReviewGateTx(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    targetType: "execution-step",
    targetId: step.id,
    prompt:
      `Step "${step.title}" failed judging ${nextRetryCount + 1} time(s) ` +
      `(retry budget exhausted). Latest feedback: ${params.feedback}. ` +
      `Intervene: revise the step, reassign, or abandon the plan.`,
    requiredRole: null,
    crewId: step.plan.crewId,
  });
  await settleReviewerRuns();
  return { outcome: "BLOCKED", retryCount: nextRetryCount };
}

async function recordStepJudged(
  tx: Tx,
  params: { workspaceId: string; actorId: string | null; stepId: string },
  step: { status: ExecutionStepStatus; planId: string },
  verdict: JudgeVerdictJson,
  outcome: "DONE" | "RETRY" | "BLOCKED",
): Promise<void> {
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    entity: "execution-step",
    entityId: params.stepId,
    action: "judged",
    before: { status: step.status },
    after: { verdict: verdict.verdict, outcome },
    eventKind: EventKind.EXECUTION_STEP_JUDGED,
    subjectType: "execution-step",
    subjectId: params.stepId,
    payload: {
      planId: step.planId,
      verdict: verdict.verdict,
      feedback: verdict.feedback,
      score: verdict.score ?? null,
      outcome,
    } as Prisma.InputJsonValue,
  });
}

/**
 * Auto-judge hook: invoked when a step transitions to REVIEW. When the
 * plan has autoJudge=true and a REVIEWER crew member exists, dispatch the
 * judge. Best-effort — no-op when autoJudge is off or no reviewer.
 */
export async function maybeAutoJudge(
  db: PrismaClient,
  params: { workspaceId: string; actorId: string | null; stepId: string },
): Promise<{ dispatched: boolean; humanReviewRequired?: boolean }> {
  const step = await db.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: {
      id: true,
      status: true,
      plan: { select: { autoJudge: true, crewId: true } },
    },
  });
  if (!step) return { dispatched: false };
  if (step.status !== ExecutionStepStatus.REVIEW) return { dispatched: false };
  if (!step.plan.autoJudge) {
    await ensureHumanReviewGate(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      stepId: step.id,
      crewId: step.plan.crewId,
      reason:
        "This completed plan step is ready for manual review. Record a PASS or FAIL verdict to continue the plan.",
    });
    return { dispatched: false, humanReviewRequired: true };
  }
  if (!step.plan.crewId) {
    await ensureHumanReviewGate(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      stepId: step.id,
      crewId: null,
      reason:
        "This completed plan step has no crew or REVIEWER. Review it manually or assign a reviewer to continue the plan.",
    });
    return { dispatched: false, humanReviewRequired: true };
  }
  const reviewer = await pickCrewMember(db, step.plan.crewId, "REVIEWER");
  if (!reviewer) {
    await ensureHumanReviewGate(db, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      stepId: step.id,
      crewId: step.plan.crewId,
      reason:
        "This completed plan step has no REVIEWER in its crew. Review it manually or add a reviewer to continue the plan.",
    });
    return { dispatched: false, humanReviewRequired: true };
  }
  await dispatchJudge(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    stepId: params.stepId,
    judgeAgentId: reviewer,
  });
  return { dispatched: true };
}

async function ensureHumanReviewGate(
  db: Tx,
  params: {
    workspaceId: string;
    actorId: string | null;
    stepId: string;
    crewId: string | null;
    reason: string;
  },
): Promise<string> {
  const existing = await db.reviewGate.findFirst({
    where: {
      workspaceId: params.workspaceId,
      targetType: "execution-step",
      targetId: params.stepId,
      status: "PENDING",
    },
    select: { id: true },
  });
  if (existing) return existing.id;
  const gate = await openReviewGateTx(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    targetType: "execution-step",
    targetId: params.stepId,
    prompt: params.reason,
    requiredRole: null,
    crewId: params.crewId,
  });
  return gate.id;
}

/**
 * Atomically connect a clean runs.complete result back to its owning plan
 * step. The run remains the immutable evidence row; REVIEW is the only safe
 * automatic destination because a successful worker completion still needs a
 * reviewer verdict before dependencies may advance.
 */
export async function handoffCompletedRunToStep(
  tx: Tx,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    runId: string;
    stepId: string;
  },
): Promise<{ transitioned: boolean; status: ExecutionStepStatus }> {
  const step = await tx.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: { id: true, planId: true, status: true, sourceRunId: true },
  });
  if (!step) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
  }
  if (
    step.status === ExecutionStepStatus.DONE ||
    step.status === ExecutionStepStatus.CANCELED ||
    step.status === ExecutionStepStatus.BLOCKED
  ) {
    return { transitioned: false, status: step.status };
  }
  const transitioned = step.status !== ExecutionStepStatus.REVIEW;
  await tx.executionStep.update({
    where: { id: step.id },
    data: { status: ExecutionStepStatus.REVIEW, sourceRunId: params.runId },
  });
  await tx.executionPlan.update({
    where: { id: step.planId },
    data: { updatedAt: new Date() },
  });
  if (transitioned || step.sourceRunId !== params.runId) {
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      entity: "execution-step",
      entityId: step.id,
      action: "run-completed",
      before: { status: step.status, sourceRunId: step.sourceRunId },
      after: { status: ExecutionStepStatus.REVIEW, sourceRunId: params.runId },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "execution-step",
      subjectId: step.id,
      payload: {
        planId: step.planId,
        runId: params.runId,
        from: step.status,
        to: ExecutionStepStatus.REVIEW,
      } as Prisma.InputJsonValue,
    });
  }
  return { transitioned, status: ExecutionStepStatus.REVIEW };
}

/**
 * When every step in the active plan is DONE, flip the goal → ACHIEVED and
 * the plan → COMPLETED. No-op if any step is non-DONE.
 */
export async function maybeCompleteGoal(
  tx: Tx,
  params: { workspaceId: string; planId: string; actorId: string | null },
): Promise<void> {
  const plan = await tx.executionPlan.findFirst({
    where: { id: params.planId, workspaceId: params.workspaceId },
    select: { id: true, goalId: true, status: true },
  });
  if (!plan || plan.status === ExecutionPlanStatus.COMPLETED) return;
  const remaining = await tx.executionStep.count({
    where: {
      planId: params.planId,
      status: { notIn: [ExecutionStepStatus.DONE, ExecutionStepStatus.CANCELED] },
    },
  });
  if (remaining > 0) return;
  const totalSteps = await tx.executionStep.count({ where: { planId: params.planId } });
  if (totalSteps === 0) return;
  await tx.executionPlan.update({
    where: { id: params.planId },
    data: { status: ExecutionPlanStatus.COMPLETED },
  });
  if (plan.goalId) {
    const goal = await tx.goal.findUnique({
      where: { id: plan.goalId },
      select: { id: true, status: true },
    });
    if (goal && goal.status !== GoalStatus.ACHIEVED && goal.status !== GoalStatus.ABANDONED) {
      await tx.goal.update({
        where: { id: goal.id },
        data: { status: GoalStatus.ACHIEVED, achievedAt: new Date() },
      });
      await recordChange(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        entity: "goal",
        entityId: goal.id,
        action: "achieved",
        before: { status: goal.status },
        after: { status: GoalStatus.ACHIEVED },
        eventKind: EventKind.GOAL_STATUS_CHANGED,
        subjectType: "goal",
        subjectId: goal.id,
        payload: { from: goal.status, to: GoalStatus.ACHIEVED, planId: params.planId },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Plan approval — wired into ActionRequest accept.
// ---------------------------------------------------------------------------

/**
 * Create the "approve N-step plan" ActionRequest. Called by the planner
 * (or operator) once a DRAFT plan has steps. Accept dispatches
 * `activatePlan` via the action-request service hook.
 */
export async function requestPlanApproval(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    planId: string;
    assignedUserId?: string | null;
  },
): Promise<{ actionRequestId: string }> {
  const plan = await db.executionPlan.findFirst({
    where: { id: params.planId, workspaceId: params.workspaceId },
    select: {
      id: true,
      status: true,
      goalId: true,
      issueId: true,
      goal: { select: { title: true } },
      _count: { select: { steps: true } },
    },
  });
  if (!plan) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
  }
  if (plan.status !== ExecutionPlanStatus.DRAFT) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only DRAFT plans can request approval.",
    });
  }
  if (plan._count.steps === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Plan has no steps to approve. Call plans.addSteps first.",
    });
  }
  const goalLabel = plan.goal?.title ?? "plan";
  const result = await createActionRequest(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    title: `Approve ${plan._count.steps}-step plan for: ${goalLabel}`.slice(0, 200),
    body:
      `A PLANNER decomposed this goal into ${plan._count.steps} steps. ` +
      `Accept to activate the plan (DRAFT → RUNNING) and begin dispatching workers.`,
    kind: ActionRequestKind.FREE_FORM,
    sourceType: "execution-plan",
    sourceId: plan.id,
    issueId: plan.issueId,
    assignedUserId: params.assignedUserId ?? null,
  });
  return { actionRequestId: result.id };
}

/**
 * Activate an approved plan: DRAFT → RUNNING, flip the goal → ACTIVE +
 * stamp startedAt, then run the readiness cascade so root steps dispatch.
 * Idempotent-ish: throws if the plan is not DRAFT/APPROVED.
 *
 * Called both by the action-request accept hook (sourceType ===
 * "execution-plan") and directly by an operator/MCP.
 */
export async function activatePlan(
  tx: Tx,
  params: { workspaceId: string; actorId: string | null; planId: string },
): Promise<void> {
  const plan = await tx.executionPlan.findFirst({
    where: { id: params.planId, workspaceId: params.workspaceId },
    select: { id: true, status: true, goalId: true },
  });
  if (!plan) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
  }
  if (plan.status !== ExecutionPlanStatus.DRAFT && plan.status !== ExecutionPlanStatus.APPROVED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Plan must be DRAFT or APPROVED to activate (is ${plan.status}).`,
    });
  }
  await tx.executionPlan.update({
    where: { id: plan.id },
    // Stamp startedAt so the wall-time budget clock starts at execution, not
    // at decompose. activatePlan only runs from DRAFT/APPROVED, so startedAt
    // is null here on the first (and only) activation.
    data: { status: ExecutionPlanStatus.RUNNING, startedAt: new Date() },
  });
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    entity: "execution-plan",
    entityId: plan.id,
    action: "activate",
    before: { status: plan.status },
    after: { status: ExecutionPlanStatus.RUNNING },
    eventKind: EventKind.ISSUE_UPDATED,
    subjectType: "execution-plan",
    subjectId: plan.id,
    payload: { from: plan.status, to: ExecutionPlanStatus.RUNNING },
  });
  if (plan.goalId) {
    const goal = await tx.goal.findUnique({
      where: { id: plan.goalId },
      select: { id: true, status: true, startedAt: true },
    });
    if (goal && goal.status !== GoalStatus.ACTIVE) {
      await tx.goal.update({
        where: { id: goal.id },
        data: {
          status: GoalStatus.ACTIVE,
          startedAt: goal.startedAt ?? new Date(),
        },
      });
      await recordChange(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        entity: "goal",
        entityId: goal.id,
        action: "status",
        before: { status: goal.status },
        after: { status: GoalStatus.ACTIVE },
        eventKind: EventKind.GOAL_STATUS_CHANGED,
        subjectType: "goal",
        subjectId: goal.id,
        payload: { from: goal.status, to: GoalStatus.ACTIVE, planId: plan.id },
      });
    }
  }
  // Dispatch root steps.
  await cascadeReadiness(tx, {
    workspaceId: params.workspaceId,
    planId: plan.id,
    actorId: params.actorId,
  });
}

// ---------------------------------------------------------------------------
// Budget watchdog — invoked from runs.recordUsage.
// ---------------------------------------------------------------------------

/**
 * Accumulate a run's incremental cost onto its plan + goal totals (when the
 * run finished a plan step) and, if a budget cap is now breached, BLOCK the
 * plan + open a "budget exceeded" ReviewGate. Called from runs.recordUsage.
 *
 * `costDelta` is the change to apply (the recordUsage call is replace-not-add
 * for the AgentRun row, so the caller computes prev→new delta). When no plan
 * is tied to the run, this is a no-op.
 */
export async function applyRunCostToPlan(
  db: PrismaClient,
  params: {
    workspaceId: string;
    runId: string;
    costDelta: number;
  },
): Promise<{ planId: string | null; breached: boolean }> {
  if (params.costDelta === 0) return { planId: null, breached: false };
  // Resolve the step this run executed. Prefer the AgentRun.executionStepId FK
  // (AXI-57); fall back to the legacy ExecutionStep.sourceRunId reverse-lookup
  // for runs created before the FK existed.
  const run = await db.agentRun.findFirst({
    where: { id: params.runId, workspaceId: params.workspaceId },
    select: { executionStepId: true },
  });
  const step =
    (run?.executionStepId
      ? await db.executionStep.findFirst({
          where: { id: run.executionStepId, workspaceId: params.workspaceId },
          select: { id: true, planId: true },
        })
      : null) ??
    (await db.executionStep.findFirst({
      where: { workspaceId: params.workspaceId, sourceRunId: params.runId },
      select: { id: true, planId: true },
    }));
  if (!step) return { planId: null, breached: false };

  let breached = false;
  await db.$transaction(async (tx) => {
    const plan = await tx.executionPlan.update({
      where: { id: step.planId },
      data: { totalCostUsd: { increment: params.costDelta } },
      select: {
        id: true,
        status: true,
        totalCostUsd: true,
        maxTotalCostUsd: true,
        maxWallTimeMinutes: true,
        crewId: true,
        goalId: true,
        createdAt: true,
        startedAt: true,
      },
    });
    if (plan.goalId) {
      await tx.goal.update({
        where: { id: plan.goalId },
        data: { totalCostUsd: { increment: params.costDelta } },
      });
    }
    breached = await checkAndBlockBudget(tx, { workspaceId: params.workspaceId, plan });
  });
  return { planId: step.planId, breached };
}

interface PlanBudgetRow {
  id: string;
  status: ExecutionPlanStatus;
  totalCostUsd: number;
  maxTotalCostUsd: number | null;
  maxWallTimeMinutes: number | null;
  crewId: string | null;
  goalId: string | null;
  createdAt: Date;
  startedAt: Date | null;
}

/**
 * Block a RUNNING plan when it exceeds its cost or wall-time budget, and
 * open a ReviewGate prompting the operator to approve continuation or
 * abandon. Returns true when it blocked. Shared by the recordUsage path
 * and any future periodic watchdog.
 */
export async function checkAndBlockBudget(
  tx: Tx,
  params: { workspaceId: string; plan: PlanBudgetRow },
): Promise<boolean> {
  const { plan } = params;
  if (plan.status !== ExecutionPlanStatus.RUNNING) return false;
  const overCost = plan.maxTotalCostUsd != null && plan.totalCostUsd > plan.maxTotalCostUsd;
  const wallClockStart = plan.startedAt ?? plan.createdAt;
  const overTime =
    plan.maxWallTimeMinutes != null &&
    Date.now() - wallClockStart.getTime() > plan.maxWallTimeMinutes * 60_000;
  if (!overCost && !overTime) return false;

  await tx.executionPlan.update({
    where: { id: plan.id },
    data: { status: ExecutionPlanStatus.BLOCKED },
  });
  const reasonBits: string[] = [];
  if (overCost) {
    reasonBits.push(
      `cost $${plan.totalCostUsd.toFixed(4)} > cap $${plan.maxTotalCostUsd!.toFixed(4)}`,
    );
  }
  if (overTime) {
    reasonBits.push(`wall-time exceeded ${plan.maxWallTimeMinutes!}m`);
  }
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: null,
    entity: "execution-plan",
    entityId: plan.id,
    action: "budget-exceeded",
    after: { totalCostUsd: plan.totalCostUsd, status: ExecutionPlanStatus.BLOCKED },
    eventKind: EventKind.PLAN_BUDGET_EXCEEDED,
    subjectType: "execution-plan",
    subjectId: plan.id,
    payload: {
      totalCostUsd: plan.totalCostUsd,
      maxTotalCostUsd: plan.maxTotalCostUsd,
      maxWallTimeMinutes: plan.maxWallTimeMinutes,
      reason: reasonBits.join("; "),
    } as Prisma.InputJsonValue,
  });
  await openReviewGateTx(tx, {
    workspaceId: params.workspaceId,
    actorId: null,
    actorAgentId: null,
    targetType: "execution-plan",
    targetId: plan.id,
    prompt: `Budget exceeded (${reasonBits.join("; ")}) — approve continuation or abandon.`,
    requiredRole: null,
    crewId: plan.crewId,
  });
  return true;
}

/**
 * Periodic budget/liveness watchdog and state reconciler for RUNNING plans.
 *
 * `checkAndBlockBudget` was previously only ever called from the cost-record
 * path (applyRunCostToPlan), so a plan whose agents never report cost had its
 * WALL-TIME cap silently un-enforced, and a wedged plan sat RUNNING forever
 * with no signal. This sweep re-runs the same guard on every RUNNING plan with
 * a wall-time cap (enforcing time independent of cost events), and logs plans
 * It also repairs the safe, deterministic drift case where a step-bound run
 * completed but its step never reached REVIEW, then emits a durable
 * PLAN_STALLED signal for states that still need an operator.
 */
export async function sweepOrchestrationBudget(params?: { workspaceId?: string }): Promise<{
  blocked: number;
  reconciled: number;
  stalled: number;
}> {
  const plans = await db.executionPlan.findMany({
    where: {
      status: ExecutionPlanStatus.RUNNING,
      archivedAt: null,
      ...(params?.workspaceId ? { workspaceId: params.workspaceId } : {}),
    },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      totalCostUsd: true,
      maxTotalCostUsd: true,
      maxWallTimeMinutes: true,
      crewId: true,
      goalId: true,
      createdAt: true,
      startedAt: true,
      updatedAt: true,
      workspace: { select: { reviewStartTimeoutMinutes: true } },
    },
    take: 200,
  });
  let blocked = 0;
  let reconciled = 0;
  let stalled = 0;
  for (const plan of plans) {
    try {
      const didBlock = await db.$transaction((tx) =>
        checkAndBlockBudget(tx, { workspaceId: plan.workspaceId, plan }),
      );
      if (didBlock) {
        blocked++;
        continue;
      }
      const steps = await db.executionStep.findMany({
        where: { planId: plan.id },
        select: {
          id: true,
          title: true,
          status: true,
          runs: {
            // PostgreSQL sorts NULL first for DESC. Ordering by completedAt
            // would therefore prefer an older STALLED attempt (null) over a
            // newer clean completion. lastEventAt is populated for every run
            // state and reflects the actual latest attempt.
            orderBy: { lastEventAt: "desc" },
            take: 1,
            select: { id: true, status: true },
          },
        },
      });

      for (const step of steps) {
        const latestRun = step.runs[0];
        if (
          latestRun?.status === AgentRunStatus.COMPLETED &&
          (step.status === ExecutionStepStatus.READY || step.status === ExecutionStepStatus.RUNNING)
        ) {
          const result = await db.$transaction((tx) =>
            handoffCompletedRunToStep(tx, {
              workspaceId: plan.workspaceId,
              actorId: null,
              runId: latestRun.id,
              stepId: step.id,
            }),
          );
          if (result.transitioned) reconciled++;
          await maybeAutoJudge(db, {
            workspaceId: plan.workspaceId,
            actorId: null,
            stepId: step.id,
          });
        }
      }

      const current = await db.executionStep.findMany({
        where: { planId: plan.id },
        select: {
          id: true,
          title: true,
          status: true,
          runs: {
            where: { status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] } },
            take: 1,
            select: { id: true },
          },
        },
      });
      const reviewStep = current.find((step) => step.status === ExecutionStepStatus.REVIEW);
      const hasLiveRun = current.some((step) => step.runs.length > 0);
      const progressStatuses = new Set<ExecutionStepStatus>([
        ExecutionStepStatus.READY,
        ExecutionStepStatus.RUNNING,
        ExecutionStepStatus.REVIEW,
      ]);
      const remainingStatuses = new Set<ExecutionStepStatus>([
        ExecutionStepStatus.TODO,
        ExecutionStepStatus.BLOCKED,
      ]);
      const hasProgressState = current.some((step) => progressStatuses.has(step.status));
      const remaining = current.filter((step) => remainingStatuses.has(step.status)).length;

      let reasonCode:
        | "review_without_reviewer"
        | "review_reviewer_noack"
        | "no_progress_path"
        | null = null;
      let reason: string | null = null;
      if (reviewStep) {
        const reviewer = plan.crewId ? await pickCrewMember(db, plan.crewId, "REVIEWER") : null;
        if (!reviewer) {
          await maybeAutoJudge(db, {
            workspaceId: plan.workspaceId,
            actorId: null,
            stepId: reviewStep.id,
          });
          reasonCode = "review_without_reviewer";
          reason = `“${reviewStep.title}” completed, but this plan has no REVIEWER. A human decision is required.`;
        } else {
          const reviewRun = await db.agentRun.findFirst({
            where: {
              workspaceId: plan.workspaceId,
              executionStepId: reviewStep.id,
              engagementMode: EngagementMode.REVIEW,
            },
            orderBy: { startedAt: "desc" },
            select: {
              id: true,
              issueId: true,
              agentId: true,
              status: true,
              startedAt: true,
              lastWakeAt: true,
              acknowledgedAt: true,
            },
          });
          if (!reviewRun) {
            await maybeAutoJudge(db, {
              workspaceId: plan.workspaceId,
              actorId: null,
              stepId: reviewStep.id,
            });
          } else if (
            reviewRun.status === AgentRunStatus.ACTIVE &&
            !reviewRun.acknowledgedAt &&
            plan.workspace.reviewStartTimeoutMinutes > 0 &&
            (reviewRun.lastWakeAt ?? reviewRun.startedAt).getTime() <=
              Date.now() - plan.workspace.reviewStartTimeoutMinutes * 60_000
          ) {
            await db.$transaction(async (tx) => {
              await finishRun(tx, {
                runId: reviewRun.id,
                workspaceId: plan.workspaceId,
                issueId: reviewRun.issueId,
                agentId: reviewRun.agentId,
                status: "STALLED",
                summary: `Reviewer did not acknowledge within ${plan.workspace.reviewStartTimeoutMinutes} minute${plan.workspace.reviewStartTimeoutMinutes === 1 ? "" : "s"}.`,
              });
              await ensureHumanReviewGate(tx, {
                workspaceId: plan.workspaceId,
                actorId: null,
                stepId: reviewStep.id,
                crewId: plan.crewId,
                reason:
                  `Agent review did not start within ${plan.workspace.reviewStartTimeoutMinutes} minute${plan.workspace.reviewStartTimeoutMinutes === 1 ? "" : "s"}. ` +
                  "Retry the agent reviewer or record a human PASS/FAIL verdict to continue.",
              });
            });
            reasonCode = "review_reviewer_noack";
            reason = `“${reviewStep.title}” is waiting because its reviewer did not start.`;
          }
        }
      } else if (!hasLiveRun && !hasProgressState && remaining > 0) {
        reasonCode = "no_progress_path";
        reason = `This running plan has ${remaining} unfinished step${remaining === 1 ? "" : "s"} and no live or ready work.`;
      }

      if (reasonCode && reason) {
        const currentPlan = await db.executionPlan.findUniqueOrThrow({
          where: { id: plan.id },
          select: { updatedAt: true },
        });
        const recentSignal = await db.activityEvent.findFirst({
          where: {
            workspaceId: plan.workspaceId,
            kind: EventKind.PLAN_STALLED,
            subjectType: "execution-plan",
            subjectId: plan.id,
            // One durable signal per unchanged plan state. Any meaningful
            // repair/status edit bumps updatedAt and permits a fresh signal
            // if the plan becomes stalled again later.
            createdAt: { gte: currentPlan.updatedAt },
          },
          select: { id: true },
        });
        if (!recentSignal) {
          await db.$transaction((tx) =>
            recordChange(tx, {
              workspaceId: plan.workspaceId,
              actorId: null,
              entity: "execution-plan",
              entityId: plan.id,
              action: "stalled",
              after: { status: ExecutionPlanStatus.RUNNING, reasonCode },
              eventKind: EventKind.PLAN_STALLED,
              subjectType: "execution-plan",
              subjectId: plan.id,
              payload: { reasonCode, reason } as Prisma.InputJsonValue,
            }),
          );
          stalled++;
        }
        logger.warn(
          { planId: plan.id, workspaceId: plan.workspaceId, reasonCode },
          "orchestration-watchdog: plan needs operator attention",
        );
      }
    } catch (err) {
      logger.warn({ err, planId: plan.id }, "orchestration-watchdog: plan check failed");
    }
  }
  return { blocked, reconciled, stalled };
}
