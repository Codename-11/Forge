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
    actorId?: string | null;
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
  const row = await db.$transaction(async (tx) => {
    const member = await tx.agentCrewMember.upsert({
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
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId ?? null,
      entity: "agent-crew",
      entityId: params.crewId,
      action: "member_added",
      after: { agentId: params.agentId, role: params.role },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "agent-crew",
      subjectId: params.crewId,
    });
    return member;
  });
  return { id: row.id };
}

/** Update crew head metadata. */
export async function updateAgentCrew(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    crewId: string;
    name?: string;
    description?: string | null;
    maxParallel?: number;
  },
): Promise<void> {
  const crew = await db.agentCrew.findFirst({
    where: { id: params.crewId, workspaceId: params.workspaceId },
    select: { id: true, name: true },
  });
  if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Agent crew not found." });
  await db.$transaction(async (tx) => {
    await tx.agentCrew.update({
      where: { id: params.crewId },
      data: {
        name: params.name?.trim() ?? undefined,
        description: params.description === undefined ? undefined : params.description,
        maxParallel: params.maxParallel ?? undefined,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "agent-crew",
      entityId: params.crewId,
      action: "updated",
      before: { name: crew.name },
      after: { name: params.name ?? crew.name },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "agent-crew",
      subjectId: params.crewId,
    });
  });
}

/** Remove a member from a crew by member-row id. */
export async function removeCrewMember(
  db: PrismaClient,
  params: { workspaceId: string; actorId: string | null; memberId: string },
): Promise<void> {
  const member = await db.agentCrewMember.findFirst({
    where: { id: params.memberId, workspaceId: params.workspaceId },
    select: { id: true, crewId: true, agentId: true, role: true },
  });
  if (!member) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Crew member not found." });
  }
  await db.$transaction(async (tx) => {
    await tx.agentCrewMember.delete({ where: { id: params.memberId } });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "agent-crew",
      entityId: member.crewId,
      action: "member_removed",
      before: { agentId: member.agentId, role: member.role },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "agent-crew",
      subjectId: member.crewId,
    });
  });
}

/**
 * Change a member's role. Implemented as delete-old + upsert-new because
 * the unique key includes the role (an agent can hold multiple roles); a
 * plain update on `role` could collide with an existing (crew, agent,
 * newRole) row. Returns the resulting member id.
 */
export async function setCrewMemberRole(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    memberId: string;
    role: AgentCrewRole;
  },
): Promise<{ id: string }> {
  const member = await db.agentCrewMember.findFirst({
    where: { id: params.memberId, workspaceId: params.workspaceId },
    select: { id: true, crewId: true, agentId: true, role: true, position: true },
  });
  if (!member) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Crew member not found." });
  }
  if (member.role === params.role) return { id: member.id };
  const row = await db.$transaction(async (tx) => {
    await tx.agentCrewMember.delete({ where: { id: member.id } });
    const created = await tx.agentCrewMember.upsert({
      where: {
        crewId_agentId_role: {
          crewId: member.crewId,
          agentId: member.agentId,
          role: params.role,
        },
      },
      create: {
        workspaceId: params.workspaceId,
        crewId: member.crewId,
        agentId: member.agentId,
        role: params.role,
        position: member.position,
      },
      update: {},
      select: { id: true },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "agent-crew",
      entityId: member.crewId,
      action: "member_role_changed",
      before: { agentId: member.agentId, role: member.role },
      after: { agentId: member.agentId, role: params.role },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "agent-crew",
      subjectId: member.crewId,
    });
    return created;
  });
  return { id: row.id };
}

/** Soft-archive a crew. */
export async function archiveAgentCrew(
  db: PrismaClient,
  params: { workspaceId: string; actorId: string | null; crewId: string },
): Promise<void> {
  const crew = await db.agentCrew.findFirst({
    where: { id: params.crewId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Agent crew not found." });
  await db.$transaction(async (tx) => {
    await tx.agentCrew.update({
      where: { id: params.crewId },
      data: { archivedAt: new Date() },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "agent-crew",
      entityId: params.crewId,
      action: "archived",
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "agent-crew",
      subjectId: params.crewId,
    });
  });
}

/**
 * Open a ReviewGate inside an existing transaction. Use this when the
 * gate must be atomic with surrounding writes (e.g. the orchestration
 * loop blocking a step + opening its gate in one transaction). Skips the
 * crew-scope pre-check's separate query — pass a validated crewId or null.
 */
export async function openReviewGateTx(
  tx: Prisma.TransactionClient | PrismaClient,
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
    actorAgentId: params.actorAgentId ?? null,
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
  const { id } = await db.$transaction((tx) => openReviewGateTx(tx, params));
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
      actorAgentId: params.actorAgentId ?? null,
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
