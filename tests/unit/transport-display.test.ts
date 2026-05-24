import { describe, it, expect } from "vitest";
import {
  transportTone,
  transportTitle,
  transportModeWord,
  agentAvailabilityModel,
  type TransportMode,
} from "@/lib/transport-display";

const MODES: TransportMode[] = ["runs", "completions", "dispatch", "none"];

describe("transport-display", () => {
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
    expect(transportTitle("dispatch", "ACP session")).toContain("ACP session");
    expect(transportTitle("completions", "OpenAI")).toContain("OpenAI");
  });

  it("none title doesn't require a label", () => {
    expect(transportTitle("none", "—")).toMatch(/no chat model or runtime/i);
  });

  it("mode word maps as expected", () => {
    expect(transportModeWord("runs")).toBe("runs");
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
      agentAvailabilityModel({ runtimeMode: "PERSISTENT", lastHeartbeatAt: null, transportMode: "dispatch" }),
    ).toBe("on-demand");
    expect(
      agentAvailabilityModel({ runtimeMode: "PERSISTENT", lastHeartbeatAt: null, transportMode: "completions" }),
    ).toBe("on-demand");
  });

  it("ephemeral agents are session", () => {
    expect(
      agentAvailabilityModel({ runtimeMode: "EPHEMERAL", lastHeartbeatAt: null, transportMode: "runs" }),
    ).toBe("session");
  });

  it("no chat path + no heartbeat falls back to heartbeat display", () => {
    expect(
      agentAvailabilityModel({ runtimeMode: "PERSISTENT", lastHeartbeatAt: null, transportMode: "none" }),
    ).toBe("heartbeat");
  });
});
