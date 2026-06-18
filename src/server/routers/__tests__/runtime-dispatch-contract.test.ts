import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RuntimeKind } from "@prisma/client";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
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

  async function startCodexSelfTestServer(
    complete: "pass" | "revoked-token",
  ): Promise<{ endpoint: string; close: () => Promise<void> }> {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          method?: string;
        };
        if (msg.method === "initialize" && msg.id !== undefined) {
          socket.send(JSON.stringify({ id: msg.id, result: {} }));
          return;
        }
        if (msg.method === "thread/start" && msg.id !== undefined) {
          socket.send(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-self-test" } } }));
          return;
        }
        if (msg.method === "turn/start" && msg.id !== undefined) {
          socket.send(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-self-test" } } }));
          setTimeout(() => {
            if (complete === "pass") {
              socket.send(
                JSON.stringify({
                  method: "item/agentMessage/delta",
                  params: { delta: "FORGE_RUNTIME_SELF_TEST_OK" },
                }),
              );
              socket.send(
                JSON.stringify({
                  method: "turn/completed",
                  params: { turn: { status: "completed" } },
                }),
              );
              return;
            }
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  turn: {
                    status: "failed",
                    error: { message: "OpenAI refresh token revoked" },
                  },
                },
              }),
            );
          }, 0);
        }
      });
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;
    return {
      endpoint: `ws://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
    };
  }

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

  it("validates + persists Hermes runtime tool-surface config", async () => {
    const rt = await caller.create({
      adapterKey: "hermes",
      name: "Hermes gateway",
      endpoint: "http://127.0.0.1:8642/v1",
      config: {
        localWorkspaceTools: true,
        toolCapabilities: ["terminal", "filesystem", "git"],
        workspaceRoot: "  /home/bailey/forge  ",
        modeToolPolicyEnforced: true,
        modeToolProfiles: {
          EXECUTE: ["terminal", "filesystem", "git"],
          REVIEW: ["filesystem", "git"],
          RESEARCH: [],
          DISCUSS: [],
        },
      },
    });

    expect(rt.config).toMatchObject({
      localWorkspaceTools: true,
      toolCapabilities: ["terminal", "filesystem", "git"],
      workspaceRoot: "/home/bailey/forge",
      modeToolPolicyEnforced: true,
      modeToolProfiles: {
        EXECUTE: ["terminal", "filesystem", "git"],
        REVIEW: ["filesystem", "git"],
        RESEARCH: [],
        DISCUSS: [],
      },
    });

    await expect(
      caller.update({
        id: rt.id,
        config: { toolCapabilities: ["terminal"], unknown: true },
      }),
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

  it("runSelfTest persists unsupported state for runtimes without a self-test adapter", async () => {
    const rt = await caller.register({
      name: "Local daemon",
      kind: RuntimeKind.LOCAL_DAEMON,
      endpoint: "",
      providersAvailable: ["CODEX"],
    });

    const res = await caller.runSelfTest({ id: rt.id });

    expect(res.result.attempted).toBe(false);
    expect(res.result.status).toBe("UNSUPPORTED");
    expect(res.selfTest.label).toBe("self-test unsupported");

    const fromDetail = await caller.byId({ id: rt.id });
    expect(fromDetail.lastSelfTestStatus).toBe("UNSUPPORTED");
    expect(fromDetail.selfTest.detail).toMatch(/does not support/i);
  });

  it("runSelfTest starts a real Codex turn and persists a passing result", async () => {
    const server = await startCodexSelfTestServer("pass");
    try {
      const rt = await caller.create({ ...codexInput, endpoint: server.endpoint });

      const res = await caller.runSelfTest({ id: rt.id });

      expect(res.result.attempted).toBe(true);
      expect(res.result.status).toBe("PASSED");
      expect(res.result.detail).toContain("FORGE_RUNTIME_SELF_TEST_OK");
      expect(res.selfTest.label).toBe("self-test passed");

      const fromDetail = await caller.byId({ id: rt.id });
      expect(fromDetail.lastSelfTestAt).not.toBeNull();
      expect(fromDetail.lastSelfTestStatus).toBe("PASSED");
      expect(fromDetail.lastSelfTestDurationMs).toBeGreaterThanOrEqual(0);
      expect(fromDetail.selfTest.status).toBe("PASSED");
    } finally {
      await server.close();
    }
  });

  it("runSelfTest turns Codex revoked-token failures into actionable diagnostics", async () => {
    const server = await startCodexSelfTestServer("revoked-token");
    try {
      const rt = await caller.create({
        ...codexInput,
        endpoint: server.endpoint,
        secret: "super-secret-token",
      });

      const res = await caller.runSelfTest({ id: rt.id });

      expect(res.result.attempted).toBe(true);
      expect(res.result.status).toBe("FAILED");
      expect(res.result.detail).toMatch(/Authentication failed/i);
      expect(res.result.detail).toMatch(/inside the runtime\/provider/i);
      expect(res.result.detail).toMatch(/Codex CLI\/app-server auth/i);
      expect(res.result.detail).toMatch(/refresh token revoked/i);
      expect(res.result.detail).not.toContain("super-secret-token");

      const fromDetail = await caller.byId({ id: rt.id });
      expect(fromDetail.lastSelfTestStatus).toBe("FAILED");
      expect(fromDetail.selfTest.label).toBe("self-test failed");
      expect(fromDetail.selfTest.detail).toBe(res.result.detail);
    } finally {
      await server.close();
    }
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
