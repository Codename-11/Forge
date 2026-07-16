import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentRunStatus } from "@prisma/client";
import { globalRouter } from "@/server/routers/global";
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

describe("globalRouter", () => {
  it("reports active runs against configured concurrent agent slots", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GLB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Capacity check" });
    const [finite, unlimited] = await Promise.all([
      prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Finite agent",
          profileKey: "finite-agent",
          status: "BUSY",
          maxConcurrent: 2,
        },
      }),
      prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Unlimited agent",
          profileKey: "unlimited-agent",
          status: "ONLINE",
          maxConcurrent: 0,
        },
      }),
    ]);
    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: finite.id,
        status: AgentRunStatus.ACTIVE,
      },
    });

    const caller = globalRouter.createCaller(await buildContext(fixture));
    await expect(caller.summary()).resolves.toMatchObject({
      activeRuns: 1,
      agentsOnline: 2,
      finiteRunSlots: 2,
      unlimitedRunAgents: 1,
    });

    expect(unlimited.maxConcurrent).toBe(0);
  });
});
