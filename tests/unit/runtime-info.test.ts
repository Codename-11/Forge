import { describe, expect, it } from "vitest";
import {
  extractRuntimeInfoFromInitializeResult,
  sanitizeRuntimeInfo,
  summarizeRuntimeInfo,
} from "@/server/services/runtime-info";

describe("runtime info", () => {
  it("stores only supported sanitized metadata fields", () => {
    const info = sanitizeRuntimeInfo({
      bridgeVersion: "1.2.3",
      codexVersion: "0.133.0",
      workspaceRoot: "/work/forge?token=super-secret",
      apiKey: "should-not-store",
      details: {
        provision: "ok",
        secretToken: "should-not-store",
      },
    });

    expect(info).toMatchObject({
      bridgeVersion: "1.2.3",
      codexVersion: "0.133.0",
      workspaceRoot: "/work/forge?token=[redacted]",
      details: { provision: "ok" },
    });
    expect(info).not.toHaveProperty("apiKey");
    expect(info?.details).not.toHaveProperty("secretToken");
  });

  it("summarizes version fields for operator display", () => {
    const summary = summarizeRuntimeInfo({
      runtimeInfo: {
        bridgeVersion: "1.0.0",
        codexVersion: "0.133.0",
        hostname: "codex-bridge",
      },
      lastInfoAt: new Date("2026-06-18T12:00:00.000Z"),
    });

    expect(summary.status).toBe("reported");
    expect(summary.label).toBe("Codex 0.133.0");
    expect(summary.fields.map((f) => f.key)).toContain("bridgeVersion");
    expect(summary.fields.map((f) => f.key)).toContain("hostname");
  });

  it("extracts serverInfo from protocol initialize results", () => {
    const info = extractRuntimeInfoFromInitializeResult(
      {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "codex-bridge", version: "1.0.0" },
      },
      { adapterKey: "codex-app-server", transport: "app-server" },
    );

    expect(info).toMatchObject({
      adapterKey: "codex-app-server",
      transport: "app-server",
      runtimeName: "codex-bridge",
      runtimeVersion: "1.0.0",
      protocolVersion: "2024-11-05",
    });
  });
});
