import { describe, it, expect, afterAll, afterEach } from "vitest";
import { agentRouter } from "@/server/routers/agent";
import {
  createWorkspaceFixture,
  buildContext,
  disconnectPrisma,
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
  return { caller };
}

describe("agent.previewTransport", () => {
  it("a HERMES agent (no runtime) previews as runs (env gateway fallback)", async () => {
    const { caller } = await setup();
    const p = await caller.previewTransport({ provider: "HERMES" });
    expect(p.mode).toBe("runs");
    expect(p.ready).toBe(true);
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
