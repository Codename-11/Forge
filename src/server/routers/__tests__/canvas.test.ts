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

  it("addNote spawns a NOTE artifact + canvas node referencing it", async () => {
    const { prisma, caller } = await setup();
    const canvas = await caller.create({ name: "Idea board" });
    const result = await caller.addNote({
      canvasId: canvas.id,
      body: "Phase 1 outline\nFigure out auth\nFigure out billing",
      x: 100,
      y: 200,
    });
    expect(result.nodeId).toBeTruthy();
    expect(result.artifactId).toBeTruthy();

    const artifact = await prisma.artifact.findUniqueOrThrow({
      where: { id: result.artifactId },
    });
    expect(artifact.type).toBe("NOTE");
    expect(artifact.body).toContain("Figure out auth");
    expect(artifact.title).toBe("Phase 1 outline");

    const node = await prisma.workspaceCanvasNode.findUniqueOrThrow({
      where: { id: result.nodeId },
    });
    expect(node.targetType).toBe("artifact");
    expect(node.targetId).toBe(result.artifactId);
    expect(node.viewMode).toBe("card");
    expect(node.width).toBe(240);
    expect(node.height).toBe(160);
    expect(node.meta).toMatchObject({ kind: "NOTE" });
  });

  it("addNote rejects when the canvas belongs to another workspace", async () => {
    const { caller } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "OCN" });
    fixtures.push(other);
    const otherCtx = await buildContext(other);
    const otherCaller = canvasRouter.createCaller(otherCtx);
    const otherCanvas = await otherCaller.create({ name: "Foreign board" });
    await expect(
      caller.addNote({ canvasId: otherCanvas.id, body: "x", x: 0, y: 0 }),
    ).rejects.toThrow(/not found/i);
  });

  it("addChatThread accepts owner-visible threads and rejects cross-workspace threads", async () => {
    const { fixture, prisma, caller } = await setup();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `agt-${Date.now()}`,
        name: "Listener",
      },
    });
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        agentId: agent.id,
        title: "Synthesis chat",
      },
    });
    const canvas = await caller.create({ name: "Board" });
    const result = await caller.addChatThread({
      canvasId: canvas.id,
      threadId: thread.id,
      x: 0,
      y: 0,
    });
    const node = await prisma.workspaceCanvasNode.findUniqueOrThrow({
      where: { id: result.nodeId },
    });
    expect(node.targetType).toBe("chat-thread");
    expect(node.targetId).toBe(thread.id);

    const other = await createWorkspaceFixture({ keyPrefix: "OTH" });
    fixtures.push(other);
    const otherAgent = await prisma.agent.create({
      data: {
        workspaceId: other.workspace.id,
        profileKey: `agt2-${Date.now()}`,
        name: "Stranger",
      },
    });
    const otherThread = await prisma.chatThread.create({
      data: {
        workspaceId: other.workspace.id,
        userId: other.user.id,
        agentId: otherAgent.id,
      },
    });
    await expect(
      caller.addChatThread({ canvasId: canvas.id, threadId: otherThread.id, x: 0, y: 0 }),
    ).rejects.toThrow(/not found/i);
  });

  it("convertToPlan walks mixed nodes, links steps, copies notes, and resolves dependencies", async () => {
    const { fixture, prisma, caller } = await setup();
    const canvas = await caller.create({ name: "Synthesis" });

    // 1 existing execution-step (linked, copied with body)
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Source plan",
        status: "DRAFT",
      },
    });
    const existingStep = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Design API",
        body: "REST shape",
        position: 0,
      },
    });
    const stepNode = await caller.addNode({
      canvasId: canvas.id,
      targetType: "execution-step",
      targetId: existingStep.id,
      x: 0,
      y: 0,
      width: 280,
      height: 140,
    });

    // 2 notes
    const noteA = await caller.addNote({
      canvasId: canvas.id,
      body: "Build the runtime\nSubdesc one\nSubdesc two",
      x: 0,
      y: 200,
    });
    const noteB = await caller.addNote({
      canvasId: canvas.id,
      body: "Ship the feature",
      x: 0,
      y: 400,
    });

    // 1 ignored issue node
    const issue = await createIssue(fixture);
    const issueNode = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issue.id,
      x: 0,
      y: 600,
      width: 240,
      height: 160,
    });

    // Depends_on edge from stepNode → noteA (note depends on existing step)
    await caller.addEdge({
      canvasId: canvas.id,
      fromNodeId: stepNode.id,
      toNodeId: noteA.nodeId,
      kind: "depends_on",
    });

    const result = await caller.convertToPlan({ canvasId: canvas.id, title: "Distilled plan" });
    expect(result.planId).toBeTruthy();
    expect(result.stepCount).toBe(3);
    expect(result.skippedNodes).toHaveLength(1);
    expect(result.skippedNodes[0].nodeId).toBe(issueNode.id);
    expect(result.skippedNodes[0].reason).toMatch(/issue/);

    const newPlan = await prisma.executionPlan.findUniqueOrThrow({
      where: { id: result.planId },
      include: { steps: { orderBy: { position: "asc" } } },
    });
    expect(newPlan.title).toBe("Distilled plan");
    expect(newPlan.status).toBe("DRAFT");
    expect(newPlan.description).toMatch(/Imported from canvas 'Synthesis'/);
    expect(newPlan.steps).toHaveLength(3);

    // Position 0 = the linked existing step (y=0)
    expect(newPlan.steps[0].title).toBe("Design API");
    expect(newPlan.steps[0].body).toBe("REST shape");
    // Position 1 = noteA (title from first line, body from rest)
    expect(newPlan.steps[1].title).toBe("Build the runtime");
    expect(newPlan.steps[1].body).toBe("Subdesc one\nSubdesc two");
    expect(newPlan.steps[1].dependsOnStepIds).toEqual([newPlan.steps[0].id]);
    // Position 2 = noteB (single-line note → body null)
    expect(newPlan.steps[2].title).toBe("Ship the feature");
    expect(newPlan.steps[2].body).toBeNull();

    void noteB;
  });

  it("broadcastPresence publishes for the workspace and rejects foreign canvases", async () => {
    const { caller } = await setup();
    const canvas = await caller.create({ name: "Presence board" });
    const ok = await caller.broadcastPresence({ canvasId: canvas.id, x: 10, y: 20 });
    expect(ok.ok).toBe(true);

    const other = await createWorkspaceFixture({ keyPrefix: "FOR" });
    fixtures.push(other);
    const otherCaller = canvasRouter.createCaller(await buildContext(other));
    const otherCanvas = await otherCaller.create({ name: "Foreign" });
    await expect(
      caller.broadcastPresence({ canvasId: otherCanvas.id, x: 0, y: 0 }),
    ).rejects.toThrow(/not found/i);
  });

  it("hydrate returns rich chat-thread + NOTE artifact shapes for canvas nodes", async () => {
    const { fixture, prisma, caller } = await setup();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `hyd-${Date.now()}`,
        name: "Hydrator",
        avatar: "https://example.com/a.png",
      },
    });
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        agentId: agent.id,
        title: "Hydrate me",
      },
    });
    const msg1 = await prisma.chatMessage.create({
      data: {
        workspaceId: fixture.workspace.id,
        threadId: thread.id,
        role: "USER",
        body: "first",
        dispatchedAt: new Date(),
      },
    });
    const msg2 = await prisma.chatMessage.create({
      data: {
        workspaceId: fixture.workspace.id,
        threadId: thread.id,
        role: "AGENT",
        body: "second",
      },
    });
    const msg3 = await prisma.chatMessage.create({
      data: {
        workspaceId: fixture.workspace.id,
        threadId: thread.id,
        role: "AGENT",
        body: "third",
      },
    });
    void msg1;
    void msg2;
    void msg3;

    const canvas = await caller.create({ name: "Hydrate" });
    await caller.addChatThread({ canvasId: canvas.id, threadId: thread.id, x: 0, y: 0 });
    const note = await caller.addNote({
      canvasId: canvas.id,
      body: "Hello\nWorld",
      x: 100,
      y: 100,
    });

    const hydrated = await caller.hydrate({ id: canvas.id });
    const threadNode = hydrated.nodes.find((n) => n.targetType === "chat-thread")!;
    expect(threadNode.ref.missing).toBe(false);
    expect(threadNode.ref.label).toBe("Hydrate me");
    const tMeta = threadNode.ref.meta as Record<string, unknown>;
    expect(tMeta.agent).toMatchObject({
      profileKey: agent.profileKey,
      name: "Hydrator",
      avatar: "https://example.com/a.png",
    });
    expect(tMeta.lastMessageAt).toBeTruthy();
    expect(Array.isArray(tMeta.preview)).toBe(true);
    expect((tMeta.preview as unknown[]).length).toBeGreaterThan(0);

    const noteNode = hydrated.nodes.find((n) => n.id === note.nodeId)!;
    expect(noteNode.ref.missing).toBe(false);
    expect(noteNode.ref.subLabel).toBe("note");
    const aMeta = noteNode.ref.meta as Record<string, unknown>;
    expect(aMeta.kind).toBe("NOTE");
    expect(aMeta.body).toBe("Hello\nWorld");
    expect(aMeta.updatedAt).toBeTruthy();
  });
});
