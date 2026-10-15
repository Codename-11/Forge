import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProfile, InstanceAgentPolicy } from "@prisma/client";
import { agentProfileRouter } from "@/server/routers/agent-profile";
import { agentBindingRouter } from "@/server/routers/agent-binding";
import { globalRouter } from "@/server/routers/global";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];
let originalPolicy: InstanceAgentPolicy | null;

beforeEach(async () => {
  originalPolicy = await getPrisma().instanceAgentPolicy.findUnique({ where: { id: "default" } });
});
afterEach(async () => {
  const db = getPrisma();
  const userIds = fixtures.flatMap((fixture) => [fixture.user.id, fixture.secondUser.id]);
  await db.agentProfile.deleteMany({
    where: { OR: [{ ownerId: { in: userIds } }, { createdById: { in: userIds } }] },
  });
  await db.instanceAuditLog.deleteMany({ where: { actorId: { in: userIds } } });
  while (fixtures.length) await fixtures.pop()!.cleanup();
  if (originalPolicy) {
    await db.instanceAgentPolicy.upsert({
      where: { id: "default" },
      create: originalPolicy,
      update: { personalAgentCreation: originalPolicy.personalAgentCreation },
    });
  } else {
    await db.instanceAgentPolicy.deleteMany({ where: { id: "default" } });
  }
});
afterAll(disconnectPrisma);

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "PO" });
  fixtures.push(fixture);
  await getPrisma().user.update({
    where: { id: fixture.user.id },
    data: { instanceRole: "INSTANCE_ADMIN" },
  });
  return {
    fixture,
    admin: agentProfileRouter.createCaller(await buildContext(fixture)),
    member: agentProfileRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    ),
  };
}

function snapshot(profile: Pick<AgentProfile, "ownerType" | "ownerId" | "updatedAt">) {
  return {
    expectedOwnerType: profile.ownerType as "PERSONAL" | "SERVICE",
    expectedOwnerId: profile.ownerId,
    expectedUpdatedAt: profile.updatedAt,
  };
}

