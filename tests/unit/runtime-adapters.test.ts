import { describe, it, expect } from "vitest";
import {
  RUNTIME_ADAPTERS,
  getRuntimeAdapter,
  runtimeAdaptersForProvider,
  defaultAdapterForProvider,
  managedAdapters,
  adapterServesChat,
  adapterKeyForLegacyRuntime,
} from "@/server/runtimes/adapters";

describe("runtime adapter registry", () => {
  it("has unique keys and valid shape", () => {
    const keys = RUNTIME_ADAPTERS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of RUNTIME_ADAPTERS) {
      expect(a.providers.length).toBeGreaterThan(0);
      // runs-api adapters are the managed loop-owners
      if (a.transport === "runs-api") expect(a.managed).toBe(true);
    }
  });

  it("Hermes is a managed, multi-agent, loop-owning runs-api adapter", () => {
    const h = getRuntimeAdapter("hermes");
    expect(h).not.toBeNull();
    expect(h!.managed).toBe(true);
    expect(h!.multiAgent).toBe(true);
    expect(h!.transport).toBe("runs-api");
    expect(h!.defaultRunEngine).toBe("RUNS");
    expect(h!.capabilities.streaming).toBe(true);
  });

  it("CLI connections are thin (managed=false, mcp transport)", () => {
    for (const key of ["claude-code", "codex"]) {
      const a = getRuntimeAdapter(key)!;
      expect(a.managed).toBe(false);
      expect(a.transport).toBe("mcp");
    }
  });

  it("every adapter declares a chatMode", () => {
    for (const a of RUNTIME_ADAPTERS) {
      expect(["runs", "completions", "acp", "none"]).toContain(a.chatMode);
    }
  });

  it("pull/act CLI connections do not serve chat; Hermes does", () => {
    // Codex/Claude Code are reached over MCP for context+actions — they
    // must NOT present as chat backends (this is the "Codex via Hermes"
    // regression guard).
    expect(adapterServesChat(getRuntimeAdapter("codex"))).toBe(false);
    expect(adapterServesChat(getRuntimeAdapter("claude-code"))).toBe(false);
    expect(adapterServesChat(getRuntimeAdapter("custom-http"))).toBe(false);
    // Managed loop-owners serve chat as themselves.
    expect(adapterServesChat(getRuntimeAdapter("hermes"))).toBe(true);
    // No registered adapter relies on the deferred completions chat-only
    // provider concept yet.
    expect(RUNTIME_ADAPTERS.some((a) => a.chatMode === "completions")).toBe(false);
  });

  it("orders managed adapters first for a provider", () => {
    const forClaude = runtimeAdaptersForProvider("CLAUDE");
    expect(forClaude.length).toBeGreaterThan(0);
    // local-daemon (managed) should sort ahead of claude-code (connection)
    expect(forClaude[0].managed).toBe(true);
    expect(defaultAdapterForProvider("HERMES")!.key).toBe("hermes");
  });

  it("managedAdapters() returns only managed", () => {
    expect(managedAdapters().every((a) => a.managed)).toBe(true);
  });

  it("Codex app server is a first-class managed runs adapter", () => {
    const c = getRuntimeAdapter("codex-app-server")!;
    expect(c.managed).toBe(true);
    expect(c.transport).toBe("app-server");
    expect(c.chatMode).toBe("runs");
    expect(c.defaultRunEngine).toBe("RUNS");
    expect(c.providers).toContain("CODEX");
    expect(adapterServesChat(c)).toBe(true);
  });

  it("legacy backfill matches the SQL in migration 0059", () => {
    expect(adapterKeyForLegacyRuntime({ kind: "LOCAL_DAEMON", providersAvailable: [] })).toBe(
      "local-daemon",
    );
    expect(
      adapterKeyForLegacyRuntime({ kind: "REMOTE_HTTP", providersAvailable: ["HERMES"] }),
    ).toBe("hermes");
    expect(
      adapterKeyForLegacyRuntime({ kind: "REMOTE_HTTP", providersAvailable: ["CUSTOM"] }),
    ).toBe("custom-http");
    expect(adapterKeyForLegacyRuntime({ kind: "CLOUD", providersAvailable: [] })).toBe(
      "custom-http",
    );
  });
});
