import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveChatReadiness } from "@/server/services/chat-readiness";

/**
 * Readiness mirrors what /api/chat/stream does at send time. These tests pin
 * the steering behaviour that stops a pull/act CLI connection from looking
 * like a chat backend, and confirm Hermes only presents an env-fallback runs
 * connector when that fallback is explicitly configured.
 */
describe("resolveChatReadiness", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    // Start from a clean slate — no direct model keys configured.
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FORGE_AI_BASE_URL;
    delete process.env.FORGE_AI_API_KEY;
    delete process.env.HERMES_GATEWAY_TOKEN;
    delete process.env.HERMES_GATEWAY_ALLOW_UNAUTH;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("Hermes RUNS agent without runtime or env gateway is not ready", () => {
    const r = resolveChatReadiness({ provider: "HERMES", runEngine: "RUNS", runtime: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("no-runs-connector");
    expect(r.hint).toMatch(/HERMES_GATEWAY_TOKEN/);
  });

  it("Hermes RUNS agent is ready with an explicit env gateway fallback", () => {
    process.env.HERMES_GATEWAY_TOKEN = "test-token";
    const r = resolveChatReadiness({ provider: "HERMES", runEngine: "RUNS", runtime: null });
    expect(r.ready).toBe(true);
    expect(r.mode).toBe("runs");
    expect(r.reason).toBe("runs-connector");
    expect(r.transportLabel).toBe("Hermes env");
    expect(r.capabilities).toMatchObject({
      streaming: true,
      thinking: true,
      tools: true,
      approvals: true,
      stop: true,
      runs: true,
      dispatch: false,
      vision: false,
      memory: true,
      diagnostics: true,
    });
  });

  it("Hermes RUNS agent is ready with a bound runtime", () => {
    const r = resolveChatReadiness({
      provider: "HERMES",
      runEngine: "RUNS",
      runtime: { adapterKey: "hermes", endpoint: "https://gw.example/v1", secret: "tok" },
    });
    expect(r.ready).toBe(true);
    expect(r.mode).toBe("runs");
    expect(r.reason).toBe("runs-connector");
    expect(r.transportLabel).toBe("Hermes");
  });

  it("Hermes RUNS agent is not ready when the bound runtime failed its contract probe", () => {
    const r = resolveChatReadiness({
      provider: "HERMES",
      runEngine: "RUNS",
      runtime: {
        adapterKey: "hermes",
        endpoint: "https://gw.example/v1",
        secret: "tok",
        lastProbeAttempted: true,
        lastProbeReachable: false,
        lastProbeDetail: "Hermes runs API missing (HTTP 404).",
      },
    });
    expect(r.ready).toBe(false);
    expect(r.mode).toBe("runs");
    expect(r.reason).toBe("runtime-probe-failed");
    expect(r.hint).toMatch(/runs API missing/);
  });

  it("CODEX RUNS agent with no managed runtime is not ready, steers to runtime", () => {
    const r = resolveChatReadiness({ provider: "CODEX", runEngine: "RUNS", runtime: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("no-runs-connector");
    expect(r.hint).toMatch(/chat-capable runtime/i);
  });

  it("CODEX completions agent on a pull/act MCP connection steers to a runtime, not a key", () => {
    const r = resolveChatReadiness({
      provider: "CODEX",
      runEngine: "COMPLETIONS",
      runtime: { adapterKey: "codex", endpoint: null, secret: null },
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("pull-act-only");
    expect(r.hint).toMatch(/attach it to a chat-capable runtime/i);
  });

  it("CODEX completions with no runtime + no key reports a plain no-model reason", () => {
    const r = resolveChatReadiness({ provider: "CODEX", runEngine: "COMPLETIONS", runtime: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("no-model");
    expect(r.hint).toMatch(/OPENAI_API_KEY/);
  });

  it("Hermes completions with no runtime + no gateway token reports a Hermes no-model reason", () => {
    const r = resolveChatReadiness({ provider: "HERMES", runEngine: "COMPLETIONS", runtime: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("no-model");
    expect(r.hint).toMatch(/HERMES_GATEWAY_TOKEN/);
  });

  it("Hermes completions allows explicit unauthenticated local gateway opt-in", () => {
    process.env.HERMES_GATEWAY_ALLOW_UNAUTH = "1";
    const r = resolveChatReadiness({ provider: "HERMES", runEngine: "COMPLETIONS", runtime: null });
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("model-configured");
  });

  it("CODEX completions becomes ready once OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const r = resolveChatReadiness({ provider: "CODEX", runEngine: "COMPLETIONS", runtime: null });
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("model-configured");
    expect(r.capabilities).toMatchObject({
      streaming: true,
      thinking: true,
      tools: true,
      approvals: true,
      stop: true,
      runs: false,
      dispatch: false,
      vision: true,
    });
  });

  it("a DB-aware providerAvailable predicate marks a keyless provider ready", () => {
    // No OPENAI_API_KEY in env, but the workspace stored a credential → ready.
    const r = resolveChatReadiness({
      provider: "CODEX",
      runEngine: "COMPLETIONS",
      runtime: null,
      providerAvailable: (pid) => pid === "openai",
    });
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("model-configured");
  });

  it("a daemon-linked agent with no server model is served via dispatch (not 'no model')", () => {
    // The local daemon / ACP answers via chat drafts on the event — ready.
    const r = resolveChatReadiness({
      provider: "CLAUDE",
      runEngine: "COMPLETIONS",
      runtime: null,
      daemonLinked: true,
    });
    expect(r.ready).toBe(true);
    expect(r.mode).toBe("dispatch");
    expect(r.reason).toBe("dispatch-path");
    expect(r.capabilities).toMatchObject({
      streaming: true,
      thinking: false,
      tools: false,
      approvals: false,
      stop: false,
      dispatch: true,
      retry: true,
      files: true,
      diagnostics: true,
    });
  });

  it("a per-agent webhook counts as a dispatch path", () => {
    const r = resolveChatReadiness({
      provider: "CUSTOM",
      runEngine: "COMPLETIONS",
      runtime: null,
      webhookUrl: "https://bot.example/hook",
    });
    expect(r.ready).toBe(true);
    expect(r.mode).toBe("dispatch");
  });

  it("an ACP-adapter connection is served via dispatch (ACP session label)", () => {
    const r = resolveChatReadiness({
      provider: "CODEX",
      runEngine: "COMPLETIONS",
      runtime: { adapterKey: "acp", endpoint: null, secret: null },
    });
    expect(r.ready).toBe(true);
    expect(r.mode).toBe("dispatch");
    expect(r.transportLabel).toBe("ACP session");
  });

  it("a LOCAL_DAEMON runtime is served via dispatch (local daemon label)", () => {
    const r = resolveChatReadiness({
      provider: "CLAUDE",
      runEngine: "COMPLETIONS",
      runtime: { adapterKey: "local-daemon", endpoint: null, secret: null },
      runtimeKind: "LOCAL_DAEMON",
    });
    expect(r.mode).toBe("dispatch");
    expect(r.transportLabel).toBe("local daemon");
  });

  it("a configured model still wins over a dispatch path (server completions)", () => {
    const r = resolveChatReadiness({
      provider: "CODEX",
      runEngine: "COMPLETIONS",
      runtime: null,
      daemonLinked: true,
      providerAvailable: () => true,
    });
    expect(r.mode).toBe("completions");
  });

  it("runs agents report a transport label", () => {
    process.env.HERMES_GATEWAY_TOKEN = "test-token";
    const r = resolveChatReadiness({ provider: "HERMES", runEngine: "RUNS", runtime: null });
    expect(r.mode).toBe("runs");
    expect(r.transportLabel.length).toBeGreaterThan(0);
  });

  it("uses the configured runtime name instead of only the adapter title", () => {
    const r = resolveChatReadiness({
      provider: "HERMES",
      runEngine: "RUNS",
      runtime: {
        adapterKey: "hermes",
        endpoint: "https://gw.example/v1",
        secret: "tok",
        name: "Hermes East",
      },
    });
    expect(r.transportLabel).toBe("Hermes East");
  });

  it("a thread provider override is honoured", () => {
    process.env.HERMES_GATEWAY_TOKEN = "test-token";
    // Agent is CODEX (no key), but the thread overrides to HERMES → ready.
    const r = resolveChatReadiness({
      provider: "CODEX",
      runEngine: "COMPLETIONS",
      runtime: null,
      providerOverride: "HERMES",
    });
    expect(r.provider).toBe("HERMES");
    expect(r.ready).toBe(true);
  });
});
