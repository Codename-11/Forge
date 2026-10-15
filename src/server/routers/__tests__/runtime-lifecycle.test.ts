import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeRouter } from "@/server/routers/runtime";
import { agentRouter } from "@/server/routers/agent";
import { transferRuntime } from "@/server/services/runtime-lifecycle";
import {
  buildContext,
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const db = getPrisma();
let source: TestFixture;
let target: TestFixture;
async function caller(asUserId?: string) {
  return runtimeRouter.createCaller(await buildContext(source, { asUserId }));
}
async function host(extra: Record<string, unknown> = {}) {
  return db.runtime.create({
    data: {
      workspaceId: source.workspace.id,
      ownerId: source.user.id,
      ownerType: "PERSONAL",
      createdById: source.user.id,
      name: "Lifecycle fixture",
      kind: "REMOTE_HTTP",
      archivedAt: new Date(),
      disabledAt: new Date(),
      ...extra,
    },
  });
}
async function expected(id: string) {
  const r = (await (await caller()).lifecycleImpact({ id })).runtime;
  return {
    id,
    expectedWorkspaceId: r.workspaceId,
    expectedOwnerType: r.ownerType,
    expectedOwnerId: r.ownerId,
    expectedUpdatedAt: r.updatedAt,
    confirmName: r.name,
  };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<
      Array<{ waiting: boolean }>
    >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS waiting`;
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected runtime row-lock wait");
}

describe("runtime ownership lifecycle (real Postgres)", () => {
  beforeEach(async () => {
    source = await createWorkspaceFixture();
    target = await createWorkspaceFixture();
    await db.user.update({
      where: { id: source.user.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
  });
  afterEach(async () => {
    await db.instanceAuditLog.deleteMany({ where: { actorId: source.user.id } });
    await target.cleanup();
    await source.cleanup();
  });
  afterAll(disconnectPrisma);

  it("requires instance administration even for the personal owner", async () => {
    const r = await host();
    await db.user.update({ where: { id: source.user.id }, data: { instanceRole: "MEMBER" } });
    await expect((await caller()).lifecycleImpact({ id: r.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("prepares globally with exact confirmation without claiming external host termination", async () => {
    const r = await host({ archivedAt: null, disabledAt: null });
    const api = await caller();
    const review = await expected(r.id);
    await expect(api.lifecyclePrepare({ ...review, confirmName: "wrong" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const result = await api.lifecyclePrepare(review);
    expect(result.runtime.archivedAt).not.toBeNull();
    expect(result.runtime.disabledAt).not.toBeNull();
    expect(result.externalHostStopped).toBe(false);
    expect(
      await db.instanceAuditLog.count({
        where: { action: "runtime.lifecycle.prepare", actorId: source.user.id },
      }),
    ).toBe(1);
  });

  it("moves an unused registration preserving ID and creator, allowing empty adapter config", async () => {
    const r = await host({ config: {} });
    const result = await (
      await caller()
    ).lifecycleTransfer({
      ...(await expected(r.id)),
      targetWorkspaceId: target.workspace.id,
      ownerType: "SERVICE",
      ownerId: null,
    });
    expect(result).toMatchObject({
      id: r.id,
      workspaceId: target.workspace.id,
      ownerType: "SERVICE",
      ownerId: null,
    });
    expect((await db.runtime.findUniqueOrThrow({ where: { id: r.id } })).createdById).toBe(
      source.user.id,
    );
    expect(
      await db.instanceAuditLog.count({
        where: { actorId: source.user.id, action: "runtime.lifecycle.transfer" },
      }),
    ).toBe(1);
  });

  it("validates active destination and personal owner membership", async () => {
    const r = await host();
    const api = await caller();
    const review = await expected(r.id);
    await expect(
      api.lifecycleTransfer({
        ...review,
        targetWorkspaceId: target.workspace.id,
        ownerType: "PERSONAL",
        ownerId: source.user.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      api.lifecycleTransfer({
        ...review,
        targetWorkspaceId: target.workspace.id,
        ownerType: "SERVICE",
        ownerId: target.user.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await db.workspace.update({
      where: { id: target.workspace.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      api.lifecycleTransfer({
        ...review,
        targetWorkspaceId: target.workspace.id,
        ownerType: "SERVICE",
        ownerId: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a stale reviewed snapshot", async () => {
    const r = await host();
    const review = await expected(r.id);
    await db.runtime.update({ where: { id: r.id }, data: { name: "Changed" } });
    await expect((await caller()).lifecycleRemove(review)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("invalidates a removal preview after child repository configuration changes", async () => {
    const r = await host(); const api = await caller(); const review = await expected(r.id);
    await api.setRepo({ runtimeId: r.id, url: "https://example.com/repo", path: "repo" });
    await expect(api.lifecycleRemove(review)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.runtimeRepo.count({ where: { runtimeId: r.id } })).toBe(1);
  });

  it("blocks waiting runs and active delivery, retaining terminal histories on ownership change", async () => {
    const r = await host(); const api = await caller();
    const agent = await db.agent.create({ data: { workspaceId: source.workspace.id, profileKey: "history", name: "History agent" } });
    const connection = await db.agentConnection.create({ data: { workspaceId: source.workspace.id, agentId: agent.id,
      runtimeId: r.id, kind: "MANAGED_RUNTIME", livenessModel: "HEARTBEAT", status: "DISCONNECTED", disconnectedAt: new Date() } });
    const issue = await createIssue(source);
    const run = await db.agentRun.create({ data: { workspaceId: source.workspace.id, issueId: issue.id, agentId: agent.id,
      connectionId: connection.id, status: "WAITING" } });
    const delivery = await db.workSession.create({ data: { workspaceId: source.workspace.id, issueId: issue.id,
      ownerAgentId: agent.id, ownerConnectionId: connection.id, source: "FORGE_AGENT", repoFullName: "fixture/repo", branch: "fixture" } });
    const impact = await api.lifecycleImpact({ id: r.id });
    expect(impact.transferBlockers.join(" ")).toContain("nonterminal run");
    expect(impact.transferBlockers.join(" ")).toContain("active delivery");
    await db.agentRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date() } });
    await expect(api.lifecycleTransfer({ ...await expected(r.id), targetWorkspaceId: source.workspace.id, ownerType: "SERVICE", ownerId: null })).rejects.toMatchObject({ code: "CONFLICT" });
    await db.workSession.update({ where: { id: delivery.id }, data: { status: "ABANDONED", endedAt: new Date() } });
    await api.lifecycleTransfer({ ...await expected(r.id), targetWorkspaceId: source.workspace.id, ownerType: "SERVICE", ownerId: null });
    expect(await db.agentRun.findUnique({ where: { id: run.id } })).not.toBeNull();
    expect(await db.workSession.findUnique({ where: { id: delivery.id } })).not.toBeNull();
    await expect(api.lifecycleRemove(await expected(r.id))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("blocks references and active diagnostics without exposing secrets", async () => {
    const r = await host({ secret: "private-value" });
    await db.agentProfile.create({
      data: {
        ownerId: source.user.id,
        name: "Unbound profile",
        profileKey: "unbound",
        runtimeId: r.id,
      },
    });
    await db.runtimeDiagnosticAttempt.create({
      data: {
        runtimeId: r.id,
        workspaceId: source.workspace.id,
        requestId: `pending-${r.id}`,
        kind: "PROBE",
        trigger: "MANUAL_RUNTIME",
      },
    });
    const impact = await (await caller()).lifecycleImpact({ id: r.id });
    expect(impact.counts.profiles).toBe(1);
    expect(impact.counts.diagnostics).toBe(1);
    expect(impact.transferBlockers.join(" ")).toContain("unfinished");
    expect(JSON.stringify(impact)).not.toContain("private-value");
    await expect((await caller()).lifecycleRemove(await expected(r.id))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("retains terminal diagnostics on ownership-only transfer but prevents cross-home relocation or removal", async () => {
    const r = await host();
    const api = await caller();
    const record = await db.runtimeDiagnosticAttempt.create({
      data: {
        runtimeId: r.id,
        workspaceId: source.workspace.id,
        requestId: `done-${r.id}`,
        kind: "PROBE",
        trigger: "MANUAL_RUNTIME",
        completedAt: new Date(),
      },
    });
    await expect(
      api.lifecycleTransfer({
        ...(await expected(r.id)),
        targetWorkspaceId: target.workspace.id,
        ownerType: "SERVICE",
        ownerId: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await api.lifecycleTransfer({
      ...(await expected(r.id)),
      targetWorkspaceId: source.workspace.id,
      ownerType: "SERVICE",
      ownerId: null,
    });
    expect(
      await db.runtimeDiagnosticAttempt.findUnique({ where: { id: record.id } }),
    ).not.toBeNull();
    await expect(api.lifecycleRemove(await expected(r.id))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("blocks credentials and repository configuration during transfer", async () => {
    const r = await host();
    await db.runtimeSecret.create({
      data: {
        runtimeId: r.id,
        workspaceId: source.workspace.id,
        key: "TOKEN",
        valueEnc: "not-disclosed",
      },
    });
    await db.runtimeRepo.create({
      data: {
        runtimeId: r.id,
        workspaceId: source.workspace.id,
        url: "https://example.com/repo",
        path: "repo",
      },
    });
    const impact = await (
      await caller()
    ).lifecycleImpact({ id: r.id, targetWorkspaceId: target.workspace.id });
    expect(impact.counts.secrets).toBe(1);
    expect(impact.counts.repos).toBe(1);
    await expect(
      (await caller()).lifecycleTransfer({
        ...(await expected(r.id)),
        targetWorkspaceId: target.workspace.id,
        ownerType: "SERVICE",
        ownerId: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("removes unused archived configuration and audits the exact resource without host claims", async () => {
    const r = await host();
    const result = await (await caller()).lifecycleRemove(await expected(r.id));
    expect(result).toEqual({ removed: true, id: r.id, externalHostStopped: false });
    expect(await db.runtime.findUnique({ where: { id: r.id } })).toBeNull();
    expect(
      await db.instanceAuditLog.count({
        where: { actorId: source.user.id, action: "runtime.lifecycle.remove" },
      }),
    ).toBe(1);
  });

  it("does not let workspace members mutate a shared runtime through registration or archive", async () => {
    const r = await host({ instanceShared: true, archivedAt: null, disabledAt: null });
    const member = await caller(source.secondUser.id);
    await expect(
      member.register({
        name: r.name,
        kind: r.kind,
        endpoint: "https://example.com",
        providersAvailable: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.archive({ id: r.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.setEnabled({ id: r.id, enabled: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("stamps personal registration ownership and never echoes a stored secret", async () => {
    const api = await caller();
    const r = await api.register({
      name: "Fresh personal",
      kind: "REMOTE_HTTP",
      providersAvailable: [],
    });
    expect(r).toMatchObject({
      ownerType: "PERSONAL",
      ownerId: source.user.id,
      createdById: source.user.id,
    });
    await db.runtime.update({ where: { id: r.id }, data: { secret: "do-not-echo" } });
    const updated = await api.register({ name: r.name, kind: r.kind, providersAvailable: [] });
    expect(updated).not.toHaveProperty("secret");
    expect(updated.hasSecret).toBe(true);
  });

  it.each(["SERVICE", "PERSONAL"] as const)("requires adoption before new legacy-router attachments (%s)", async (ownerType) => {
    const r = await host({ ownerType: "UNASSIGNED", ownerId: null, archivedAt: null, disabledAt: null });
    const agents = agentRouter.createCaller(await buildContext(source));
    const existing = await agents.create({ name: "Unattached", profileKey: "unattached" });
    await expect(agents.create({ name: "Blocked", profileKey: "blocked", runtimeId: r.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(agents.update({ id: existing.id, runtimeId: r.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const api = await caller();
    await api.lifecyclePrepare(await expected(r.id));
    await api.lifecycleTransfer({ ...await expected(r.id), targetWorkspaceId: source.workspace.id,
      ownerType, ownerId: ownerType === "PERSONAL" ? source.user.id : null });
    await api.unarchive({ id: r.id }); await api.setEnabled({ id: r.id, enabled: true });
    await expect(agents.create({ name: "Allowed", profileKey: "allowed", runtimeId: r.id })).resolves.toMatchObject({ runtimeId: r.id });
    await expect(agents.update({ id: existing.id, runtimeId: r.id })).resolves.toMatchObject({ runtimeId: r.id });
  });

  it("preserves existing unassigned-runtime bindings when editing unrelated agent metadata", async () => {
    const r = await host({ ownerType: "UNASSIGNED", ownerId: null, archivedAt: null, disabledAt: null });
    const agent = await db.agent.create({ data: { workspaceId: source.workspace.id, profileKey: "legacy", name: "Legacy", runtimeId: r.id } });
    const updated = await agentRouter.createCaller(await buildContext(source)).update({ id: agent.id, name: "Renamed" });
    expect(updated.runtimeId).toBe(r.id);
    expect((await db.runtime.findUniqueOrThrow({ where: { id: r.id } })).ownerType).toBe("UNASSIGNED");
  });

  it.each(["agent attachment", "metadata edit", "diagnostic request"])(
    "rechecks old-home authority after concurrent transfer: %s",
    async (operation) => {
      const r = await host();
      const review = await expected(r.id);
      const ready = signal();
      const release = signal();
      let holder = 0;
      const transfer = db.$transaction(
        async (tx) => {
          await transferRuntime(
            tx,
            {
              ...review,
              targetWorkspaceId: target.workspace.id,
              ownerType: "SERVICE",
              ownerId: null,
            },
            source.user.id,
          );
          holder = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]
            .pid;
          ready.resolve();
          await release.promise;
        },
        { timeout: 15_000 },
      );
      await ready.promise;
      const context = await buildContext(source);
      const mutation =
        operation === "agent attachment"
          ? agentRouter
              .createCaller(context)
              .create({ name: "Late binding", profileKey: "late", runtimeId: r.id })
          : operation === "metadata edit"
            ? runtimeRouter.createCaller(context).update({ id: r.id, name: "Late edit" })
            : runtimeRouter.createCaller(context).verifyConnection({ id: r.id });
      const outcome = mutation.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await waitForBlockedBy(holder);
      } finally {
        release.resolve();
      }
      await transfer;
      expect(await outcome).toMatchObject({
        code: operation === "agent attachment" ? "BAD_REQUEST" : "NOT_FOUND",
      });
      expect(await db.agent.count({ where: { runtimeId: r.id } })).toBe(0);
      expect(await db.runtimeDiagnosticAttempt.count({ where: { runtimeId: r.id } })).toBe(0);
    },
  );
});
