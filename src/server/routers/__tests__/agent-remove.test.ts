import { describe, it, expect, afterEach, afterAll } from "vitest";
import { agentRouter } from "@/server/routers/agent";
import { agentProfileRouter } from "@/server/routers/agent-profile";
import {
  buildContext,
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

// Smart remove: a genuinely unused agent/profile is hard-deleted; one with
// history (runs, assignments, bindings, …) is archived instead so nothing is
// cascade-deleted. `AgentRun.agentId` is onDelete:Cascade, so a naive delete of
// an agent with runs would destroy that history — hence the guard.

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function makeAgent(fixture: TestFixture, profileKey: string) {
  return getPrisma().agent.create({
    data: { workspaceId: fixture.workspace.id, name: profileKey, profileKey },
    select: { id: true, name: true },
  });
}

describe("agent.remove — workspace smart delete", () => {
  it("hard-deletes an unused agent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARM" });
    fixtures.push(fixture);
    const agent = await makeAgent(fixture, "throwaway");

    const caller = agentRouter.createCaller(await buildContext(fixture));
    const res = await caller.remove({ id: agent.id });

    expect(res.action).toBe("deleted");
    expect(res.name).toBe("throwaway");
    expect(await getPrisma().agent.findUnique({ where: { id: agent.id } })).toBeNull();
  });

  it("archives (never deletes) an agent that has history", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARA" });
    fixtures.push(fixture);
    const agent = await makeAgent(fixture, "worker");
    const issue = await createIssue(fixture, { title: "assigned work" });
    await getPrisma().issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });

    const caller = agentRouter.createCaller(await buildContext(fixture));
    const res = await caller.remove({ id: agent.id });

    expect(res.action).toBe("archived");
    expect(res.references).toHaveProperty("assignedIssues", 1);
    const row = await getPrisma().agent.findUnique({
      where: { id: agent.id },
      select: { archivedAt: true, status: true },
    });
    expect(row?.archivedAt).not.toBeNull();
    expect(row?.status).toBe("OFFLINE");
  });

  it("forbids a non-admin MEMBER from removing an agent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARF" });
    fixtures.push(fixture);
    const agent = await makeAgent(fixture, "guarded");

    const memberCaller = agentRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );
    await expect(memberCaller.remove({ id: agent.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await getPrisma().agent.findUnique({ where: { id: agent.id } })).not.toBeNull();
  });
});

describe("agents.profiles.remove — instance-admin smart delete", () => {
  async function adminCaller(fixture: TestFixture) {
    await getPrisma().user.update({
      where: { id: fixture.user.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    return agentProfileRouter.createCaller(await buildContext(fixture));
  }
  async function makeProfile(fixture: TestFixture, profileKey: string) {
    return getPrisma().agentProfile.create({
      data: { ownerId: fixture.user.id, profileKey, name: profileKey },
      select: { id: true, name: true },
    });
  }

  it("hard-deletes a profile with no bindings", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "PRM" });
    fixtures.push(fixture);
    const profile = await makeProfile(fixture, "cli-temp");

    const caller = await adminCaller(fixture);
    const res = await caller.remove({ id: profile.id });

    expect(res.action).toBe("deleted");
    expect(await getPrisma().agentProfile.findUnique({ where: { id: profile.id } })).toBeNull();
  });

  it("archives a profile that still has a binding", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "PRA" });
    fixtures.push(fixture);
    const profile = await makeProfile(fixture, "bound-prof");
    await getPrisma().agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "bound",
        profileKey: "bound-prof",
        profileId: profile.id,
      },
    });

    const caller = await adminCaller(fixture);
    const res = await caller.remove({ id: profile.id });

    expect(res.action).toBe("archived");
    expect(res.boundAgents).toBe(1);
    const row = await getPrisma().agentProfile.findUnique({
      where: { id: profile.id },
      select: { archivedAt: true },
    });
    expect(row?.archivedAt).not.toBeNull();
  });
});
