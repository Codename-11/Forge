import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const db = getPrisma();
let fixture: TestFixture;
let prefix: string;

describe("resource ownership database invariants (Postgres)", () => {
  beforeEach(async () => {
    fixture = await createWorkspaceFixture();
    prefix = `ownership-${randomUUID()}`;
  });
  afterEach(async () => {
    // Test-created service profiles have no personal owner, including after
    // deleting their creator; identify them by this test's unique namespace.
    await db.agentProfile.deleteMany({ where: { profileKey: { startsWith: prefix } } });
    await fixture.cleanup();
  });
  afterAll(disconnectPrisma);

  it.each([
    { ownerType: "PERSONAL" as const, withOwner: false },
    { ownerType: "SERVICE" as const, withOwner: true },
    { ownerType: "UNASSIGNED" as const, withOwner: false },
  ])("rejects invalid profile owner shape: $ownerType / owner=$withOwner", async ({ ownerType, withOwner }) => {
    await expect(db.agentProfile.create({ data: {
      name: "Invalid profile",
      profileKey: prefix,
      ownerType,
      ownerId: withOwner ? fixture.user.id : null,
    } })).rejects.toThrow(/AgentProfile_owner_shape_check/);
    expect(await db.agentProfile.count({ where: { profileKey: prefix } })).toBe(0);
  });

  it.each([
    { ownerType: "PERSONAL" as const, withOwner: false },
    { ownerType: "SERVICE" as const, withOwner: true },
    { ownerType: "UNASSIGNED" as const, withOwner: true },
  ])("rejects invalid runtime owner shape: $ownerType / owner=$withOwner", async ({ ownerType, withOwner }) => {
    await expect(db.runtime.create({ data: {
      name: prefix,
      kind: "LOCAL_DAEMON",
      workspaceId: fixture.workspace.id,
      ownerType,
      ownerId: withOwner ? fixture.user.id : null,
    } })).rejects.toThrow(/Runtime_owner_shape_check/);
    expect(await db.runtime.count({ where: { name: prefix } })).toBe(0);
  });

  it("allows only one concurrent service identity per key without consuming personal namespaces", async () => {
    const personalProfiles = await Promise.all([fixture.user.id, fixture.secondUser.id].map((ownerId) =>
      db.agentProfile.create({ data: { profileKey: prefix, name: "Personal", ownerType: "PERSONAL", ownerId } }),
    ));
    const serviceAttempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
      db.agentProfile.create({ data: { profileKey: prefix, name: "Service", ownerType: "SERVICE" } }),
    ));
    expect(personalProfiles).toHaveLength(2);
    expect(serviceAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = serviceAttempts.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "P2002" });
    }
    expect(await db.agentProfile.count({ where: { profileKey: prefix } })).toBe(3);
  });

  it("preserves a service identity and runtime when their creator is deleted", async () => {
    const runtime = await db.runtime.create({ data: {
      name: prefix, kind: "LOCAL_DAEMON", workspaceId: fixture.workspace.id,
      ownerType: "SERVICE", createdById: fixture.user.id,
    } });
    const profile = await db.agentProfile.create({ data: {
      profileKey: prefix, name: "Service", ownerType: "SERVICE",
      createdById: fixture.user.id, runtimeId: runtime.id,
    } });
    await db.user.delete({ where: { id: fixture.user.id } });
    expect(await db.agentProfile.findUniqueOrThrow({ where: { id: profile.id } })).toMatchObject({
      ownerType: "SERVICE", ownerId: null, createdById: null, runtimeId: runtime.id,
    });
    expect(await db.runtime.findUniqueOrThrow({ where: { id: runtime.id } })).toMatchObject({
      ownerType: "SERVICE", ownerId: null, createdById: null,
    });
  });

  it("restricts personal profile owner deletion until ownership transfers", async () => {
    const profile = await db.agentProfile.create({ data: {
      profileKey: prefix, name: "Personal", ownerType: "PERSONAL",
      ownerId: fixture.user.id, createdById: fixture.user.id,
    } });
    await expect(db.user.delete({ where: { id: fixture.user.id } })).rejects.toMatchObject({ code: "P2003" });
    await db.agentProfile.update({ where: { id: profile.id }, data: { ownerId: fixture.secondUser.id } });
    await db.user.delete({ where: { id: fixture.user.id } });
    expect(await db.agentProfile.findUniqueOrThrow({ where: { id: profile.id } })).toMatchObject({
      ownerType: "PERSONAL", ownerId: fixture.secondUser.id, createdById: null,
    });
  });

  it("restricts personal runtime owner deletion until conversion to service ownership", async () => {
    const runtime = await db.runtime.create({ data: {
      name: prefix, kind: "LOCAL_DAEMON", workspaceId: fixture.workspace.id,
      ownerType: "PERSONAL", ownerId: fixture.user.id, createdById: fixture.user.id,
    } });
    await expect(db.user.delete({ where: { id: fixture.user.id } })).rejects.toMatchObject({ code: "P2003" });
    await db.runtime.update({ where: { id: runtime.id }, data: { ownerType: "SERVICE", ownerId: null } });
    await db.user.delete({ where: { id: fixture.user.id } });
    expect(await db.runtime.findUniqueOrThrow({ where: { id: runtime.id } })).toMatchObject({
      ownerType: "SERVICE", ownerId: null, createdById: null,
    });
  });

  it("preserves unassigned runtime classification until explicit adoption", async () => {
    const runtime = await db.runtime.create({ data: {
      name: prefix, kind: "LOCAL_DAEMON", workspaceId: fixture.workspace.id,
    } });
    expect(runtime).toMatchObject({ ownerType: "UNASSIGNED", ownerId: null, createdById: null });
    await db.runtime.update({ where: { id: runtime.id }, data: {
      ownerType: "PERSONAL", ownerId: fixture.secondUser.id,
    } });
    expect(await db.runtime.findUniqueOrThrow({ where: { id: runtime.id } })).toMatchObject({
      ownerType: "PERSONAL", ownerId: fixture.secondUser.id, createdById: null,
    });
  });
});
