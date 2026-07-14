import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pinRouter } from "@/server/routers/pin";
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
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("pinRouter legacy row ids", () => {
  it("reorders and removes migration-0023 pin_ ids", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "PIN" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const caller = pinRouter.createCaller(await buildContext(fixture));
    const legacyIssue = await createIssue(fixture, { title: "Legacy pinned issue" });
    const modernIssue = await createIssue(fixture, { title: "Modern pinned issue" });
    const legacyId = "pin_5c6707a7bb57b32f8e6ac1f622b7fe4c";
    await prisma.pin.create({
      data: {
        id: legacyId,
        userId: fixture.user.id,
        workspaceId: null,
        targetType: "ISSUE",
        targetId: legacyIssue.id,
        orderIndex: 0,
      },
    });
    const modern = await prisma.pin.create({
      data: {
        userId: fixture.user.id,
        workspaceId: null,
        targetType: "ISSUE",
        targetId: modernIssue.id,
        orderIndex: 1,
      },
    });

    await expect(
      caller.reorder({ workspaceId: null, ids: [modern.id, legacyId] }),
    ).resolves.toEqual({ reordered: 2 });
    const ordered = await caller.listAll({ workspaceId: null });
    expect(ordered.map((pin) => pin.id)).toEqual([modern.id, legacyId]);

    await expect(caller.remove({ id: legacyId })).resolves.toEqual({ removed: 1 });
    expect(await prisma.pin.findUnique({ where: { id: legacyId } })).toBeNull();
  });
});
