import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

type Tx = PrismaClient | Prisma.TransactionClient;

type StepAssigneeRefs = {
  assignedAgentId?: string | null;
  assignedUserId?: string | null;
};

function badReference(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Validate that every non-null step assignee belongs to this workspace. */
export async function validateStepAssignees(
  tx: Tx,
  params: { workspaceId: string; steps: StepAssigneeRefs[] },
): Promise<void> {
  const agentIds = Array.from(
    new Set(params.steps.flatMap((step) => (step.assignedAgentId ? [step.assignedAgentId] : []))),
  );
  if (agentIds.length) {
    const agents = await tx.agent.findMany({
      where: {
        id: { in: agentIds },
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (agents.length !== agentIds.length) {
      badReference("One or more assignedAgentId values are not active agents in this workspace.");
    }
  }

  const userIds = Array.from(
    new Set(params.steps.flatMap((step) => (step.assignedUserId ? [step.assignedUserId] : []))),
  );
  if (userIds.length) {
    const memberships = await tx.membership.findMany({
      where: { workspaceId: params.workspaceId, userId: { in: userIds } },
      select: { userId: true },
    });
    const memberIds = new Set(memberships.map((membership) => membership.userId));
    if (userIds.some((id) => !memberIds.has(id))) {
      badReference("One or more assignedUserId values are not members of this workspace.");
    }
  }
}

/**
 * Validate index dependencies before creating a batch. Invalid indexes and
 * self-dependencies are rejected instead of being silently discarded.
 */
export function assertValidStepIndexDependencies(
  steps: { dependsOnStepIndexes?: number[] }[],
): void {
  const count = steps.length;
  const indegree = new Array<number>(count).fill(0);
  const adjacency: number[][] = Array.from({ length: count }, () => []);

  for (let index = 0; index < count; index++) {
    const dependencies = steps[index].dependsOnStepIndexes ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      badReference(`Step ${index} contains duplicate dependency indexes.`);
    }
    for (const dependencyIndex of dependencies) {
      if (!Number.isInteger(dependencyIndex) || dependencyIndex < 0 || dependencyIndex >= count) {
        badReference(
          `Step ${index} references dependency index ${dependencyIndex}, which is out of range.`,
        );
      }
      if (dependencyIndex === index) {
        badReference(`Step ${index} cannot depend on itself.`);
      }
      adjacency[dependencyIndex].push(index);
      indegree[index]++;
    }
  }

  const queue: number[] = [];
  for (let index = 0; index < count; index++) {
    if (indegree[index] === 0) queue.push(index);
  }
  let visited = 0;
  while (queue.length) {
    const dependencyIndex = queue.shift()!;
    visited++;
    for (const dependentIndex of adjacency[dependencyIndex]) {
      indegree[dependentIndex]--;
      if (indegree[dependentIndex] === 0) queue.push(dependentIndex);
    }
  }
  if (visited !== count) {
    badReference(
      "Plan steps contain a dependency cycle — steps can't depend on each other in a loop.",
    );
  }
}

/** Validate direct dependency ids and reject a proposed graph cycle. */
export async function validateStepDependencies(
  tx: Tx,
  params: {
    workspaceId: string;
    planId: string;
    stepId?: string;
    dependsOnStepIds: string[];
  },
): Promise<void> {
  const dependencyIds = params.dependsOnStepIds;
  if (new Set(dependencyIds).size !== dependencyIds.length) {
    badReference("dependsOnStepIds cannot contain duplicate step ids.");
  }
  if (params.stepId && dependencyIds.includes(params.stepId)) {
    badReference("An execution step cannot depend on itself.");
  }

  if (dependencyIds.length) {
    const dependencies = await tx.executionStep.findMany({
      where: {
        id: { in: dependencyIds },
        workspaceId: params.workspaceId,
        planId: params.planId,
      },
      select: { id: true },
    });
    if (dependencies.length !== dependencyIds.length) {
      badReference("Every dependency must be a step in the same execution plan.");
    }
  }

  if (!params.stepId) return;
  const steps = await tx.executionStep.findMany({
    where: { workspaceId: params.workspaceId, planId: params.planId },
    select: { id: true, dependsOnStepIds: true },
  });
  const graph = new Map(
    steps.map((step) => [
      step.id,
      step.id === params.stepId ? dependencyIds : step.dependsOnStepIds,
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    for (const dependencyId of graph.get(stepId) ?? []) {
      if (graph.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  if (steps.some((step) => visit(step.id))) {
    badReference(
      "Plan steps contain a dependency cycle — steps can't depend on each other in a loop.",
    );
  }
}

/** Validate the optional run recorded as the source of a step's output. */
export async function validateStepSourceRun(
  tx: Tx,
  params: { workspaceId: string; sourceRunId?: string | null },
): Promise<void> {
  if (!params.sourceRunId) return;
  const run = await tx.agentRun.findFirst({
    where: { id: params.sourceRunId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  if (!run) badReference("sourceRunId must reference an agent run in this workspace.");
}

type RoleAssignableStep = StepAssigneeRefs & { assignedRole?: string | null };

/**
 * Resolve role hints to a unique member of the plan's crew. A role with zero
 * or multiple candidates is not guessed; callers get an actionable error.
 */
export async function resolveCrewRoleAssignees<T extends RoleAssignableStep>(
  tx: Tx,
  params: { workspaceId: string; crewId: string | null; steps: T[] },
): Promise<Array<T & { assignedAgentId?: string | null }>> {
  const normalizedRoles = params.steps.map(
    (step) => step.assignedRole?.trim().toUpperCase() || null,
  );
  const roles = Array.from(
    new Set(normalizedRoles.filter((role): role is string => Boolean(role))),
  );
  if (!roles.length) return params.steps;
  if (!params.crewId) {
    badReference("assignedRole requires the execution plan to have an agent crew.");
  }

  const members = await tx.agentCrewMember.findMany({
    where: {
      workspaceId: params.workspaceId,
      crewId: params.crewId,
      role: { in: roles },
      agent: { workspaceId: params.workspaceId, archivedAt: null },
    },
    orderBy: [{ role: "asc" }, { position: "asc" }, { agentId: "asc" }],
    select: { role: true, agentId: true },
  });
  const agentsByRole = new Map<string, Set<string>>();
  for (const member of members) {
    const ids = agentsByRole.get(member.role) ?? new Set<string>();
    ids.add(member.agentId);
    agentsByRole.set(member.role, ids);
  }

  return params.steps.map((step, index) => {
    const role = normalizedRoles[index];
    if (!role) return step;
    const candidates = Array.from(agentsByRole.get(role) ?? []);
    if (candidates.length === 0) {
      badReference(`No active member of this plan's crew has the ${role} role.`);
    }
    if (candidates.length > 1) {
      if (step.assignedAgentId) {
        if (!candidates.includes(step.assignedAgentId)) {
          badReference(`assignedAgentId is not a member of the plan crew with the ${role} role.`);
        }
        return step;
      }
      badReference(
        `The ${role} role is ambiguous for this plan crew (${candidates.length} agents); set assignedAgentId explicitly.`,
      );
    }
    const resolvedAgentId = candidates[0];
    if (step.assignedAgentId && step.assignedAgentId !== resolvedAgentId) {
      badReference(`assignedAgentId does not match the plan crew's unique ${role} member.`);
    }
    return { ...step, assignedAgentId: resolvedAgentId };
  });
}
