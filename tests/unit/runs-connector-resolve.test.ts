import { describe, it, expect } from "vitest";
import {
  getRunsConnector,
  getRunsConnectorForAgent,
} from "@/server/services/dispatch/registry";

describe("getRunsConnectorForAgent", () => {
  const envSingleton = getRunsConnector("HERMES");

  it("falls back to the env singleton when no runtime is set", () => {
    const c = getRunsConnectorForAgent({ provider: "HERMES", runtime: null });
    expect(c).toBe(envSingleton);
  });

  it("falls back to env when a hermes runtime has no endpoint", () => {
    const c = getRunsConnectorForAgent({
      provider: "HERMES",
      runtime: { adapterKey: "hermes", endpoint: null, secret: null },
    });
    expect(c).toBe(envSingleton);
  });

  it("builds a runtime-bound connector when a hermes runtime has an endpoint", () => {
    const c = getRunsConnectorForAgent({
      provider: "HERMES",
      runtime: { adapterKey: "hermes", endpoint: "https://gw.example/v1", secret: "tok" },
    });
    expect(c).not.toBeNull();
    expect(c).not.toBe(envSingleton); // a distinct, bound instance
    expect(c!.kind).toBe("hermes-runs");
  });

  it("returns null for providers without a runs connector", () => {
    expect(getRunsConnectorForAgent({ provider: "CODEX", runtime: null })).toBeNull();
    expect(getRunsConnectorForAgent({ provider: "CUSTOM", runtime: null })).toBeNull();
  });

  it("ignores a non-hermes runtime adapter for connector binding", () => {
    // A custom-http runtime endpoint must not be used as a Hermes runs gateway.
    const c = getRunsConnectorForAgent({
      provider: "HERMES",
      runtime: { adapterKey: "custom-http", endpoint: "https://hook.example", secret: null },
    });
    expect(c).toBe(envSingleton);
  });
});
