import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventKind } from "@prisma/client";
import { agentBindingRouter } from "@/server/routers/agent-binding";
import {
  buildContext,
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

async function makeProfile(fixture: TestFixture, profileKey: string) {
  return getPrisma().agentProfile.create({
    data: {
      ownerId: fixture.user.id,
      profileKey,
      name: profileKey,
      approvedAt: new Date(),
    },
  });
}

describe("Mission Control workspace binding actions", () => {
  it("lets a workspace owner bind and unbind with durable audit events", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCB" });
    fixtures.push(fixture);
    const profile = await makeProfile(fixture, "mission-control-bind");
    const caller = agentBindingRouter.createCaller(await buildContext(fixture));

    const binding = await caller.bindFromMissionControl({
      workspaceId: fixture.workspace.id,
      profileId: profile.id,
    });

    expect(binding.workspaceId).toBe(fixture.workspace.id);
    expect(binding.profileId).toBe(profile.id);
    await expect(
      getPrisma().activityEvent.findFirst({
        where: {
          workspaceId: fixture.workspace.id,
          subjectId: binding.id,
          kind: EventKind.AGENT_CREATED,
        },
      }),
    ).resolves.not.toBeNull();

    await caller.unbindFromMissionControl({
      workspaceId: fixture.workspace.id,
      agentId: binding.id,
    });

    const archived = await getPrisma().agent.findUniqueOrThrow({
      where: { id: binding.id },
      select: { archivedAt: true },
    });
    expect(archived.archivedAt).not.toBeNull();
    await expect(
      getPrisma().activityEvent.findFirst({
        where: {
          workspaceId: fixture.workspace.id,
          subjectId: binding.id,
          kind: EventKind.AGENT_DELETED,
        },
      }),
    ).resolves.not.toBeNull();
  });

  it("rejects bind and unbind actions from a non-admin workspace member", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCF" });
    fixtures.push(fixture);
    const profile = await makeProfile(fixture, "mission-control-guarded");
    const ownerCaller = agentBindingRouter.createCaller(await buildContext(fixture));
    const memberCaller = agentBindingRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );

    await expect(
      memberCaller.bindFromMissionControl({
        workspaceId: fixture.workspace.id,
        profileId: profile.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const binding = await ownerCaller.bindFromMissionControl({
      workspaceId: fixture.workspace.id,
      profileId: profile.id,
    });
    await expect(
      memberCaller.unbindFromMissionControl({
        workspaceId: fixture.workspace.id,
        agentId: binding.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      getPrisma().agent.findUniqueOrThrow({
        where: { id: binding.id },
        select: { archivedAt: true },
      }),
    ).resolves.toEqual({ archivedAt: null });
  });
});
