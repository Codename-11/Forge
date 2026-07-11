import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ExecutionPlanStatus,
  ExecutionStepStatus,
  GoalStatus,
  ReviewGateStatus,
} from "@prisma/client";
import { agentCrewRouter, reviewGateRouter } from "@/server/routers/agent-crew";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "CRW" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const ctx = await buildContext(fixture);
  return {
    fixture,
    prisma,
    ctx,
    crewCaller: agentCrewRouter.createCaller(ctx),
    gateCaller: reviewGateRouter.createCaller(ctx),
  };
}

describe("agentCrewRouter + reviewGateRouter", () => {
  it("creates an agent crew with seeded members", async () => {
    const { fixture, prisma, crewCaller } = await setup();
    const a = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `a-${Date.now()}`,
        name: "Planner",
      },
    });
    const b = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `b-${Date.now()}`,
        name: "Worker",
      },
    });
    const result = await crewCaller.create({
      name: "Migration crew",
      members: [
        { agentId: a.id, role: "PLANNER" },
        { agentId: b.id, role: "WORKER" },
      ],
    });
    const got = await crewCaller.get({ id: result.id });
    expect(got.members).toHaveLength(2);
    expect(got.members.map((m) => m.role).sort()).toEqual(["PLANNER", "WORKER"]);
  });

  it("rejects members from another workspace", async () => {
    const { prisma, crewCaller } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "OW" });
    fixtures.push(other);
    const stranger = await prisma.agent.create({
      data: {
        workspaceId: other.workspace.id,
        profileKey: `o-${Date.now()}`,
        name: "Stranger",
      },
    });
    await expect(
      crewCaller.create({
        name: "Mixed crew",
        members: [{ agentId: stranger.id, role: "WORKER" }],
      }),
    ).rejects.toThrow(/not agents in this workspace/);
  });

  it("rejects non-admin users from mutating crews and resolving gates", async () => {
    const { fixture, prisma, crewCaller, gateCaller } = await setup();
    const memberCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const memberCrewCaller = agentCrewRouter.createCaller(memberCtx);
    const memberGateCaller = reviewGateRouter.createCaller(memberCtx);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `member-${Date.now()}`,
        name: "Member Agent",
      },
    });
    const crew = await crewCaller.create({ name: "Admin owned" });
    const gate = await gateCaller.open({
      targetType: "execution-plan",
      targetId: "plan_fake_id_for_targeting_only",
      prompt: "Please review",
    });

    await expect(memberCrewCaller.create({ name: "Nope" })).rejects.toThrow(/Admin role/);
    await expect(
      memberCrewCaller.addMember({ crewId: crew.id, agentId: agent.id, role: "WORKER" }),
    ).rejects.toThrow(/Admin role/);
    await expect(memberGateCaller.resolve({ id: gate.id, decision: "APPROVED" })).rejects.toThrow(
      /Admin role/,
    );
  });

  it("opens, resolves, and rejects a review gate", async () => {
    const { gateCaller } = await setup();
    const open = await gateCaller.open({
      targetType: "execution-plan",
      targetId: "plan_fake_id_for_targeting_only",
      prompt: "Please review the rollout plan",
    });
    let row = await gateCaller.get({ id: open.id });
    expect(row.status).toBe(ReviewGateStatus.PENDING);
    await gateCaller.resolve({ id: open.id, decision: "APPROVED", resolution: "LGTM" });
    row = await gateCaller.get({ id: open.id });
    expect(row.status).toBe(ReviewGateStatus.APPROVED);
    expect(row.resolution).toBe("LGTM");

    // Re-resolving rejects.
    await expect(gateCaller.resolve({ id: open.id, decision: "APPROVED" })).rejects.toThrow(
      /already/,
    );
  });

  it("passes an execution-step gate through the verdict lifecycle", async () => {
    const { fixture, prisma, gateCaller } = await setup();
    const goal = await prisma.goal.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Ship reviewed work",
        status: GoalStatus.ACTIVE,
      },
    });
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        goalId: goal.id,
        title: "Reviewed plan",
        status: ExecutionPlanStatus.RUNNING,
        isActiveAttempt: true,
      },
    });
    const reviewStep = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Review me",
        position: 0,
        status: ExecutionStepStatus.REVIEW,
      },
    });
    const nextStep = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Continue after review",
        position: 1,
        status: ExecutionStepStatus.TODO,
        dependsOnStepIds: [reviewStep.id],
      },
    });
    const gate = await gateCaller.open({
      targetType: "execution-step",
      targetId: reviewStep.id,
      prompt: "Does the completed work satisfy the step?",
    });

    await gateCaller.resolve({
      id: gate.id,
      decision: "APPROVED",
      resolution: "Verification passed.",
    });

    const [reviewed, downstream] = await Promise.all([
      prisma.executionStep.findUniqueOrThrow({ where: { id: reviewStep.id } }),
      prisma.executionStep.findUniqueOrThrow({ where: { id: nextStep.id } }),
    ]);
    expect(reviewed.status).toBe(ExecutionStepStatus.DONE);
    expect(downstream.status).toBe(ExecutionStepStatus.READY);
  });

  it("resolves a human label + number for issue targets in list", async () => {
    const { fixture, gateCaller } = await setup();
    const issue = await createIssue(fixture, { title: "Wire up billing" });
    await gateCaller.open({
      targetType: "issue",
      targetId: issue.id,
      prompt: "Approve the billing change",
    });
    // An unresolvable target (deleted/foreign) falls back to null label,
    // not a throw.
    await gateCaller.open({
      targetType: "execution-plan",
      targetId: "plan_does_not_exist",
      prompt: "Review missing plan",
    });

    const { items } = await gateCaller.list({});
    const issueGate = items.find((g) => g.targetId === issue.id);
    expect(issueGate?.targetLabel).toBe("Wire up billing");
    expect(issueGate?.targetNumber).toBe(issue.number);

    const orphanGate = items.find((g) => g.targetId === "plan_does_not_exist");
    expect(orphanGate?.targetLabel).toBeNull();
    expect(orphanGate?.targetNumber).toBeNull();
  });
});
