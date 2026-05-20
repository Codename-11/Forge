import { afterAll, afterEach, describe, expect, it } from "vitest";
import { refreshTodayZone } from "@/server/services/today-zone";
import {
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

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
  const fixture = await createWorkspaceFixture({ keyPrefix: "TDY" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const canvas = await prisma.workspaceCanvas.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Personal",
      kind: "PERSONAL",
      ownerUserId: fixture.user.id,
      createdById: fixture.user.id,
    },
  });
  return { fixture, prisma, canvas };
}

describe("refreshTodayZone", () => {
  it("creates a locked Today frame on first run, then is idempotent", async () => {
    const { fixture, prisma, canvas } = await setup();

    await refreshTodayZone(prisma, fixture.workspace.id, fixture.user.id, canvas.id);
    const frames1 = await prisma.canvasFrame.findMany({
      where: { canvasId: canvas.id },
      select: { id: true, name: true, lockedAt: true, backgroundFill: true },
    });
    expect(frames1).toHaveLength(1);
    expect(frames1[0].name).toBe("Today");
    expect(frames1[0].lockedAt).not.toBeNull();
    expect(frames1[0].backgroundFill).toMatchObject({ kind: "today-zone" });

    await refreshTodayZone(prisma, fixture.workspace.id, fixture.user.id, canvas.id);
    const frames2 = await prisma.canvasFrame.findMany({
      where: { canvasId: canvas.id },
    });
    expect(frames2).toHaveLength(1);
    expect(frames2[0].id).toBe(frames1[0].id);
  });

  it("places assigned issues as locked node children inside the frame", async () => {
    const { fixture, prisma, canvas } = await setup();
    const a = await createIssue(fixture, { title: "Wire up auth" });
    const b = await createIssue(fixture, { title: "Ship audit log" });
    await prisma.issueAssignee.createMany({
      data: [
        { issueId: a.id, userId: fixture.user.id },
        { issueId: b.id, userId: fixture.user.id },
      ],
    });

    await refreshTodayZone(prisma, fixture.workspace.id, fixture.user.id, canvas.id);

    const frame = await prisma.canvasFrame.findFirstOrThrow({
      where: { canvasId: canvas.id },
    });
    const childNodes = await prisma.workspaceCanvasNode.findMany({
      where: { parentFrameId: frame.id },
      select: { targetType: true, targetId: true, lockedAt: true, meta: true },
    });
    const issueTargets = new Set(childNodes.filter((n) => n.targetType === "issue").map((n) => n.targetId));
    expect(issueTargets.has(a.id)).toBe(true);
    expect(issueTargets.has(b.id)).toBe(true);
    for (const n of childNodes) {
      expect(n.lockedAt).not.toBeNull();
      expect(n.meta).toMatchObject({ todayZone: true });
    }
  });

  it("wipes prior children on re-run rather than duplicating", async () => {
    const { fixture, prisma, canvas } = await setup();
    const issue = await createIssue(fixture, { title: "First" });
    await prisma.issueAssignee.create({
      data: { issueId: issue.id, userId: fixture.user.id },
    });
    await refreshTodayZone(prisma, fixture.workspace.id, fixture.user.id, canvas.id);
    const frame = await prisma.canvasFrame.findFirstOrThrow({
      where: { canvasId: canvas.id },
    });
    const first = await prisma.workspaceCanvasNode.findMany({
      where: { parentFrameId: frame.id },
    });

    await refreshTodayZone(prisma, fixture.workspace.id, fixture.user.id, canvas.id);
    const second = await prisma.workspaceCanvasNode.findMany({
      where: { parentFrameId: frame.id },
    });

    expect(second).toHaveLength(first.length);
    // Ids change because the children are deleted + re-created — that's
    // the contract. What must hold is no duplication.
    const dedup = new Set(second.map((n) => `${n.targetType}:${n.targetId}`));
    expect(dedup.size).toBe(second.length);
  });
});
