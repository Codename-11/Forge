import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  getRunsConnector,
  getRunsConnectorForAgent,
  resolveRunEngine,
} from "@/server/services/dispatch/registry";

describe("getRunsConnectorForAgent", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.HERMES_GATEWAY_TOKEN;
    delete process.env.HERMES_GATEWAY_ALLOW_UNAUTH;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("does not expose the env fallback when Hermes env is not configured", () => {
    const c = getRunsConnectorForAgent({ provider: "HERMES", runtime: null });
    expect(c).toBeNull();
  });

  it("falls back to the env singleton when Hermes env is configured", () => {
    process.env.HERMES_GATEWAY_TOKEN = "test-token";
    const envSingleton = getRunsConnector("HERMES");
    const c = getRunsConnectorForAgent({ provider: "HERMES", runtime: null });
    expect(c).toBe(envSingleton);
  });

  it("falls back to env when a hermes runtime has no endpoint and env is configured", () => {
    process.env.HERMES_GATEWAY_TOKEN = "test-token";
    const envSingleton = getRunsConnector("HERMES");
    const c = getRunsConnectorForAgent({
      provider: "HERMES",
      runtime: { adapterKey: "hermes", endpoint: null, secret: null },
    });
    expect(c).toBe(envSingleton);
  });

  it("builds a runtime-bound connector when a hermes runtime has an endpoint", () => {
    const envSingleton = getRunsConnector("HERMES");
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
    expect(c).toBeNull();
  });

  it("builds a Codex app-server connector for a codex-app-server runtime", () => {
    const c = getRunsConnectorForAgent({
      provider: "CODEX",
      runtime: { adapterKey: "codex-app-server", endpoint: "wss://codex.example:4500", secret: "t" },
    });
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("codex-app-server");
  });

  it("a codex-app-server runtime with no endpoint stays null (inert until configured)", () => {
    const c = getRunsConnectorForAgent({
      provider: "CODEX",
      runtime: { adapterKey: "codex-app-server", endpoint: null, secret: null },
    });
    expect(c).toBeNull();
  });
});

describe("resolveRunEngine runtime precedence", () => {
  it("a Codex agent defaults to COMPLETIONS without a runs runtime", () => {
    expect(resolveRunEngine({ runEngine: null, provider: "CODEX", runtime: null })).toBe(
      "COMPLETIONS",
    );
  });

  it("attaching a Codex agent to the app-server runtime flips it to RUNS", () => {
    expect(
      resolveRunEngine({
        runEngine: null,
        provider: "CODEX",
        runtime: { adapterKey: "codex-app-server", endpoint: "wss://x:4500", secret: null },
      }),
    ).toBe("RUNS");
  });

  it("an explicit per-agent runEngine still wins over the runtime default", () => {
    expect(
      resolveRunEngine({
        runEngine: "COMPLETIONS",
        provider: "CODEX",
        runtime: { adapterKey: "codex-app-server", endpoint: "wss://x:4500", secret: null },
      }),
    ).toBe("COMPLETIONS");
  });
});
