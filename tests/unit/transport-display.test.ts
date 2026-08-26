import { describe, it, expect } from "vitest";
import {
  transportTone,
  transportTitle,
  transportModeWord,
  agentAvailabilityModel,
  presenceAvailability,
  runtimeDisplayIdentity,
  type TransportMode,
} from "@/lib/transport-display";

const MODES: TransportMode[] = ["sessions", "runs", "completions", "dispatch", "none"];

describe("transport-display", () => {
  it("labels managed runtimes from adapter transport instead of REMOTE_HTTP storage kind", () => {
    expect(runtimeDisplayIdentity({ adapterKey: "hermes", kind: "REMOTE_HTTP" })).toEqual({
      runtimeLabel: "Hermes managed runtime",
      transportLabel: "Runs API",
    });
    expect(runtimeDisplayIdentity({ adapterKey: "codex-app-server", kind: "REMOTE_HTTP" })).toEqual(
      {
        runtimeLabel: "Codex managed runtime",
        transportLabel: "App server",
      },
    );
  });

  it("reserves webhook copy for the actual custom webhook adapter", () => {
    expect(runtimeDisplayIdentity({ adapterKey: "custom-http", kind: "REMOTE_HTTP" })).toEqual({
      runtimeLabel: "Custom webhook runtime",
      transportLabel: "Webhook",
    });
    expect(runtimeDisplayIdentity({ kind: "REMOTE_HTTP" }).runtimeLabel).toBe("Remote runtime");
  });

  it("returns a tone for every mode", () => {
    for (const m of MODES) {
      expect(transportTone(m).length).toBeGreaterThan(0);
    }
  });

  it("tones are distinct per mode", () => {
    const tones = new Set(MODES.map(transportTone));
    expect(tones.size).toBe(MODES.length);
  });

  it("title includes the label for active modes", () => {
    expect(transportTitle("runs", "Hermes")).toContain("Hermes");
    expect(transportTitle("sessions", "Hermes")).toContain("Hermes");
    expect(transportTitle("dispatch", "ACP session")).toContain("ACP session");
    expect(transportTitle("completions", "OpenAI")).toContain("OpenAI");
  });

  it("none title doesn't require a label", () => {
    expect(transportTitle("none", "—")).toMatch(/no chat model or runtime/i);
  });

  it("mode word maps as expected", () => {
    expect(transportModeWord("runs")).toBe("runs");
    expect(transportModeWord("sessions")).toBe("sessions");
    expect(transportModeWord("completions")).toBe("streaming");
    expect(transportModeWord("dispatch")).toBe("dispatch");
    expect(transportModeWord("none")).toBe("no chat");
  });
});

describe("agentAvailabilityModel", () => {
  it("Codex app server (runs, never heartbeat) is on-demand, not offline", () => {
    expect(
      agentAvailabilityModel({
        runtimeMode: "PERSISTENT",
        lastHeartbeatAt: null,
        transportMode: "runs",
        runtimeHeartbeats: false,
      }),
    ).toBe("on-demand");
  });

  it("Hermes (heartbeats) uses the heartbeat model", () => {
    expect(
      agentAvailabilityModel({
        runtimeMode: "PERSISTENT",
        lastHeartbeatAt: null,
        transportMode: "runs",
        runtimeHeartbeats: true,
      }),
    ).toBe("heartbeat");
  });

  it("an agent that has ever heartbeat uses the heartbeat model", () => {
    expect(
      agentAvailabilityModel({
        runtimeMode: "PERSISTENT",
        lastHeartbeatAt: new Date(),
        transportMode: "completions",
      }),
    ).toBe("heartbeat");
  });

  it("dispatch + completions agents with no heartbeat are on-demand", () => {
    expect(
      agentAvailabilityModel({
        runtimeMode: "PERSISTENT",
        lastHeartbeatAt: null,
        transportMode: "dispatch",
      }),
    ).toBe("on-demand");
    expect(
      agentAvailabilityModel({
        runtimeMode: "PERSISTENT",
        lastHeartbeatAt: null,
        transportMode: "completions",
      }),
    ).toBe("on-demand");
  });

  it("ephemeral agents are session", () => {
    expect(
      agentAvailabilityModel({
        runtimeMode: "EPHEMERAL",
        lastHeartbeatAt: null,
        transportMode: "runs",
      }),
    ).toBe("session");
  });

  it("no chat path + no heartbeat falls back to heartbeat display", () => {
    expect(
      agentAvailabilityModel({
        runtimeMode: "PERSISTENT",
        lastHeartbeatAt: null,
        transportMode: "none",
      }),
    ).toBe("heartbeat");
  });
});

describe("presenceAvailability (base-column derivation)", () => {
  it("a CODEX agent attached to a runtime, no heartbeat → on-demand", () => {
    expect(
      presenceAvailability({ provider: "CODEX", runtimeMode: "PERSISTENT", runtimeId: "rt_x" }),
    ).toBe("on-demand");
  });

  it("a CUSTOM agent with a webhook, no heartbeat → on-demand", () => {
    expect(
      presenceAvailability({
        provider: "CUSTOM",
        runtimeMode: "PERSISTENT",
        webhookUrl: "https://x",
      }),
    ).toBe("on-demand");
  });

  it("Hermes uses the heartbeat model even with a runtime", () => {
    expect(
      presenceAvailability({ provider: "HERMES", runtimeMode: "PERSISTENT", runtimeId: "rt_h" }),
    ).toBe("heartbeat");
  });

  it("an agent that has heartbeat uses the heartbeat model", () => {
    expect(
      presenceAvailability({
        provider: "CODEX",
        runtimeMode: "PERSISTENT",
        lastHeartbeatAt: new Date(),
        runtimeId: "rt",
      }),
    ).toBe("heartbeat");
  });

  it("an unconfigured agent (no runtime/webhook/heartbeat) stays heartbeat (shows status)", () => {
    expect(presenceAvailability({ provider: "CODEX", runtimeMode: "PERSISTENT" })).toBe(
      "heartbeat",
    );
  });

  it("ephemeral → session; missing fields are null-safe", () => {
    expect(presenceAvailability({ runtimeMode: "EPHEMERAL" })).toBe("session");
    expect(presenceAvailability({})).toBe("heartbeat");
  });
});
