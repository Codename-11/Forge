import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ReviewGateStatus } from "@prisma/client";
import { agentCrewRouter, reviewGateRouter } from "@/server/routers/agent-crew";
import {
  buildContext,
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
    const { fixture, prisma, crewCaller } = await setup();
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
    await expect(
      gateCaller.resolve({ id: open.id, decision: "APPROVED" }),
    ).rejects.toThrow(/already/);
  });
});
