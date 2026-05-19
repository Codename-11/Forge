import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind, ReviewGateStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";

export const AGENT_CREW_ROLES = [
  "PLANNER",
  "WORKER",
  "REVIEWER",
  "OBSERVER",
  "OPERATOR_PROXY",
] as const;
export type AgentCrewRole = (typeof AGENT_CREW_ROLES)[number];

/**
 * Create an AgentCrew with optional members. Each member row binds an
 * agent to the crew with a role string.
 */
export async function createAgentCrew(
  db: PrismaClient,
  input: {
    workspaceId: string;
    actorId: string | null;
    name: string;
    description?: string | null;
    maxParallel?: number;
    policy?: Prisma.InputJsonValue | null;
    members?: Array<{ agentId: string; role: AgentCrewRole; position?: number }>;
  },
): Promise<{ id: string }> {
  // Validate every supplied agent belongs to this workspace.
  if (input.members && input.members.length) {
    const ids = input.members.map((m) => m.agentId);
    const found = await db.agent.findMany({
      where: { id: { in: ids }, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "One or more crew members are not agents in this workspace.",
      });
    }
  }
  const { id } = await db.$transaction(async (tx) => {
    const crew = await tx.agentCrew.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        description: input.description ?? null,
        maxParallel: input.maxParallel ?? 1,
        policy: input.policy === undefined || input.policy === null ? undefined : input.policy,
      },
    });
    if (input.members && input.members.length) {
      await tx.agentCrewMember.createMany({
        data: input.members.map((m, idx) => ({
          workspaceId: input.workspaceId,
          crewId: crew.id,
          agentId: m.agentId,
          role: m.role,
          position: m.position ?? idx,
        })),
        skipDuplicates: true,
      });
    }
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entity: "agent-crew",
      entityId: crew.id,
      action: "created",
      after: { name: crew.name, memberCount: input.members?.length ?? 0 },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "agent-crew",
      subjectId: crew.id,
    });
    return { id: crew.id };
  });
  return { id };
}

/** Add a single member to a crew. */
export async function addCrewMember(
  db: PrismaClient,
  params: {
    workspaceId: string;
    crewId: string;
    agentId: string;
    role: AgentCrewRole;
  },
): Promise<{ id: string }> {
  const [crew, agent] = await Promise.all([
    db.agentCrew.findFirst({
      where: { id: params.crewId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    }),
    db.agent.findFirst({
      where: { id: params.agentId, workspaceId: params.workspaceId },
      select: { id: true },
    }),
  ]);
  if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Agent crew not found." });
  if (!agent) throw new TRPCError({ code: "BAD_REQUEST", message: "Agent not in workspace." });

  const last = await db.agentCrewMember.findFirst({
    where: { crewId: params.crewId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const row = await db.agentCrewMember.upsert({
    where: {
      crewId_agentId_role: {
        crewId: params.crewId,
        agentId: params.agentId,
        role: params.role,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      crewId: params.crewId,
      agentId: params.agentId,
      role: params.role,
      position: (last?.position ?? -1) + 1,
    },
    update: {},
    select: { id: true },
  });
  return { id: row.id };
}

/** Open a ReviewGate against any reviewable target. */
export async function openReviewGate(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    targetType: string;
    targetId: string;
    prompt: string;
    requiredRole?: string | null;
    crewId?: string | null;
  },
): Promise<{ id: string }> {
  if (params.crewId) {
    const crew = await db.agentCrew.findFirst({
      where: { id: params.crewId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!crew) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Agent crew not found." });
    }
  }
  const { id } = await db.$transaction(async (tx) => {
    const gate = await tx.reviewGate.create({
      data: {
        workspaceId: params.workspaceId,
        targetType: params.targetType,
        targetId: params.targetId,
        prompt: params.prompt,
        requiredRole: params.requiredRole ?? null,
        requestedById: params.actorAgentId ? null : params.actorId,
        requestedByAgentId: params.actorAgentId ?? null,
        crewId: params.crewId ?? null,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "review-gate",
      entityId: gate.id,
      action: "opened",
      after: { targetType: gate.targetType, targetId: gate.targetId, prompt: gate.prompt },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "review-gate",
      subjectId: gate.id,
      payload: {
        gateTargetType: gate.targetType,
        gateTargetId: gate.targetId,
        action: "opened",
      } as Prisma.InputJsonValue,
    });
    return { id: gate.id };
  });
  return { id };
}

/** Resolve a ReviewGate (approve, reject, or cancel). */
export async function resolveReviewGate(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    gateId: string;
    decision: "APPROVED" | "REJECTED" | "CANCELED";
    resolution?: string | null;
  },
): Promise<void> {
  const gate = await db.reviewGate.findFirst({
    where: { id: params.gateId, workspaceId: params.workspaceId },
    select: { id: true, status: true, targetType: true, targetId: true },
  });
  if (!gate) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Review gate not found." });
  }
  if (gate.status !== ReviewGateStatus.PENDING) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Review gate already ${gate.status.toLowerCase()}.`,
    });
  }
  await db.$transaction(async (tx) => {
    await tx.reviewGate.update({
      where: { id: gate.id },
      data: {
        status: params.decision as ReviewGateStatus,
        resolvedById: params.actorAgentId ? null : params.actorId,
        resolvedByAgentId: params.actorAgentId ?? null,
        resolvedAt: new Date(),
        resolution: params.resolution ?? null,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "review-gate",
      entityId: gate.id,
      action: "resolved",
      before: { status: gate.status },
      after: { status: params.decision },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "review-gate",
      subjectId: gate.id,
      payload: {
        gateTargetType: gate.targetType,
        gateTargetId: gate.targetId,
        decision: params.decision,
      } as Prisma.InputJsonValue,
    });
  });
}
