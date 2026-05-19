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
