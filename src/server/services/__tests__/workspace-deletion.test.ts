import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeKind } from "@prisma/client";
import { workspaceRouter } from "@/server/routers/workspace";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { deleteWorkspacePreservingRuntimes } from "@/server/services/workspace-deletion";

const db = getPrisma();
let fixture: TestFixture;
let other: TestFixture;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(applicationName: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT "wait_event_type" = 'Lock' AS waiting
      FROM pg_stat_activity WHERE "application_name" = ${applicationName}
    `;
    if (rows.some((row) => row.waiting)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected database lock wait for ${applicationName}`);
}

function removeWorkspace() {
  return db.$transaction((tx) =>
    deleteWorkspacePreservingRuntimes(tx, fixture.workspace.id, fixture.workspace.name),
  );
}

describe("workspace deletion runtime safety (Postgres)", () => {
  beforeEach(async () => {
    fixture = await createWorkspaceFixture();
    other = await createWorkspaceFixture();
  });
  afterEach(async () => {
    // These fixtures intentionally place another user's runtime in this
    // workspace; remove that test resource before deleting its owner.
    await db.runtime.deleteMany({ where: { workspaceId: fixture.workspace.id } });
    await other.cleanup();
    await fixture.cleanup();
  });
  afterAll(disconnectPrisma);

  it.each([
    { label: "personal", instanceShared: false, archivedAt: null },
    { label: "instance-shared", instanceShared: true, archivedAt: null },
    { label: "archived", instanceShared: false, archivedAt: new Date() },
  ])(
    "preserves an unbound $label runtime and the workspace",
    async ({ instanceShared, archivedAt }) => {
      const runtime = await db.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: other.user.id,
          ownerType: "PERSONAL",
          name: "Preserved host",
          kind: RuntimeKind.REMOTE_HTTP,
          instanceShared,
          archivedAt,
        },
      });
      const caller = workspaceRouter.createCaller(await buildContext(fixture));
      await expect(caller.delete({ confirmName: fixture.workspace.name })).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("Archive the workspace instead"),
      });
      expect(await db.runtime.findUnique({ where: { id: runtime.id } })).not.toBeNull();
      expect(await db.workspace.findUnique({ where: { id: fixture.workspace.id } })).not.toBeNull();
    },
  );

  it("preserves a legacy ownerless disabled host", async () => {
    const runtime = await db.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Legacy host",
        kind: RuntimeKind.LOCAL_DAEMON,
        disabledAt: new Date(),
      },
    });
    await expect(removeWorkspace()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.runtime.findUnique({ where: { id: runtime.id } })).not.toBeNull();
  });

  it("preserves cross-workspace agents and unbound global profile references", async () => {
    const runtime = await db.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Shared host",
        kind: RuntimeKind.REMOTE_HTTP,
      },
    });
    const profile = await db.agentProfile.create({
      data: {
        ownerId: other.user.id,
        ownerType: "PERSONAL",
        profileKey: "global",
        name: "Global profile",
        runtimeId: runtime.id,
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: other.workspace.id,
        profileKey: "remote",
        name: "Remote agent",
        runtimeId: runtime.id,
      },
    });
    await expect(removeWorkspace()).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.agentProfile.findUniqueOrThrow({ where: { id: profile.id } })).runtimeId).toBe(
      runtime.id,
    );
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).runtimeId).toBe(
      runtime.id,
    );
  });

  it("allows workspace archival while preserving its runtime", async () => {
    const runtime = await db.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Retained host",
        kind: RuntimeKind.LOCAL_DAEMON,
      },
    });
    const caller = workspaceRouter.createCaller(await buildContext(fixture));
    expect((await caller.archive()).deletedAt).not.toBeNull();
    expect(await db.runtime.findUnique({ where: { id: runtime.id } })).not.toBeNull();
  });

  it("allows deletion without registered runtimes, regardless of other workspaces", async () => {
    const runtime = await db.runtime.create({
      data: { workspaceId: other.workspace.id, name: "Other host", kind: RuntimeKind.LOCAL_DAEMON },
    });
    expect((await removeWorkspace()).id).toBe(fixture.workspace.id);
    expect(await db.workspace.findUnique({ where: { id: fixture.workspace.id } })).toBeNull();
    expect(await db.runtime.findUnique({ where: { id: runtime.id } })).not.toBeNull();
  });

  it("validates the confirmation name under the deletion lock", async () => {
    await expect(
      db.$transaction((tx) =>
        deleteWorkspacePreservingRuntimes(tx, fixture.workspace.id, "wrong name"),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.workspace.findUnique({ where: { id: fixture.workspace.id } })).not.toBeNull();
  });

  it("reserves the workspace slug until guarded cleanup has finished", async () => {
    let cleanupFinished = false;
    await db.$transaction((tx) =>
      deleteWorkspacePreservingRuntimes(tx, fixture.workspace.id, fixture.workspace.name, async () => {
        expect(await db.workspace.findUnique({ where: { id: fixture.workspace.id } })).not.toBeNull();
        await expect(db.workspace.update({
          where: { id: other.workspace.id },
          data: { slug: fixture.workspace.slug },
        })).rejects.toMatchObject({ code: "P2002" });
        cleanupFinished = true;
      }),
    );
    expect(cleanupFinished).toBe(true);
    await expect(db.workspace.update({
      where: { id: other.workspace.id },
      data: { slug: fixture.workspace.slug },
    })).resolves.toMatchObject({ slug: fixture.workspace.slug });
  });

  it("observes a concurrent runtime registration before deleting", async () => {
    const inserted = deferred();
    const releaseInsert = deferred();
    const applicationName = `delete-${fixture.workspace.id}`;
    const creation = db.$transaction(
      async (tx) => {
        const runtime = await tx.runtime.create({
          data: {
            workspaceId: fixture.workspace.id,
            name: "Concurrent host",
            kind: RuntimeKind.LOCAL_DAEMON,
          },
        });
        inserted.resolve();
        await releaseInsert.promise;
        return runtime;
      },
      { timeout: 15_000 },
    );
    await inserted.promise;
    const deletion = db
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('application_name', ${applicationName}, true)`;
          return deleteWorkspacePreservingRuntimes(
            tx,
            fixture.workspace.id,
            fixture.workspace.name,
          );
        },
        { timeout: 15_000 },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await waitForDatabaseLock(applicationName);
    } finally {
      releaseInsert.resolve();
    }
    const runtime = await creation;
    expect(await deletion).toMatchObject({ code: "CONFLICT" });
    expect(await db.runtime.findUnique({ where: { id: runtime.id } })).not.toBeNull();
  });

  it("rejects runtime registration racing after the guarded deletion", async () => {
    const deleted = deferred();
    const releaseDelete = deferred();
    const applicationName = `create-${fixture.workspace.id}`;
    const deletion = db.$transaction(
      async (tx) => {
        await deleteWorkspacePreservingRuntimes(tx, fixture.workspace.id, fixture.workspace.name);
        deleted.resolve();
        await releaseDelete.promise;
      },
      { timeout: 15_000 },
    );
    await deleted.promise;
    const creation = db
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('application_name', ${applicationName}, true)`;
          return tx.runtime.create({
            data: {
              workspaceId: fixture.workspace.id,
              name: "Too late",
              kind: RuntimeKind.LOCAL_DAEMON,
            },
          });
        },
        { timeout: 15_000 },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await waitForDatabaseLock(applicationName);
    } finally {
      releaseDelete.resolve();
    }
    await deletion;
    expect(await creation).toMatchObject({ code: "P2003" });
    expect(await db.runtime.count({ where: { workspaceId: fixture.workspace.id } })).toBe(0);
  });
});
