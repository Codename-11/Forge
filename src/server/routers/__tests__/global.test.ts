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
  await getPrisma().agentProfile.deleteMany({
    where: {
      ownerId: { in: fixtures.flatMap((fixture) => [fixture.user.id, fixture.secondUser.id]) },
    },
  });
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("globalRouter", () => {
  it("does not expose other workspaces through owned or shared agent and runtime summaries", async () => {
    const owner = await createWorkspaceFixture({ keyPrefix: "GO" });
    const other = await createWorkspaceFixture({ keyPrefix: "GX" });
    fixtures.push(owner, other);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        ownerId: owner.user.id,
        ownerType: "PERSONAL",
        workspaceId: other.workspace.id,
        name: "Owned runtime",
        kind: "REMOTE_HTTP",
      },
    });
    const profile = await prisma.agentProfile.create({
      data: {
        ownerId: owner.user.id,
        profileKey: "global-visibility",
        name: "Shared profile",
        instanceShared: true,
      },
    });
    await prisma.agent.create({
      data: {
        workspaceId: other.workspace.id,
        profileId: profile.id,
        runtimeId: runtime.id,
        profileKey: profile.profileKey,
        name: "Private workspace agent",
        status: "ONLINE",
      },
    });
    const caller = globalRouter.createCaller(await buildContext(owner));
    const agent = (await caller.agents()).find((row) => row.id === profile.id)!;
    expect(agent.bindings).toEqual([]);
    expect(agent.bindingCount).toBe(0);
    expect(agent.online).toBe(false);
    const host = (await caller.runtimes()).find((row) => row.id === runtime.id)!;
    expect(host.homeWorkspace).toBeNull();
    expect(host.workspacesInUse).toEqual([]);
    expect(host.boundAgents).toEqual([]);
    const member = globalRouter.createCaller(
      await buildContext(owner, { asUserId: owner.secondUser.id }),
    );
    expect((await member.agents()).find((row) => row.id === profile.id)?.bindings).toEqual([]);

    await prisma.user.update({
      where: { id: owner.user.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    expect((await caller.agents()).find((row) => row.id === profile.id)?.bindings).toHaveLength(1);
    expect((await caller.runtimes()).find((row) => row.id === runtime.id)?.homeWorkspace?.id).toBe(
      other.workspace.id,
    );
  });

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
