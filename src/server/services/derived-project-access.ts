import "server-only";

import type { Membership, Prisma, PrismaClient } from "@prisma/client";
import { issueWhereForViewer, projectWhereForViewer } from "@/server/services/project-access";

type DbClient = PrismaClient | Prisma.TransactionClient;
type Viewer = {
  workspaceId: string;
  membership: Pick<Membership, "id" | "role">;
};

export type ProjectDerivedRecord = {
  subjectType: string;
  subjectId: string;
  payload: unknown;
};

function payloadId(
  payload: unknown,
  key: "issueId" | "projectId" | "planId" | "goalId" | "stepId",
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Filter polymorphic, materialized rows by their issue/project ancestry.
 *
 * ActivityEvent intentionally has no foreign key because it also carries
 * workspace-wide subjects. For every known issue-bearing subject we resolve
 * ancestry in batches, then apply the same central project policy as canonical
 * issue reads. Unknown/workspace-wide subjects remain visible; known subjects
 * whose backing row was deleted remain visible for historical continuity.
 */
export async function filterProjectDerivedRecords<T extends ProjectDerivedRecord>(
  db: DbClient,
  viewer: Viewer,
  rows: readonly T[],
): Promise<T[]> {
  if (
    rows.length === 0 ||
    viewer.membership.role === "OWNER" ||
    viewer.membership.role === "ADMIN"
  ) {
    return [...rows];
  }

  const directIssueIds = new Set<string>();
  const directProjectIds = new Set<string>();
  const planIds = new Set<string>();
  const goalIds = new Set<string>();
  const stepIds = new Set<string>();
  const subjectIds = (type: string) =>
    rows.filter((row) => row.subjectType === type).map((row) => row.subjectId);
  for (const row of rows) {
    const issueId = payloadId(row.payload, "issueId");
    const projectId = payloadId(row.payload, "projectId");
    if (issueId) directIssueIds.add(issueId);
    if (projectId) directProjectIds.add(projectId);
    const planId = payloadId(row.payload, "planId");
    const goalId = payloadId(row.payload, "goalId");
    const stepId = payloadId(row.payload, "stepId");
    if (planId) planIds.add(planId);
    if (goalId) goalIds.add(goalId);
    if (stepId) stepIds.add(stepId);
    if (row.subjectType === "issue") directIssueIds.add(row.subjectId);
    if (row.subjectType === "project") directProjectIds.add(row.subjectId);
    if (row.subjectType === "execution-plan") planIds.add(row.subjectId);
    if (row.subjectType === "goal") goalIds.add(row.subjectId);
    if (row.subjectType === "execution-step") stepIds.add(row.subjectId);
  }

  const [comments, runs, requests, sessions, steps, gates] = await Promise.all([
    subjectIds("comment").length
      ? db.comment.findMany({
          where: { id: { in: subjectIds("comment") }, workspaceId: viewer.workspaceId },
          select: { id: true, issueId: true },
        })
      : [],
    subjectIds("agent-run").length
      ? db.agentRun.findMany({
          where: { id: { in: subjectIds("agent-run") }, workspaceId: viewer.workspaceId },
          select: { id: true, issueId: true },
        })
      : [],
    subjectIds("action-request").length
      ? db.actionRequest.findMany({
          where: { id: { in: subjectIds("action-request") }, workspaceId: viewer.workspaceId },
          select: { id: true, issueId: true, sourceType: true, sourceId: true },
        })
      : [],
    subjectIds("work-session").length
      ? db.workSession.findMany({
          where: { id: { in: subjectIds("work-session") }, workspaceId: viewer.workspaceId },
          select: { id: true, issueId: true },
        })
      : [],
    stepIds.size
      ? db.executionStep.findMany({
          where: { id: { in: [...stepIds] }, workspaceId: viewer.workspaceId },
          select: { id: true, issueId: true, planId: true },
        })
      : [],
    subjectIds("review-gate").length
      ? db.reviewGate.findMany({
          where: { id: { in: subjectIds("review-gate") }, workspaceId: viewer.workspaceId },
          select: { id: true, targetType: true, targetId: true },
        })
      : [],
  ]);

  const issueBySubject = new Map<string, string | null>();
  for (const row of comments) issueBySubject.set(`comment:${row.id}`, row.issueId);
  for (const row of runs) issueBySubject.set(`agent-run:${row.id}`, row.issueId);
  for (const row of requests) issueBySubject.set(`action-request:${row.id}`, row.issueId);
  for (const row of sessions) issueBySubject.set(`work-session:${row.id}`, row.issueId);
  for (const row of steps) {
    issueBySubject.set(`execution-step:${row.id}`, row.issueId);
    planIds.add(row.planId);
  }
  for (const request of requests) {
    if (request.sourceType === "execution-plan" && request.sourceId) planIds.add(request.sourceId);
    if (request.sourceType === "goal" && request.sourceId) goalIds.add(request.sourceId);
  }
  const gateStepIds = gates
    .filter((gate) => gate.targetType === "execution-step")
    .map((gate) => gate.targetId);
  const gateSteps = gateStepIds.length
    ? await db.executionStep.findMany({
        where: { id: { in: gateStepIds }, workspaceId: viewer.workspaceId },
        select: { id: true, issueId: true, planId: true },
      })
    : [];
  for (const step of gateSteps) planIds.add(step.planId);
  for (const gate of gates) {
    if (gate.targetType === "execution-plan") planIds.add(gate.targetId);
    if (gate.targetType === "goal") goalIds.add(gate.targetId);
  }
  const plans = planIds.size
    ? await db.executionPlan.findMany({
        where: { id: { in: [...planIds] }, workspaceId: viewer.workspaceId },
        select: { id: true, issueId: true, projectId: true, goalId: true },
      })
    : [];
  for (const plan of plans) if (plan.goalId) goalIds.add(plan.goalId);
  const goals = goalIds.size
    ? await db.goal.findMany({
        where: { id: { in: [...goalIds] }, workspaceId: viewer.workspaceId },
        select: { id: true, issueId: true },
      })
    : [];
  const goalIssueById = new Map(goals.map((goal) => [goal.id, goal.issueId]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const stepById = new Map([...steps, ...gateSteps].map((step) => [step.id, step]));
  const projectBySubject = new Map<string, string | null>();
  const setPlanAncestry = (subjectKey: string, planId: string) => {
    const plan = planById.get(planId);
    if (!plan) return;
    const issueId = plan.issueId ?? (plan.goalId ? goalIssueById.get(plan.goalId) : null);
    if (issueId) issueBySubject.set(subjectKey, issueId);
    else if (plan.projectId) projectBySubject.set(subjectKey, plan.projectId);
  };
  for (const plan of plans) setPlanAncestry(`execution-plan:${plan.id}`, plan.id);
  for (const goal of goals) issueBySubject.set(`goal:${goal.id}`, goal.issueId);
  for (const step of stepById.values()) {
    if (step.issueId) issueBySubject.set(`execution-step:${step.id}`, step.issueId);
    else setPlanAncestry(`execution-step:${step.id}`, step.planId);
  }
  for (const request of requests) {
    if (request.issueId) continue;
    if (request.sourceType === "execution-plan" && request.sourceId) {
      setPlanAncestry(`action-request:${request.id}`, request.sourceId);
    }
    if (request.sourceType === "goal" && request.sourceId) {
      issueBySubject.set(
        `action-request:${request.id}`,
        goalIssueById.get(request.sourceId) ?? null,
      );
    }
  }
  for (const gate of gates) {
    if (gate.targetType === "issue") issueBySubject.set(`review-gate:${gate.id}`, gate.targetId);
    if (gate.targetType === "execution-step") {
      const step = stepById.get(gate.targetId);
      if (step?.issueId) issueBySubject.set(`review-gate:${gate.id}`, step.issueId);
      else if (step) setPlanAncestry(`review-gate:${gate.id}`, step.planId);
    }
    if (gate.targetType === "execution-plan") {
      setPlanAncestry(`review-gate:${gate.id}`, gate.targetId);
    }
    if (gate.targetType === "goal") {
      issueBySubject.set(`review-gate:${gate.id}`, goalIssueById.get(gate.targetId) ?? null);
    }
  }
  for (const issueId of issueBySubject.values()) if (issueId) directIssueIds.add(issueId);
  for (const projectId of projectBySubject.values()) if (projectId) directProjectIds.add(projectId);

  const [visibleIssues, visibleProjects] = await Promise.all([
    directIssueIds.size
      ? db.issue.findMany({
          where: {
            id: { in: [...directIssueIds] },
            workspaceId: viewer.workspaceId,
            AND: [issueWhereForViewer(viewer)],
          },
          select: { id: true },
        })
      : [],
    directProjectIds.size
      ? db.project.findMany({
          where: {
            id: { in: [...directProjectIds] },
            AND: [projectWhereForViewer(viewer)],
          },
          select: { id: true },
        })
      : [],
  ]);
  const visibleIssueIds = new Set(visibleIssues.map((row) => row.id));
  const visibleProjectIds = new Set(visibleProjects.map((row) => row.id));

  return rows.filter((row) => {
    let issueId =
      payloadId(row.payload, "issueId") ??
      issueBySubject.get(`${row.subjectType}:${row.subjectId}`);
    let projectId =
      payloadId(row.payload, "projectId") ??
      projectBySubject.get(`${row.subjectType}:${row.subjectId}`) ??
      (row.subjectType === "project" ? row.subjectId : null);
    const referencedStep = payloadId(row.payload, "stepId");
    const referencedPlan = payloadId(row.payload, "planId");
    const referencedGoal = payloadId(row.payload, "goalId");
    if (!issueId && referencedStep) {
      const step = stepById.get(referencedStep);
      issueId =
        step?.issueId ?? (step ? issueBySubject.get(`execution-plan:${step.planId}`) : null);
      projectId ??= step ? (projectBySubject.get(`execution-plan:${step.planId}`) ?? null) : null;
    }
    if (!issueId && referencedPlan) {
      issueId = issueBySubject.get(`execution-plan:${referencedPlan}`) ?? null;
      projectId ??= projectBySubject.get(`execution-plan:${referencedPlan}`) ?? null;
    }
    if (!issueId && referencedGoal) issueId = goalIssueById.get(referencedGoal) ?? null;
    if (issueId) return visibleIssueIds.has(issueId);
    return !projectId || visibleProjectIds.has(projectId);
  });
}

export async function canReadProjectDerivedRecord(
  db: DbClient,
  viewer: Viewer,
  row: ProjectDerivedRecord,
): Promise<boolean> {
  return (await filterProjectDerivedRecords(db, viewer, [row])).length === 1;
}
