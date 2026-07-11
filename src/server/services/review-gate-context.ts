import "server-only";
import type { PrismaClient, ReviewGateStatus } from "@prisma/client";

/** Hydrate generic ReviewGate targets into operator-facing decision context. */
export async function listReviewGatesWithContext(
  db: PrismaClient,
  params: {
    workspaceId: string;
    status?: ReviewGateStatus;
    targetType?: string;
    limit: number;
  },
) {
  const rows = await db.reviewGate.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: params.status,
      targetType: params.targetType,
    },
    orderBy: { createdAt: "desc" },
    take: params.limit,
    include: {
      requestedBy: { select: { id: true, name: true, image: true } },
      requestedByAgent: {
        select: { id: true, name: true, profileKey: true, avatar: true },
      },
      crew: { select: { id: true, name: true } },
    },
  });

  const ids = (type: string) =>
    rows.filter((row) => row.targetType === type).map((row) => row.targetId);
  const [issues, plans, goals, steps] = await Promise.all([
    ids("issue").length
      ? db.issue.findMany({
          where: { id: { in: ids("issue") }, workspaceId: params.workspaceId },
          select: {
            id: true,
            number: true,
            title: true,
            status: { select: { name: true, category: true } },
          },
        })
      : Promise.resolve([]),
    ids("execution-plan").length
      ? db.executionPlan.findMany({
          where: { id: { in: ids("execution-plan") }, workspaceId: params.workspaceId },
          select: {
            id: true,
            title: true,
            status: true,
            goal: { select: { id: true, title: true } },
          },
        })
      : Promise.resolve([]),
    ids("goal").length
      ? db.goal.findMany({
          where: { id: { in: ids("goal") }, workspaceId: params.workspaceId },
          select: { id: true, title: true, status: true },
        })
      : Promise.resolve([]),
    ids("execution-step").length
      ? db.executionStep.findMany({
          where: { id: { in: ids("execution-step") }, workspaceId: params.workspaceId },
          select: {
            id: true,
            title: true,
            position: true,
            status: true,
            expectedOutput: true,
            verification: true,
            updatedAt: true,
            plan: {
              select: {
                id: true,
                title: true,
                status: true,
                goal: { select: { id: true, title: true, status: true } },
                _count: { select: { steps: true } },
              },
            },
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                status: { select: { name: true, category: true } },
              },
            },
            assignedAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
            runs: {
              where: { status: "COMPLETED" },
              orderBy: { lastEventAt: "desc" },
              take: 1,
              select: {
                id: true,
                status: true,
                summary: true,
                verificationResult: true,
                producedArtifactIds: true,
                followUps: true,
                completedAt: true,
                agent: {
                  select: { id: true, name: true, profileKey: true, avatar: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const issueMap = new Map(issues.map((row) => [row.id, row]));
  const planMap = new Map(plans.map((row) => [row.id, row]));
  const goalMap = new Map(goals.map((row) => [row.id, row]));
  const stepMap = new Map(steps.map((row) => [row.id, row]));

  return rows.map((row) => {
    const issue = issueMap.get(row.targetId);
    const plan = planMap.get(row.targetId);
    const goal = goalMap.get(row.targetId);
    const step = stepMap.get(row.targetId);
    return {
      ...row,
      targetLabel: step?.title ?? issue?.title ?? plan?.title ?? goal?.title ?? null,
      targetNumber: issue?.number ?? step?.issue?.number ?? null,
      targetContext: step
        ? { kind: "execution-step" as const, step }
        : plan
          ? { kind: "execution-plan" as const, plan }
          : goal
            ? { kind: "goal" as const, goal }
            : issue
              ? { kind: "issue" as const, issue }
              : null,
    };
  });
}
