import { afterAll, afterEach, describe, expect, it } from "vitest";
import { canvasRouter } from "@/server/routers/canvas";
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "CNV" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const ctx = await buildContext(fixture);
  const caller = canvasRouter.createCaller(ctx);
  return { fixture, prisma, caller };
}

describe("canvasRouter", () => {
  it("creates a canvas, adds nodes pointing at issue/artifact, and hydrates them", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const artifact = await prisma.artifact.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Decision",
        slug: `dec-${Date.now()}`,
        body: "decided",
      },
    });
    const canvas = await caller.create({ name: "Synthesis board" });
    const a = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issue.id,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
    });
    const b = await caller.addNode({
      canvasId: canvas.id,
      targetType: "artifact",
      targetId: artifact.id,
      x: 280,
      y: 0,
      width: 240,
      height: 160,
    });
    const hydrated = await caller.hydrate({ id: canvas.id });
    expect(hydrated.nodes).toHaveLength(2);
    const issueNode = hydrated.nodes.find((n) => n.id === a.id);
    const artifactNode = hydrated.nodes.find((n) => n.id === b.id);
    expect(issueNode?.ref?.type).toBe("issue");
    expect(issueNode?.ref?.missing).toBe(false);
    expect(artifactNode?.ref?.type).toBe("artifact");
    expect(artifactNode?.ref?.label).toBe("Decision");
  });

  it("dead-ref placeholder when the source entity goes away", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    const canvas = await caller.create({ name: "Board" });
    await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issue.id,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
    });
    await getPrisma().issue.delete({ where: { id: issue.id } });
    const hydrated = await caller.hydrate({ id: canvas.id });
    expect(hydrated.nodes[0].ref?.missing).toBe(true);
  });

  it("rejects nodes and scopes that point outside the workspace", async () => {
    const { caller } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "OC" });
    fixtures.push(other);
    const otherIssue = await createIssue(other);

    await expect(
      caller.create({ name: "Foreign scope", scopeType: "issue", scopeId: otherIssue.id }),
    ).rejects.toThrow(/target not found/);

    await expect(caller.create({ name: "Half scope", scopeType: "issue" })).rejects.toThrow(
      /provided together/,
    );

    const canvas = await caller.create({ name: "Board" });
    await expect(
      caller.addNode({
        canvasId: canvas.id,
        targetType: "issue",
        targetId: otherIssue.id,
        x: 0,
        y: 0,
        width: 240,
        height: 160,
      }),
    ).rejects.toThrow(/target not found/);
  });

  it("createFromPlan lays out plan + steps with contains + depends_on edges", async () => {
    const { fixture, prisma, caller } = await setup();
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Ship the thing",
        description: "End-to-end rollout",
        status: "DRAFT",
      },
    });
    const s1 = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Design",
        position: 0,
      },
    });
    const s2 = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Implement",
        position: 1,
        dependsOnStepIds: [s1.id],
      },
    });
    const s3 = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Test",
        position: 2,
        dependsOnStepIds: [s2.id],
      },
    });
    const s4 = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Document",
        position: 3,
      },
    });

    const result = await caller.createFromPlan({ planId: plan.id });
    expect(result.canvasId).toBeTruthy();
    expect(result.nodeCount).toBe(5);
    // 4 contains edges (plan → each step) + 2 depends_on (s1→s2, s2→s3).
    expect(result.edgeCount).toBe(6);

    const hydrated = await caller.hydrate({ id: result.canvasId });
    const planNode = hydrated.nodes.find((n) => n.targetType === "execution-plan");
    expect(planNode).toBeTruthy();
    expect(planNode?.ref.missing).toBe(false);
    expect(planNode?.ref.label).toBe("Ship the thing");
    const stepNodes = hydrated.nodes.filter((n) => n.targetType === "execution-step");
    expect(stepNodes).toHaveLength(4);
    for (const sn of stepNodes) {
      expect(sn.ref.missing).toBe(false);
    }

    const stepIdToNodeId = new Map(stepNodes.map((n) => [n.targetId, n.id]));
    const containsEdges = hydrated.edges.filter((e) => e.kind === "contains");
    expect(containsEdges).toHaveLength(4);
    const dependsEdges = hydrated.edges.filter((e) => e.kind === "depends_on");
    expect(dependsEdges).toHaveLength(2);

    const s1Node = stepIdToNodeId.get(s1.id)!;
    const s2Node = stepIdToNodeId.get(s2.id)!;
    const s3Node = stepIdToNodeId.get(s3.id)!;
    expect(
      dependsEdges.some((e) => e.fromNodeId === s1Node && e.toNodeId === s2Node),
    ).toBe(true);
    expect(
      dependsEdges.some((e) => e.fromNodeId === s2Node && e.toNodeId === s3Node),
    ).toBe(true);

    void s4;
  });

  it("createFromPlan rejects a plan from another workspace", async () => {
    const { caller } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "OPC" });
    fixtures.push(other);
    const otherPlan = await getPrisma().executionPlan.create({
      data: {
        workspaceId: other.workspace.id,
        title: "Foreign plan",
        status: "DRAFT",
      },
    });
    await expect(caller.createFromPlan({ planId: otherPlan.id })).rejects.toThrow(
      /not found/i,
    );
  });

  it("connects two nodes with an edge and tears the edge down with the node", async () => {
    const { fixture, caller } = await setup();
    const issueA = await createIssue(fixture);
    const issueB = await createIssue(fixture);
    const canvas = await caller.create({ name: "Board" });
    const a = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issueA.id,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
    });
    const b = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issueB.id,
      x: 300,
      y: 0,
      width: 240,
      height: 160,
    });
    const edge = await caller.addEdge({
      canvasId: canvas.id,
      fromNodeId: a.id,
      toNodeId: b.id,
      label: "blocks",
    });
    let got = await caller.get({ id: canvas.id });
    expect(got.edges).toHaveLength(1);
    expect(got.edges[0].id).toBe(edge.id);

    await caller.removeNode({ id: a.id });
    got = await caller.get({ id: canvas.id });
    expect(got.nodes).toHaveLength(1);
    expect(got.edges).toHaveLength(0);
  });
});
