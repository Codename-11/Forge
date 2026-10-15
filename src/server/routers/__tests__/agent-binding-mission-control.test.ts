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
  it.each(["disabled", "pending", "archived"] as const)(
    "rejects %s profiles through both entrypoints and hides them from the catalog",
    async (state) => {
      const fixture = await createWorkspaceFixture({ keyPrefix: "BG" });
      fixtures.push(fixture);
      const profile = await makeProfile(fixture, `unavailable-${state}`);
      await getPrisma().agentProfile.update({
        where: { id: profile.id },
        data:
          state === "disabled"
            ? { disabledAt: new Date() }
            : state === "archived"
              ? { archivedAt: new Date() }
              : { requestedById: fixture.user.id, approvedAt: null },
      });
      const caller = agentBindingRouter.createCaller(await buildContext(fixture));
      const code = state === "archived" ? "NOT_FOUND" : "FORBIDDEN";
      await expect(caller.bind({ profileId: profile.id })).rejects.toMatchObject({ code });
      await expect(
        caller.bindFromMissionControl({ workspaceId: fixture.workspace.id, profileId: profile.id }),
      ).rejects.toMatchObject({ code });
      expect((await caller.catalog()).some((row) => row.id === profile.id)).toBe(false);
      expect(await getPrisma().agent.count({ where: { profileId: profile.id } })).toBe(0);
    },
  );

  it("keeps private profile access consistent without granting workspace administration", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "BA" });
    fixtures.push(fixture);
    const profile = await getPrisma().agentProfile.create({
      data: {
        ownerId: fixture.secondUser.id,
        profileKey: "private-definition",
        name: "Private definition",
        approvedAt: new Date(),
      },
    });
    const caller = agentBindingRouter.createCaller(await buildContext(fixture));
    expect((await caller.catalog()).some((row) => row.id === profile.id)).toBe(false);
    await expect(caller.bind({ profileId: profile.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.bindFromMissionControl({ workspaceId: fixture.workspace.id, profileId: profile.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await getPrisma().user.update({
      where: { id: fixture.user.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    expect((await caller.catalog()).some((row) => row.id === profile.id)).toBe(true);
    const binding = await caller.bind({ profileId: profile.id });
    await caller.unbind({ agentId: binding.id });
    expect(
      (
        await caller.bindFromMissionControl({
          workspaceId: fixture.workspace.id,
          profileId: profile.id,
        })
      ).id,
    ).toBe(binding.id);

    await getPrisma().user.update({
      where: { id: fixture.secondUser.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    const member = agentBindingRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );
    await expect(member.bind({ profileId: profile.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      member.bindFromMissionControl({ workspaceId: fixture.workspace.id, profileId: profile.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

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
