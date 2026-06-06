import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runtimeRouter } from "@/server/routers/runtime";
import { getRunsConnectorForAgent } from "@/server/services/dispatch/registry";
import type { RunEvent } from "@/server/services/dispatch/types";
import { createWorkspaceFixture, buildContext, type TestFixture } from "./helpers";

/**
 * API/MCP contract for the runtime + dispatch surface agents drive:
 *   - Runtime.config validation (codex sandbox/approval) round-trips.
 *   - The enable/disable kill-switch + the disabled sentinel connector.
 *   - The E2E mock-runs connector's streaming + approval contract.
 * These hit the real router/connector code against the test Postgres — no
 * browser, fully deterministic.
 */
describe("runtime dispatch contract", () => {
  let fixture: TestFixture;
  let caller: ReturnType<typeof runtimeRouter.createCaller>;

  beforeEach(async () => {
    fixture = await createWorkspaceFixture({ keyPrefix: "RTC" });
    caller = runtimeRouter.createCaller(await buildContext(fixture));
  });
  afterEach(async () => {
    delete process.env.FORGE_E2E;
    await fixture.cleanup();
  });

  const codexInput = {
    adapterKey: "codex-app-server",
    name: "Codex",
    endpoint: "ws://127.0.0.1:4505",
  };

  it("validates + persists codex config and rejects unknown enum values", async () => {
    const rt = await caller.create({
      ...codexInput,
      config: { sandboxMode: "workspace-write", approvalPolicy: "on-request", workspaceRoot: "/work" },
    });
    expect(rt.config).toMatchObject({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      workspaceRoot: "/work",
    });

    await expect(
      caller.create({ ...codexInput, name: "Bad", config: { sandboxMode: "yolo" } }),
    ).rejects.toThrow();
  });

  it("verifyConnection runs a handshake-only probe and persists sanitized diagnostics", async () => {
    const rt = await caller.create({ ...codexInput, endpoint: "ws://127.0.0.1:1" });

    const verified = await caller.verifyConnection({ id: rt.id });

    expect(verified.probe.attempted).toBe(true);
    expect(verified.probe.reachable).toBe(false);
    expect(verified.probe.detail).toMatch(/ECONNREFUSED|refused|connect/i);
    expect(verified.health.kind).toBe("probe_failed");

    const fromDetail = await caller.byId({ id: rt.id });
    expect(fromDetail.lastProbeAt).not.toBeNull();
    expect(fromDetail.lastProbeAttempted).toBe(true);
    expect(fromDetail.lastProbeReachable).toBe(false);
    expect(fromDetail.lastProbeDetail).toBe(verified.probe.detail);
    expect(fromDetail.health.kind).toBe("probe_failed");
  });

  it("setEnabled flips disabledAt, and a disabled runtime resolves to the refusing sentinel", async () => {
    const rt = await caller.create(codexInput);
    const disabled = await caller.setEnabled({ id: rt.id, enabled: false });
    expect(disabled.disabledAt).toBeTruthy();

    const connector = getRunsConnectorForAgent({
      provider: "CODEX",
      runtime: {
        adapterKey: "codex-app-server",
        endpoint: rt.endpoint,
        secret: null,
        config: rt.config,
        disabledAt: disabled.disabledAt,
        name: rt.name,
      },
    });
    expect(connector?.kind).toBe("disabled");
    await expect(connector!.startRun({ message: "hi" })).rejects.toThrow(/disabled/i);

    // Re-enabling clears it and the codex connector resolves again.
    const enabled = await caller.setEnabled({ id: rt.id, enabled: true });
    expect(enabled.disabledAt).toBeNull();
    const live = getRunsConnectorForAgent({
      provider: "CODEX",
      runtime: { adapterKey: "codex-app-server", endpoint: rt.endpoint, secret: null, config: rt.config, disabledAt: null, name: rt.name },
    });
    expect(live?.kind).toBe("codex-app-server");
  });

  it("mock-runs connector streams a scripted reply (FORGE_E2E gated)", async () => {
    process.env.FORGE_E2E = "1";
    const connector = getRunsConnectorForAgent({
      provider: "CUSTOM",
      runtime: { adapterKey: "mock-runs", endpoint: "mock://e2e", secret: null, config: null, disabledAt: null, name: "Mock" },
    });
    expect(connector?.kind).toBe("mock-runs");

    const { externalRunId } = await connector!.startRun({ message: "ping" });
    const events: RunEvent[] = [];
    await connector!.subscribe(externalRunId, (e) => events.push(e));

    expect(events.some((e) => e.type === "content_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("mock-runs surfaces an approval and completes once approved", async () => {
    process.env.FORGE_E2E = "1";
    const connector = getRunsConnectorForAgent({
      provider: "CUSTOM",
      runtime: { adapterKey: "mock-runs", endpoint: "mock://e2e", secret: null, config: null, disabledAt: null, name: "Mock" },
    });
    const { externalRunId } = await connector!.startRun({ message: "please approve this" });
    const events: RunEvent[] = [];
    await connector!.subscribe(externalRunId, (e) => {
      events.push(e);
      if (e.type === "approval_required") void connector!.approve?.(externalRunId, "once");
    });

    expect(events.some((e) => e.type === "approval_required")).toBe(true);
    expect(events.some((e) => e.type === "approval_resolved")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("blocks runtime creation for a non-member context (tenant isolation)", async () => {
    // A caller scoped to another workspace must not create runtimes here.
    const other = await createWorkspaceFixture({ keyPrefix: "OTH" });
    const otherCaller = runtimeRouter.createCaller(await buildContext(other));
    const rt = await otherCaller.create(codexInput);
    // The runtime lands in the OTHER workspace, never this fixture's.
    const here = await caller.list();
    expect(here.find((r) => r.id === rt.id)).toBeUndefined();
    await other.cleanup();
  });
});
