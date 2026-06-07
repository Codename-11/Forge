import { describe, expect, it } from "vitest";
import { RuntimeKind } from "@prisma/client";
import { deriveRuntimeHealthStatus } from "@/server/services/runtime-status";

const base = {
  id: "runtime_1",
  name: "Hermes",
  kind: RuntimeKind.REMOTE_HTTP,
  adapterKey: "hermes",
  endpoint: "http://127.0.0.1:8642/v1",
  archivedAt: null,
  disabledAt: null,
  heartbeatAt: null,
  connectedAt: null,
  lastProbeAt: null,
  lastProbeAttempted: false,
  lastProbeReachable: null,
  lastProbeDetail: null,
};

const now = new Date("2026-06-05T12:00:00.000Z");

describe("deriveRuntimeHealthStatus", () => {
  it("distinguishes disabled and archived from generic offline", () => {
    expect(
      deriveRuntimeHealthStatus({ ...base, disabledAt: new Date("2026-06-05T11:00:00Z") }, { now }).kind,
    ).toBe("disabled");
    expect(
      deriveRuntimeHealthStatus({ ...base, archivedAt: new Date("2026-06-05T11:00:00Z") }, { now }).kind,
    ).toBe("archived");
  });

  it("reports a fresh Hermes probe as gateway-online even without a runtime heartbeat", () => {
    const status = deriveRuntimeHealthStatus(
      {
        ...base,
        lastProbeAt: new Date("2026-06-05T11:59:00Z"),
        lastProbeAttempted: true,
        lastProbeReachable: true,
        lastProbeDetail: "Gateway answered (HTTP 200).",
      },
      { now },
    );

    expect(status.kind).toBe("online");
    expect(status.label).toBe("gateway online");
    expect(status.reason).toMatch(/agent presence/i);
    expect(status.reason).toMatch(/forge-presence|webhook/i);
    expect(status.lastSignal).toContain("probe reachable");
    expect(status.sweepExpectation).toMatch(/swept by the runtime health worker/i);
  });

  it("prioritizes a failed supported probe as an actionable failed state", () => {
    const status = deriveRuntimeHealthStatus(
      {
        ...base,
        adapterKey: "codex-app-server",
        endpoint: "ws://127.0.0.1:1",
        heartbeatAt: new Date("2026-06-05T11:00:00Z"),
        lastProbeAt: new Date("2026-06-05T11:59:00Z"),
        lastProbeAttempted: true,
        lastProbeReachable: false,
        lastProbeDetail: "connect ECONNREFUSED 127.0.0.1:1 with Bearer super-secret-token",
      },
      { now },
    );

    expect(status.kind).toBe("probe_failed");
    expect(status.reason).toContain("ECONNREFUSED");
    expect(status.reason).not.toContain("super-secret-token");
    expect(status.sweepExpectation).toMatch(/swept/i);
  });

  it("identifies endpoints with no configured probe separately", () => {
    const status = deriveRuntimeHealthStatus(
      {
        ...base,
        adapterKey: "custom-http",
        endpoint: "https://runtime.example.com/webhook",
      },
      { now },
    );

    expect(status.kind).toBe("probe_not_configured");
    expect(status.reason).toMatch(/no handshake probe/i);
  });
});
