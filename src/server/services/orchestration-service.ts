import "server-only";
import type { PrismaClient } from "@prisma/client";
import {
  ActionRequestKind,
  type AgentStatus,
  EventKind,
  ExecutionPlanStatus,
  ExecutionStepStatus,
  GoalStatus,
  Prisma,
  RunEngine,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { recordChange, agentDispatchUrlFor } from "@/server/audit";
import { openReviewGateTx } from "@/server/services/agent-crew-service";
import { createActionRequest } from "@/server/services/action-request-service";
import { openOrTouchRun } from "@/server/services/agent-run";
import { runPlanGeneration } from "@/server/services/ai";
import { resolveWorkspaceProviderClient } from "@/server/services/ai-providers";
import { materializeStepAsIssueTx } from "@/server/services/execution-step-issue-service";

type Tx = PrismaClient | Prisma.TransactionClient;

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
      throw new TRPCError({ code: "NOT_FOUND", message: "Agent crew not found in this workspace." });
    }
  }
  if (input.initiativeId) {
    const found = await db.initiative.findFirst({
      where: { id: input.initiativeId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Initiative not found in this workspace." });
    }
  }
  const { id } = await db.$transaction(async (tx) => {
    const goal = await tx.goal.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title.trim(),
        description: input.description ?? null,
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
      after: { title: goal.title, status: goal.status },
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
      throw new TRPCError({ code: "NOT_FOUND", message: "Agent crew not found in this workspace." });
    }
  }
  if (input.initiativeId) {
    const found = await db.initiative.findFirst({
      where: { id: input.initiativeId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Initiative not found in this workspace." });
    }
  }

  const goalData: Prisma.GoalUpdateInput = {
    title: input.title?.trim() ?? undefined,
    description: input.description === undefined ? undefined : input.description,
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
    maxTotalCostUsd:
      input.maxTotalCostUsd === undefined ? undefined : input.maxTotalCostUsd,
    maxWallTimeMinutes:
      input.maxWallTimeMinutes === undefined ? undefined : input.maxWallTimeMinutes,
  };
  const planBudgetData: Prisma.ExecutionPlanUpdateManyMutationInput = {
    ...(input.maxTotalCostUsd === undefined
      ? {}
      : { maxTotalCostUsd: input.maxTotalCostUsd }),
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
        initiativeId: goal.initiativeId,
        crewId: goal.crewId,
        maxTotalCostUsd: goal.maxTotalCostUsd,
        maxWallTimeMinutes: goal.maxWallTimeMinutes,
      },
      after: {
        title: input.title?.trim() ?? goal.title,
        description:
          input.description === undefined ? goal.description : input.description,
        initiativeId:
          input.initiativeId === undefined ? goal.initiativeId : input.initiativeId,
        crewId: input.crewId === undefined ? goal.crewId : input.crewId,
        maxTotalCostUsd:
          input.maxTotalCostUsd === undefined
            ? goal.maxTotalCostUsd
            : input.maxTotalCostUsd,
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

export async function getGoal(
  db: PrismaClient,
  params: { workspaceId: string; id: string },
) {
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
  return { ...goal, aggregate };
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
  return db.goal.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: params.status,
      issueId: params.issueId,
      archivedAt: params.includeArchived ? undefined : null,
    },
    orderBy: { updatedAt: "desc" },
    take: params.limit ?? 50,
    include: { _count: { select: { plans: true } } },
  });
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
  await db.$transaction(async (tx) => {
    await tx.goal.update({
      where: { id: goal.id },
      data: { status: GoalStatus.ABANDONED },
    });
    // Cancel any active plan attempt so dispatch stops.
    await tx.executionPlan.updateMany({
      where: { goalId: goal.id, status: { in: [ExecutionPlanStatus.DRAFT, ExecutionPlanStatus.APPROVED, ExecutionPlanStatus.RUNNING] } },
      data: { status: ExecutionPlanStatus.CANCELED },
    });
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
  });
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
      throw new TRPCError({ code: "NOT_FOUND", message: "Context set not found in this workspace." });
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
      throw new TRPCError({ code: "BAD_REQUEST", message: "plannerAgentId not in this workspace." });
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
      dispatchable =
        agent.runEngine === RunEngine.RUNS ? !!agent.runtimeId : hasWebhook;
    }
  }

  const result = await db.$transaction(async (tx) => {
    // Mark prior attempts inactive.
    await tx.executionPlan.updateMany({
      where: { goalId: goal.id, isActiveAttempt: true },
      data: { isActiveAttempt: false },
    });
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
      throw new TRPCError({ code: "NOT_FOUND", message: "Context set not found in this workspace." });
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
      message:
        "The model did not return any plan steps. Try again, or dispatch to a crew planner.",
    });
  }

  const result = await db.$transaction(async (tx) => {
    // Mark prior attempts inactive.
    await tx.executionPlan.updateMany({
      where: { goalId: goal.id, isActiveAttempt: true },
      data: { isActiveAttempt: false },
    });
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
        verification: s.verification.length
          ? (s.verification as Prisma.InputJsonValue)
          : null,
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
async function insertStepsTx(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    planId: string;
    steps: AddStepInput[];
  },
): Promise<string[]> {
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
        select: { id: true, crewId: true, contextSetId: true, issueId: true },
      },
    },
  });
  if (!step) return;

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
      select: { webhookUrl: true, runtimeId: true },
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
    if (runIssueId) {
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
): Promise<{ judgeAgentId: string | null }> {
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
      plan: { select: { id: true, crewId: true } },
    },
  });
  if (!step) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
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

  await db.$transaction(async (tx) => {
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
          judgeAgentId,
          prompt:
            `You are the JUDGE for step "${step.title}". Evaluate the worker's ` +
            `output against expectedOutput + verification, then call ` +
            `plans.recordVerdict({ stepId: "${step.id}", verdict: "PASS"|"FAIL", feedback, score? }).`,
        } as Prisma.InputJsonValue,
      },
    });
    if (judgeAgentId) {
      await queueAgentDispatch(tx, {
        workspaceId: params.workspaceId,
        agentId: judgeAgentId,
        eventId: event.id,
      });
    }
  });
  return { judgeAgentId };
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
  const step = await db.executionStep.findFirst({
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

  const verdictJson: JudgeVerdictJson = {
    verdict: params.verdict,
    feedback: params.feedback,
    ...(params.score != null ? { score: params.score } : {}),
    ...(params.actorAgentId ? { judgedByAgentId: params.actorAgentId } : {}),
    judgedAt: new Date().toISOString(),
  };

  let outcome: "DONE" | "RETRY" | "BLOCKED";
  let nextRetryCount = step.retryCount;

  await db.$transaction(async (tx) => {
    if (params.verdict === "PASS") {
      outcome = "DONE";
      await tx.executionStep.update({
        where: { id: step.id },
        data: {
          status: ExecutionStepStatus.DONE,
          judgeVerdict: verdictJson as unknown as Prisma.InputJsonValue,
          lastFeedback: null,
        },
      });
      await recordStepJudged(tx, params, step, verdictJson, "DONE");
      // Cascade: dependents may now be READY.
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
      return;
    }

    // FAIL.
    if (step.retryCount < step.plan.maxStepRetries) {
      outcome = "RETRY";
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
      // Re-dispatch by re-readying (deps already satisfied since it ran).
      await transitionStepToReady(tx, {
        workspaceId: params.workspaceId,
        stepId: step.id,
        actorId: params.actorId,
      });
      return;
    }

    // Retries exhausted → BLOCKED + ReviewGate.
    outcome = "BLOCKED";
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
  });

  return { outcome: outcome!, retryCount: nextRetryCount };
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
): Promise<{ dispatched: boolean }> {
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
  if (!step.plan.autoJudge) return { dispatched: false };
  if (!step.plan.crewId) return { dispatched: false };
  const reviewer = await pickCrewMember(db, step.plan.crewId, "REVIEWER");
  if (!reviewer) return { dispatched: false };
  await dispatchJudge(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    stepId: params.stepId,
    judgeAgentId: reviewer,
  });
  return { dispatched: true };
}

/**
 * When every step in the active plan is DONE, flip the goal → ACHIEVED and
 * the plan → COMPLETED. No-op if any step is non-DONE.
 */
async function maybeCompleteGoal(
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
  if (
    plan.status !== ExecutionPlanStatus.DRAFT &&
    plan.status !== ExecutionPlanStatus.APPROVED
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Plan must be DRAFT or APPROVED to activate (is ${plan.status}).`,
    });
  }
  await tx.executionPlan.update({
    where: { id: plan.id },
    data: { status: ExecutionPlanStatus.RUNNING },
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
  const overCost =
    plan.maxTotalCostUsd != null && plan.totalCostUsd > plan.maxTotalCostUsd;
  const overTime =
    plan.maxWallTimeMinutes != null &&
    Date.now() - plan.createdAt.getTime() > plan.maxWallTimeMinutes * 60_000;
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