describe("Explicit agent ownership and personal creation policy", () => {
  it.each(["bind", "bindFromMissionControl"] as const)(
    "%s waits for an ownership change and rechecks availability",
    async (entrypoint) => {
      const { fixture, admin } = await setup();
      const profile = await admin.create({
        profileKey: `lock-${entrypoint.toLowerCase()}`,
        name: "Ownership lock",
      });
      await getPrisma().user.update({
        where: { id: fixture.user.id },
        data: { instanceRole: "MEMBER" },
      });
      const caller = agentBindingRouter.createCaller(await buildContext(fixture));
      let unlock!: () => void;
      let signalLocked!: () => void;
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const transfer = getPrisma().$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "AgentProfile" WHERE "id" = ${profile.id} FOR UPDATE`;
          await tx.agentProfile.update({
            where: { id: profile.id },
            data: { ownerId: fixture.secondUser.id },
          });
          signalLocked();
          await release;
        },
        { timeout: 10_000 },
      );
      await locked;
      const attempt = (
        entrypoint === "bind"
          ? caller.bind({ profileId: profile.id })
          : caller.bindFromMissionControl({
              profileId: profile.id,
              workspaceId: fixture.workspace.id,
            })
      ).then(
        () => ({ code: "UNEXPECTED_SUCCESS" }),
        (error: unknown) => error as { code: string },
      );
      let observedLock = false;
      try {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const waiting = await getPrisma().$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%AgentProfile%FOR SHARE%'`;
          if (Number(waiting[0]?.count ?? 0) > 0) {
            observedLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        unlock();
        await transfer;
      }
      expect(observedLock).toBe(true);
      expect(await attempt).toMatchObject({ code: "FORBIDDEN" });
      expect(await getPrisma().agent.count({ where: { profileId: profile.id } })).toBe(0);
    },
  );

  it("defaults to approval and never confers workspace access with a request", async () => {
    const { fixture, member } = await setup();
    await getPrisma().instanceAgentPolicy.deleteMany({ where: { id: "default" } });
    expect(await member.policy()).toEqual({ personalAgentCreation: "APPROVAL_REQUIRED" });
    const profile = await member.request({
      profileKey: "pending-personal",
      name: "Pending personal",
    });
    expect(profile).toMatchObject({
      ownerType: "PERSONAL",
      ownerId: fixture.secondUser.id,
      createdById: fixture.secondUser.id,
      requestedById: fixture.secondUser.id,
      approvedAt: null,
      runtimeId: null,
      instanceShared: false,
    });
    expect(await getPrisma().agent.count({ where: { profileId: profile.id } })).toBe(0);
    const bindings = agentBindingRouter.createCaller(await buildContext(fixture));
    await expect(bindings.bind({ profileId: profile.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("honors disabled/self-service policy without accepting sharing or runtime authority", async () => {
    const { fixture, admin, member } = await setup();
    await expect(member.setPolicy({ personalAgentCreation: "SELF_SERVICE" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await admin.setPolicy({ personalAgentCreation: "DISABLED" });
    await expect(
      member.request({ profileKey: "disabled-personal", name: "Disabled" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await admin.setPolicy({ personalAgentCreation: "SELF_SERVICE" });
    const elevated = { profileKey: "elevated", name: "Elevated", instanceShared: true };
    await expect(member.request(elevated)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const profile = await member.request({ profileKey: "self-service", name: "Self service" });
    expect(profile.approvedAt).not.toBeNull();
    expect(profile).toMatchObject({
      ownerType: "PERSONAL",
      ownerId: fixture.secondUser.id,
      createdById: fixture.secondUser.id,
      instanceShared: false,
      runtimeId: null,
    });
    const memberBindings = agentBindingRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );
    await expect(memberBindings.bind({ profileId: profile.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      await getPrisma().instanceAuditLog.count({
        where: { actorId: fixture.user.id, action: "agent.policy.updated" },
      }),
    ).toBe(2);
  });

  it("keeps service ownership independent of creator and catalog sharing", async () => {
    const { fixture, admin, member } = await setup();
    const profile = await admin.create({
      profileKey: "service-owner",
      name: "Service owner",
      ownerType: "SERVICE",
    });
    expect(profile).toMatchObject({
      ownerType: "SERVICE",
      ownerId: null,
      createdById: fixture.user.id,
      instanceShared: false,
    });
    expect((await admin.get({ id: profile.id })).availability.scope).toBe("ADMIN_ONLY");
    await expect(
      member.create({ profileKey: "not-service", name: "Not service", ownerType: "SERVICE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.get({ id: profile.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await admin.setInstanceShared({ id: profile.id, instanceShared: true });
    expect((await member.get({ id: profile.id })).canEdit).toBe(false);
    await expect(member.update({ id: profile.id, name: "Cannot edit" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      admin.create({ profileKey: profile.profileKey, name: "Duplicate", ownerType: "SERVICE" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      admin.create({
        profileKey: profile.profileKey,
        name: "Different personal owner",
        ownerType: "PERSONAL",
        ownerId: fixture.secondUser.id,
      }),
    ).resolves.toMatchObject({ ownerId: fixture.secondUser.id });
    await expect(
      admin.create({
        profileKey: "invalid-service",
        name: "Invalid",
        ownerType: "SERVICE",
        ownerId: fixture.user.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires an explicit runtime clear before transferring private runtime authority", async () => {
    const { fixture, admin } = await setup();
    const runtime = await getPrisma().runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerType: "PERSONAL",
        ownerId: fixture.user.id,
        kind: "REMOTE_HTTP",
        name: "Private runtime",
      },
    });
    const profile = await admin.create({
      profileKey: "runtime-transfer",
      name: "Runtime transfer",
      runtimeId: runtime.id,
    });
    const bindings = agentBindingRouter.createCaller(await buildContext(fixture));
    const binding = await bindings.bind({ profileId: profile.id });
    await expect(
      admin.transferOwnership({ id: profile.id, ownerType: "SERVICE", ...snapshot(profile) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const transferred = await admin.transferOwnership({
      id: profile.id,
      ownerType: "SERVICE",
      clearRuntime: true,
      ...snapshot(profile),
    });
    expect(transferred).toMatchObject({
      ownerType: "SERVICE",
      ownerId: null,
      runtimeId: null,
      createdById: fixture.user.id,
    });
    expect(
      (await getPrisma().agent.findUniqueOrThrow({ where: { id: binding.id } })).runtimeId,
    ).toBeNull();
    await expect(
      admin.transferOwnership({
        id: profile.id,
        ownerType: "PERSONAL",
        ownerId: fixture.secondUser.id,
        ...snapshot(profile),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const personal = await admin.transferOwnership({
      id: profile.id,
      ownerType: "PERSONAL",
      ownerId: fixture.secondUser.id,
      ...snapshot(transferred),
    });
    expect(personal).toMatchObject({
      ownerId: fixture.secondUser.id,
      createdById: fixture.user.id,
      instanceShared: false,
    });
    const audit = await getPrisma().instanceAuditLog.findMany({
      where: { actorId: fixture.user.id, action: "agent.profile.ownership_transferred" },
    });
    expect(audit).toHaveLength(2);
    expect(audit[0]?.metadata).not.toHaveProperty("webhookSecret");
  });

  it("rejects suspended targets, unauthorized actors, and concurrent stale transfers", async () => {
    const { fixture, admin, member } = await setup();
    const profile = await admin.create({
      profileKey: "transfer-concurrency",
      name: "Transfer concurrency",
    });
    await expect(
      member.transferOwnership({ id: profile.id, ownerType: "SERVICE", ...snapshot(profile) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await getPrisma().user.update({
      where: { id: fixture.secondUser.id },
      data: { status: "SUSPENDED" },
    });
    await expect(
      admin.transferOwnership({
        id: profile.id,
        ownerType: "PERSONAL",
        ownerId: fixture.secondUser.id,
        ...snapshot(profile),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (await admin.ownershipCandidates()).some((user) => user.id === fixture.secondUser.id),
    ).toBe(false);
    await getPrisma().user.update({
      where: { id: fixture.secondUser.id },
      data: { status: "ACTIVE" },
    });
    const results = await Promise.allSettled([
      admin.transferOwnership({ id: profile.id, ownerType: "SERVICE", ...snapshot(profile) }),
      admin.transferOwnership({
        id: profile.id,
        ownerType: "PERSONAL",
        ownerId: fixture.secondUser.id,
        ...snapshot(profile),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await getPrisma().instanceAuditLog.count({
        where: { actorId: fixture.user.id, action: "agent.profile.ownership_transferred" },
      }),
    ).toBe(1);
  });

  it("does not lend an administrator's private runtime to another profile owner", async () => {
    const { fixture, admin } = await setup();
    const privateRuntime = await getPrisma().runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerType: "PERSONAL",
        ownerId: fixture.user.id,
        name: "Private",
        kind: "REMOTE_HTTP",
      },
    });
    await expect(
      admin.create({
        profileKey: "different-owner",
        name: "Different owner",
        ownerId: fixture.secondUser.id,
        runtimeId: privateRuntime.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.create({
        profileKey: "private-service",
        name: "Private service",
        ownerType: "SERVICE",
        runtimeId: privateRuntime.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const serviceRuntime = await getPrisma().runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerType: "SERVICE",
        ownerId: null,
        name: "Service",
        kind: "REMOTE_HTTP",
      },
    });
    const globals = globalRouter.createCaller(await buildContext(fixture));
    const memberGlobals = globalRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );
    const serviceOptions = await globals.runtimeOptions({ ownerType: "SERVICE" });
    expect(serviceOptions.some((row) => row.id === privateRuntime.id)).toBe(false);
    expect(serviceOptions.some((row) => row.id === serviceRuntime.id)).toBe(true);
    expect(serviceOptions.every((row) => !("config" in row) && !("endpoint" in row))).toBe(true);
    await expect(memberGlobals.runtimeOptions({ ownerType: "SERVICE" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await memberGlobals.runtimeOptions()).some((row) => row.id === serviceRuntime.id)).toBe(
      false,
    );
    await expect(
      admin.create({
        profileKey: "service-runtime",
        name: "Service runtime",
        ownerType: "SERVICE",
        runtimeId: serviceRuntime.id,
      }),
    ).resolves.toMatchObject({ ownerType: "SERVICE", runtimeId: serviceRuntime.id });
    await getPrisma().runtime.update({
      where: { id: privateRuntime.id },
      data: { instanceShared: true },
    });
    await expect(
      admin.create({
        profileKey: "shared-runtime",
        name: "Shared runtime",
        ownerId: fixture.secondUser.id,
        runtimeId: privateRuntime.id,
      }),
    ).resolves.toMatchObject({ ownerId: fixture.secondUser.id, runtimeId: privateRuntime.id });
  });
});
