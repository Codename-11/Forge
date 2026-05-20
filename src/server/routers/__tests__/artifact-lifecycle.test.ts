import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ArtifactStatus, ArtifactType, Role } from "@prisma/client";
import { artifactRouter } from "@/server/routers/artifact";
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "ARL" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = artifactRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("artifactRouter — restore", () => {
  it("clears archivedAt and flips ARCHIVED status back to DRAFT", async () => {
    const { fixture, caller } = await setup();
    const created = await caller.create({ title: "Restore artifact", body: "x" });
    await caller.archive({ id: created.id });
    let row = await getPrisma().artifact.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.archivedAt).not.toBeNull();
    expect(row.status).toBe(ArtifactStatus.ARCHIVED);

    await caller.restore({ id: created.id });
    row = await getPrisma().artifact.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.archivedAt).toBeNull();
    expect(row.status).toBe(ArtifactStatus.DRAFT);

    const audit = await getPrisma().auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "artifact",
        entityId: created.id,
        action: "restore",
      },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects restore for an artifact in another workspace", async () => {
    const { caller: callerA } = await setup();
    const { caller: callerB } = await setup();
    const b = await callerB.create({ title: "Theirs", body: "y" });
    await callerB.archive({ id: b.id });
    await expect(callerA.restore({ id: b.id })).rejects.toThrow(/Artifact not found/);
  });

  it("is a no-op when the artifact is not archived", async () => {
    const { caller } = await setup();
    const created = await caller.create({ title: "Untouched", body: "z" });
    await expect(caller.restore({ id: created.id })).resolves.toEqual({ ok: true });
  });
});

describe("artifactRouter — duplicate", () => {
  it("clones an artifact into a new DRAFT with a 'Copy of' prefix", async () => {
    const { caller } = await setup();
    const prisma = getPrisma();
    const created = await caller.create({
      title: "Source spec",
      body: "## Heading\nbody content",
      type: ArtifactType.SPEC,
      summary: "Short summary",
    });
    const cloned = await caller.duplicate({ id: created.id });

    expect(cloned.id).not.toBe(created.id);
    const row = await prisma.artifact.findUniqueOrThrow({
      where: { id: cloned.id },
      include: { versions: true },
    });
    expect(row.title).toBe("Copy of Source spec");
    expect(row.body).toBe("## Heading\nbody content");
    expect(row.type).toBe(ArtifactType.SPEC);
    expect(row.status).toBe(ArtifactStatus.DRAFT);
    expect(row.summary).toBe("Short summary");
    expect(row.versions).toHaveLength(1);
    expect(row.versions[0].version).toBe(1);
    // Slug must be unique — auto-suffixed since "copy-of-source-spec"
    // is fresh, no collision needed here.
    expect(row.slug).toBe("copy-of-source-spec");
  });

  it("honors a custom newTitle when supplied", async () => {
    const { caller } = await setup();
    const created = await caller.create({ title: "Anything", body: "" });
    const cloned = await caller.duplicate({ id: created.id, newTitle: "Renamed clone" });
    const row = await getPrisma().artifact.findUniqueOrThrow({
      where: { id: cloned.id },
    });
    expect(row.title).toBe("Renamed clone");
  });
});

describe("artifactRouter — delete", () => {
  it("hard-deletes the artifact and its versions when confirm matches", async () => {
    const { caller } = await setup();
    const prisma = getPrisma();
    const created = await caller.create({ title: "Doomed", body: "v1" });
    // Bump to v2 so we verify the version sweep too.
    await caller.update({ id: created.id, body: "v2" });
    const versionsBefore = await prisma.artifactVersion.findMany({
      where: { artifactId: created.id },
    });
    expect(versionsBefore).toHaveLength(2);

    await caller.delete({ id: created.id, confirm: "Doomed" });

    const row = await prisma.artifact.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();
    const versionsAfter = await prisma.artifactVersion.findMany({
      where: { artifactId: created.id },
    });
    expect(versionsAfter).toHaveLength(0);
  });

  it("rejects delete when confirm does not match the title", async () => {
    const { caller } = await setup();
    const created = await caller.create({ title: "Exact", body: "" });
    await expect(
      caller.delete({ id: created.id, confirm: "wrong" }),
    ).rejects.toThrow(/Confirmation text/);
  });

  it("rejects delete by a non-admin member", async () => {
    const { fixture, caller } = await setup();
    const created = await caller.create({ title: "Owner-only", body: "" });
    const memberCtx = await buildContext(fixture, {
      asUserId: fixture.secondUser.id,
    });
    const memberCaller = artifactRouter.createCaller(memberCtx);
    await expect(
      memberCaller.delete({ id: created.id, confirm: "Owner-only" }),
    ).rejects.toThrow(/Admin role required/);
  });

  it("allows delete by an admin member", async () => {
    const { fixture, caller } = await setup();
    const created = await caller.create({ title: "Admin-allowed", body: "" });
    await getPrisma().membership.update({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
      data: { role: Role.ADMIN },
    });
    const adminCtx = await buildContext(fixture, {
      asUserId: fixture.secondUser.id,
    });
    const adminCaller = artifactRouter.createCaller(adminCtx);
    await adminCaller.delete({ id: created.id, confirm: "Admin-allowed" });
    const row = await getPrisma().artifact.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();
  });
});

describe("artifactRouter — list archived", () => {
  it("returns only archived rows when archivedOnly is true", async () => {
    const { caller } = await setup();
    const alive = await caller.create({ title: "Alive", body: "" });
    const dead = await caller.create({ title: "Dead", body: "" });
    await caller.archive({ id: dead.id });

    const active = await caller.list({});
    expect(active.items.find((r) => r.id === alive.id)).toBeTruthy();
    expect(active.items.find((r) => r.id === dead.id)).toBeUndefined();

    const archived = await caller.list({ archivedOnly: true });
    expect(archived.items.find((r) => r.id === dead.id)).toBeTruthy();
    expect(archived.items.find((r) => r.id === alive.id)).toBeUndefined();
  });
});
