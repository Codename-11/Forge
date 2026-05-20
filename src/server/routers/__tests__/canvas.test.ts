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

  // -------------------------------------------------------------------------
  // Workstream C — styles + components + instances + layer ops
  // -------------------------------------------------------------------------

  it("styleCreate / styleList roundtrip — kind filter + soft-delete via styleDelete", async () => {
    const { prisma, caller, fixture } = await setup();
    const colorRes = await caller.styleCreate({
      kind: "COLOR",
      name: "Primary",
      value: { hex: "#d97706" },
    });
    await caller.styleCreate({
      kind: "TEXT",
      name: "Heading",
      value: { family: "Inter", size: 24, weight: 600 },
    });
    await caller.styleCreate({
      kind: "EFFECT",
      name: "Card shadow",
      value: { shadow: { y: 2, blur: 8, color: "#0008" } },
    });

    const allActive = await caller.styleList({});
    expect(allActive.items).toHaveLength(3);
    expect(allActive.items.every((s) => s.archivedAt === null)).toBe(true);

    const justText = await caller.styleList({ kind: "TEXT" });
    expect(justText.items).toHaveLength(1);
    expect(justText.items[0].name).toBe("Heading");

    // Duplicate (kind, name) → CONFLICT
    await expect(
      caller.styleCreate({ kind: "COLOR", name: "Primary", value: { hex: "#fff" } }),
    ).rejects.toThrow(/already exists/i);

    // Update value via styleUpdate
    await caller.styleUpdate({
      styleId: colorRes.id,
      value: { hex: "#000000" },
    });
    const row = await prisma.canvasStyle.findUniqueOrThrow({ where: { id: colorRes.id } });
    expect((row.value as { hex?: string }).hex).toBe("#000000");

    // Soft-delete via styleDelete
    await caller.styleDelete({ styleId: colorRes.id });
    const afterDel = await caller.styleList({});
    expect(afterDel.items).toHaveLength(2);
    const withArchived = await caller.styleList({ includeArchived: true });
    expect(withArchived.items).toHaveLength(3);
    void fixture;
  });

  it("componentCreate + 3 instanceCreate + componentUpdate bumps updatedAt", async () => {
    const { prisma, caller } = await setup();
    const canvas = await caller.create({ name: "Components board" });
    const comp = await caller.componentCreate({
      name: "Card",
      description: "Reusable card",
      definition: {
        nodes: [],
        shapes: [
          { kind: "box", x: 0, y: 0, width: 200, height: 80, style: { fill: "#fff" } },
          { kind: "text", x: 8, y: 8, width: 184, height: 24, text: "Title" },
        ],
        frames: [],
        edges: [],
        width: 200,
        height: 80,
      },
    });

    // Duplicate name → CONFLICT
    await expect(
      caller.componentCreate({
        name: "Card",
        definition: { nodes: [], shapes: [], frames: [], edges: [], width: 100, height: 100 },
      }),
    ).rejects.toThrow(/already exists/i);

    const i1 = await caller.instanceCreate({ canvasId: canvas.id, componentId: comp.id, x: 0, y: 0 });
    const i2 = await caller.instanceCreate({ canvasId: canvas.id, componentId: comp.id, x: 240, y: 0 });
    const i3 = await caller.instanceCreate({ canvasId: canvas.id, componentId: comp.id, x: 480, y: 0 });
    expect(i1.id).toBeTruthy();
    expect(i2.id).toBeTruthy();
    expect(i3.id).toBeTruthy();

    const before = await prisma.canvasComponent.findUniqueOrThrow({ where: { id: comp.id } });
    await new Promise((r) => setTimeout(r, 12)); // ensure clock ticks beyond Postgres ms-resolution

    await caller.componentUpdate({
      componentId: comp.id,
      definition: {
        nodes: [],
        shapes: [
          { kind: "box", x: 0, y: 0, width: 200, height: 120, style: { fill: "#ffefcf" } },
          { kind: "text", x: 8, y: 8, width: 184, height: 24, text: "Title" },
        ],
        frames: [],
        edges: [],
        width: 200,
        height: 120,
      },
    });
    const after = await prisma.canvasComponent.findUniqueOrThrow({ where: { id: comp.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    // 3 instances should still exist and still reference the (updated) component
    const remaining = await prisma.canvasComponentInstance.count({
      where: { componentId: comp.id },
    });
    expect(remaining).toBe(3);

    const list = await caller.componentList({});
    expect(list.items).toHaveLength(1);
    expect(list.items[0]._count.instances).toBe(3);

    const get = await caller.componentGet({ componentId: comp.id });
    expect((get.definition as { width: number }).width).toBe(200);
  });

  it("instancePatch override map survives a subsequent componentUpdate", async () => {
    const { prisma, caller } = await setup();
    const canvas = await caller.create({ name: "Override board" });
    const comp = await caller.componentCreate({
      name: "Label",
      definition: {
        nodes: [],
        shapes: [{ kind: "text", x: 0, y: 0, width: 100, height: 24, text: "hi" }],
        frames: [],
        edges: [],
        width: 100,
        height: 24,
      },
    });
    const inst = await caller.instanceCreate({
      canvasId: canvas.id,
      componentId: comp.id,
      x: 50,
      y: 50,
    });
    await caller.instancePatch({
      instanceId: inst.id,
      overrides: { "shapes.0.text": "custom label" },
    });
    let row = await prisma.canvasComponentInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect((row.overrides as Record<string, unknown>)["shapes.0.text"]).toBe("custom label");

    // Mutate the component definition; the instance row should keep its
    // overrides unchanged.
    await caller.componentUpdate({
      componentId: comp.id,
      definition: {
        nodes: [],
        shapes: [{ kind: "text", x: 0, y: 0, width: 100, height: 24, text: "world" }],
        frames: [],
        edges: [],
        width: 100,
        height: 24,
      },
    });
    row = await prisma.canvasComponentInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect((row.overrides as Record<string, unknown>)["shapes.0.text"]).toBe("custom label");
  });

  it("instanceDetach materializes the definition (with overrides) and deletes the row", async () => {
    const { prisma, caller, fixture } = await setup();
    const issue = await createIssue(fixture);
    const canvas = await caller.create({ name: "Detach board" });
    const comp = await caller.componentCreate({
      name: "Hero",
      definition: {
        nodes: [
          {
            targetType: "issue",
            targetId: issue.id,
            x: 0,
            y: 0,
            width: 240,
            height: 160,
            viewMode: "card",
          },
        ],
        shapes: [
          {
            kind: "box",
            x: 250,
            y: 0,
            width: 200,
            height: 80,
            style: { fill: "#eed8b0" },
            text: "Hero",
          },
        ],
        frames: [],
        edges: [],
        width: 460,
        height: 160,
      },
    });
    const inst = await caller.instanceCreate({
      canvasId: canvas.id,
      componentId: comp.id,
      x: 100,
      y: 200,
    });
    // Override the shape's style fill — should show up on the materialised shape
    await caller.instancePatch({
      instanceId: inst.id,
      overrides: { "shapes.0.style": { fill: "#bb0000" } },
    });
    const out = await caller.instanceDetach({ instanceId: inst.id });
    expect(out.nodeIds).toHaveLength(1);
    expect(out.shapeIds).toHaveLength(1);
    expect(out.frameIds).toHaveLength(0);

    // Instance row gone
    const gone = await prisma.canvasComponentInstance.findUnique({ where: { id: inst.id } });
    expect(gone).toBeNull();

    // Materialised node lives on the canvas with the instance's x/y offset applied
    const node = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: out.nodeIds[0] } });
    expect(node.canvasId).toBe(canvas.id);
    expect(node.targetType).toBe("issue");
    expect(node.targetId).toBe(issue.id);
    expect(node.x).toBe(100);
    expect(node.y).toBe(200);

    // Materialised shape carries the override
    const shape = await prisma.canvasShape.findUniqueOrThrow({ where: { id: out.shapeIds[0] } });
    expect(shape.x).toBe(350);
    expect(shape.y).toBe(200);
    expect((shape.style as { fill?: string }).fill).toBe("#bb0000");
  });

  it("layerSetHidden / layerSetLocked are idempotent", async () => {
    const { prisma, caller, fixture } = await setup();
    const issue = await createIssue(fixture);
    const canvas = await caller.create({ name: "Layers board" });
    const node = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issue.id,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
    });
    await caller.layerSetHidden({ kind: "node", id: node.id, hidden: true });
    let row = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(row.hiddenAt).toBeInstanceOf(Date);
    const firstStamp = row.hiddenAt!.getTime();
    // Calling again with the same value is a no-op (timestamp must not bump)
    await caller.layerSetHidden({ kind: "node", id: node.id, hidden: true });
    row = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(row.hiddenAt!.getTime()).toBe(firstStamp);
    await caller.layerSetHidden({ kind: "node", id: node.id, hidden: false });
    row = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(row.hiddenAt).toBeNull();
    // Clearing again is also a no-op
    await caller.layerSetHidden({ kind: "node", id: node.id, hidden: false });

    // Same flow for lockedAt
    await caller.layerSetLocked({ kind: "node", id: node.id, locked: true });
    row = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(row.lockedAt).toBeInstanceOf(Date);
  });

  it("layerReorder assigns sequential z / zIndex values across mixed kinds", async () => {
    const { prisma, caller, fixture } = await setup();
    const issueA = await createIssue(fixture);
    const issueB = await createIssue(fixture);
    const canvas = await caller.create({ name: "Reorder board" });
    const n1 = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issueA.id,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
    });
    const n2 = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issueB.id,
      x: 280,
      y: 0,
      width: 240,
      height: 160,
    });
    const s1 = await caller.shapeAdd({
      canvasId: canvas.id,
      kind: "box",
      x: 0,
      y: 200,
      width: 100,
      height: 100,
    });

    await caller.layerReorder({
      canvasId: canvas.id,
      ordered: [
        { kind: "node", id: n2.id },
        { kind: "shape", id: s1.id },
        { kind: "node", id: n1.id },
      ],
    });

    const rowN1 = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: n1.id } });
    const rowN2 = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: n2.id } });
    const rowS1 = await prisma.canvasShape.findUniqueOrThrow({ where: { id: s1.id } });
    expect(rowN2.zIndex).toBe(0);
    expect(rowS1.zIndex).toBe(1);
    expect(rowN1.zIndex).toBe(2);
  });

  it("patchNode / shapePatch accept a styleRefs pass-through and clearing with null", async () => {
    const { prisma, caller, fixture } = await setup();
    const issue = await createIssue(fixture);
    const canvas = await caller.create({ name: "StyleRefs board" });
    const node = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issue.id,
      x: 0,
      y: 0,
      width: 240,
      height: 160,
    });
    const shape = await caller.shapeAdd({
      canvasId: canvas.id,
      kind: "box",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    await caller.patchNode({
      id: node.id,
      styleRefs: { fill: "style_color_primary", text: "style_text_h1" },
    });
    let nodeRow = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(nodeRow.styleRefs).toMatchObject({
      fill: "style_color_primary",
      text: "style_text_h1",
    });
    await caller.patchNode({ id: node.id, styleRefs: null });
    nodeRow = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(nodeRow.styleRefs).toBeNull();

    await caller.shapePatch({
      id: shape.id,
      styleRefs: { fill: "style_color_secondary" },
    });
    const shapeRow = await prisma.canvasShape.findUniqueOrThrow({ where: { id: shape.id } });
    expect(shapeRow.styleRefs).toMatchObject({ fill: "style_color_secondary" });
  });

  // -------------------------------------------------------------------------
  // Workstream B — frames, groups, pages, alignment
  // -------------------------------------------------------------------------

  it("frameAdd creates a frame and child node moves with it", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const canvas = await caller.create({ name: "Frame board" });
    const frame = await caller.frameAdd({
      canvasId: canvas.id,
      name: "Inputs",
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
    const node = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issue.id,
      x: 150,
      y: 150,
      width: 240,
      height: 160,
    });
    await prisma.workspaceCanvasNode.update({
      where: { id: node.id },
      data: { parentFrameId: frame.id },
    });
    await caller.framePatch({ frameId: frame.id, x: 200, y: 200 });
    const nodeRow = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(nodeRow.x).toBe(250);
    expect(nodeRow.y).toBe(250);
    const frameRow = await prisma.canvasFrame.findUniqueOrThrow({ where: { id: frame.id } });
    expect(frameRow.x).toBe(200);
    expect(frameRow.y).toBe(200);
  });

  it("groupCreate adds members, dissolve nulls memberships but preserves rows", async () => {
    const { fixture, prisma, caller } = await setup();
    const issueA = await createIssue(fixture);
    const issueB = await createIssue(fixture);
    const canvas = await caller.create({ name: "Group board" });
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
    const shape = await caller.shapeAdd({
      canvasId: canvas.id,
      kind: "box",
      x: 600,
      y: 0,
      width: 100,
      height: 100,
    });
    const group = await caller.groupCreate({
      canvasId: canvas.id,
      name: "Cluster",
      memberNodeIds: [a.id, b.id],
      memberShapeIds: [shape.id],
    });
    const aRow = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: a.id } });
    const bRow = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: b.id } });
    const sRow = await prisma.canvasShape.findUniqueOrThrow({ where: { id: shape.id } });
    expect(aRow.groupId).toBe(group.id);
    expect(bRow.groupId).toBe(group.id);
    expect(sRow.canvasGroupId).toBe(group.id);

    await caller.groupDissolve({ groupId: group.id });
    const aRowAfter = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: a.id } });
    const bRowAfter = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: b.id } });
    const sRowAfter = await prisma.canvasShape.findUniqueOrThrow({ where: { id: shape.id } });
    expect(aRowAfter.groupId).toBeNull();
    expect(bRowAfter.groupId).toBeNull();
    expect(sRowAfter.canvasGroupId).toBeNull();
    const gone = await prisma.canvasGroup.findUnique({ where: { id: group.id } });
    expect(gone).toBeNull();
  });

  it("pageAdd activates the first page, subsequent pages don't override", async () => {
    const { prisma, caller } = await setup();
    const canvas = await caller.create({ name: "Multi-page" });
    const p1 = await caller.pageAdd({ canvasId: canvas.id, name: "Page 1" });
    expect(p1.activated).toBe(true);
    let canvasRow = await prisma.workspaceCanvas.findUniqueOrThrow({ where: { id: canvas.id } });
    expect(canvasRow.activePageId).toBe(p1.frameId);

    const p2 = await caller.pageAdd({ canvasId: canvas.id, name: "Page 2" });
    expect(p2.activated).toBe(false);
    canvasRow = await prisma.workspaceCanvas.findUniqueOrThrow({ where: { id: canvas.id } });
    expect(canvasRow.activePageId).toBe(p1.frameId);

    await caller.pageActivate({ canvasId: canvas.id, frameId: p2.frameId });
    canvasRow = await prisma.workspaceCanvas.findUniqueOrThrow({ where: { id: canvas.id } });
    expect(canvasRow.activePageId).toBe(p2.frameId);
  });

  it("alignSelection alignLeft on 3 mixed-type items snaps all to leftmost x", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const canvas = await caller.create({ name: "Align board" });
    const node = await caller.addNode({
      canvasId: canvas.id,
      targetType: "issue",
      targetId: issue.id,
      x: 200,
      y: 0,
      width: 100,
      height: 100,
    });
    const shape = await caller.shapeAdd({
      canvasId: canvas.id,
      kind: "box",
      x: 50,
      y: 200,
      width: 100,
      height: 100,
    });
    const frame = await caller.frameAdd({
      canvasId: canvas.id,
      x: 300,
      y: 400,
      width: 100,
      height: 100,
    });
    await caller.alignSelection({
      canvasId: canvas.id,
      ids: { nodeIds: [node.id], shapeIds: [shape.id], frameIds: [frame.id] },
      op: "alignLeft",
    });
    const nodeRow = await prisma.workspaceCanvasNode.findUniqueOrThrow({ where: { id: node.id } });
    const shapeRow = await prisma.canvasShape.findUniqueOrThrow({ where: { id: shape.id } });
    const frameRow = await prisma.canvasFrame.findUniqueOrThrow({ where: { id: frame.id } });
    expect(nodeRow.x).toBe(50);
    expect(shapeRow.x).toBe(50);
    expect(frameRow.x).toBe(50);
  });

  it("alignSelection distributeH on 5 items produces equal gaps between first and last", async () => {
    const { fixture, prisma, caller } = await setup();
    const issues: Array<{ id: string; number: number }> = [];
    for (let i = 0; i < 5; i++) issues.push(await createIssue(fixture));
    const canvas = await caller.create({ name: "Distribute board" });
    const positions = [0, 50, 200, 250, 400];
    const nodes: Array<{ id: string }> = [];
    for (let i = 0; i < positions.length; i++) {
      nodes.push(
        await caller.addNode({
          canvasId: canvas.id,
          targetType: "issue",
          targetId: issues[i]!.id,
          x: positions[i]!,
          y: 0,
          width: 100,
          height: 100,
        }),
      );
    }
    await caller.alignSelection({
      canvasId: canvas.id,
      ids: { nodeIds: nodes.map((n) => n.id) },
      op: "distributeH",
    });
    const rows = await prisma.workspaceCanvasNode.findMany({
      where: { id: { in: nodes.map((n) => n.id) } },
      orderBy: { x: "asc" },
    });
    expect(rows.length).toBe(5);
    // First/last anchors stay fixed; gaps between adjacent rights/lefts equal.
    expect(rows[0]!.x).toBe(0);
    expect(rows[4]!.x).toBe(400);
    const gaps = rows
      .slice(1)
      .map((r, i) => r.x - (rows[i]!.x + rows[i]!.width));
    for (const g of gaps) {
      expect(Math.abs(g - gaps[0]!)).toBeLessThan(0.0001);
    }
  });
});
