import { describe, it, expect } from "vitest";
import {
  RUNTIME_ADAPTERS,
  getRuntimeAdapter,
  runtimeAdaptersForProvider,
  defaultAdapterForProvider,
  managedAdapters,
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
