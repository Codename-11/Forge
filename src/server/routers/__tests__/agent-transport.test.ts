import { describe, it, expect, afterAll, afterEach } from "vitest";
import { RuntimeKind } from "@prisma/client";
import { agentRouter } from "@/server/routers/agent";
import {
  createWorkspaceFixture,
  buildContext,
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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "AGT" });
  fixtures.push(fixture);
  const caller = agentRouter.createCaller(await buildContext(fixture));
  return { caller, fixture };
}

describe("agent.previewTransport", () => {
  it("a HERMES agent without a bound Sessions runtime is not interactive-ready", async () => {
    const previousAllowUnauth = process.env.HERMES_GATEWAY_ALLOW_UNAUTH;
    process.env.HERMES_GATEWAY_ALLOW_UNAUTH = "1";
    const { caller } = await setup();
    try {
      const p = await caller.previewTransport({ provider: "HERMES" });
      expect(p.mode).toBe("none");
      expect(p.ready).toBe(false);
      expect(p.hint).toContain("Sessions");
    } finally {
      if (previousAllowUnauth === undefined) delete process.env.HERMES_GATEWAY_ALLOW_UNAUTH;
      else process.env.HERMES_GATEWAY_ALLOW_UNAUTH = previousAllowUnauth;
    }
  });

  it("a CODEX agent with no runtime + no model previews as not-ready none", async () => {
    const { caller } = await setup();
    const p = await caller.previewTransport({ provider: "CODEX" });
    expect(p.ready).toBe(false);
    expect(p.mode).toBe("none");
    expect(p.hint.length).toBeGreaterThan(0);
  });

  it("a webhook makes a custom agent preview as dispatch-ready", async () => {
    const { caller } = await setup();
    const p = await caller.previewTransport({
      provider: "CUSTOM",
      webhookUrl: "https://bot.example/hook",
    });
    expect(p.mode).toBe("dispatch");
    expect(p.ready).toBe(true);
  });
});

describe("agent.verifyConnection", () => {
  it("resolves readiness for an existing agent (no probe when not runs)", async () => {
    const { caller } = await setup();
    const agent = await caller.create({
      name: "Verify Bot",
      profileKey: "verifybot",
      provider: "CODEX",
    });
    const r = await caller.verifyConnection({ id: agent.id });
    expect(["runs", "completions", "dispatch", "none"]).toContain(r.mode);
    // CODEX with no runtime/model → none, no probe attempted.
    expect(r.probe.attempted).toBe(false);
  });
});

describe("agent.byProfileKey transport + availability", () => {
  it("returns resolved transport + availability for the detail page", async () => {
    const { caller } = await setup();
    await caller.create({ name: "Detail Bot", profileKey: "detailbot", provider: "CODEX" });
    const agent = await caller.byProfileKey({ profileKey: "detailbot" });
    expect(agent).not.toBeNull();
    expect(agent!.transport).toBeDefined();
    expect(["runs", "completions", "dispatch", "none"]).toContain(agent!.transport.mode);
    // CODEX, no runtime, no heartbeat → on-demand (or none if no path) — not a
    // heartbeat agent.
    expect(["on-demand", "heartbeat", "session"]).toContain(agent!.availability);
  });
});

describe("agent runtime profile isolation", () => {
  it("prevents two active agents from sharing a profile-scoped Hermes runtime", async () => {
    const { caller, fixture } = await setup();
    const runtime = await getPrisma().runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Hermes Victor",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: "http://127.0.0.1:8649/v1",
      },
    });
    await caller.create({
      name: "Victor",
      profileKey: "victor",
      provider: "HERMES",
      runtimeId: runtime.id,
    });

    await expect(
      caller.create({
        name: "Mizu",
        profileKey: "mizu",
        provider: "HERMES",
        runtimeId: runtime.id,
      }),
    ).rejects.toThrow(/profile-scoped/);
  });
});
