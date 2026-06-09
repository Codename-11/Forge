import { describe, expect, it } from "vitest";
import { buildChatDiagnosticReport } from "@/lib/chat-diagnostic-report";

describe("chat diagnostic report", () => {
  it("includes operational state and redacts secrets/urls", () => {
    const report = buildChatDiagnosticReport({
      workspaceSlug: "forge",
      threadId: "thread_123",
      generatedAt: new Date("2026-06-09T12:00:00.000Z"),
      agent: {
        id: "agent_1",
        name: "Victor",
        profileKey: "victor",
        provider: "HERMES",
        runEngine: "RUNS",
        runtimeMode: "PERSISTENT",
        status: "ONLINE",
        lastHeartbeatAt: new Date("2026-06-09T11:59:00.000Z"),
      },
      readiness: {
        ready: false,
        mode: "runs",
        provider: "HERMES",
        transportLabel: "Hermes gateway",
        reason: "runtime-probe-failed",
        hint: "Gateway failed with Bearer abc123 at https://gateway.example.com and token=secret",
      },
      runtime: {
        id: "runtime_1",
        name: "Hermes gateway",
        kind: "REMOTE_HTTP",
        adapterKey: "hermes",
        lastProbeAttempted: true,
        lastProbeReachable: false,
        lastProbeDetail: "authorization: bad-secret",
        health: {
          label: "stale/offline",
          tone: "warning",
          reason: "Probe failed at https://gateway.example.com with secret=topsecret",
          lastSignal: "probe failed",
        },
      },
      diagnostics: {
        dispatchState: "stalled",
        waitingForReply: true,
        waitingMs: 61_000,
        turnStatus: {
          phase: "failed",
          label: "Needs attention",
          detail: "Delivery failed before reply.",
          tone: "danger",
          runId: "run_1",
        },
        latestUserMessage: {
          id: "msg_1",
          createdAt: "2026-06-09T11:58:00.000Z",
          wakeAttempts: 2,
          lastWakeDeliveryId: "delivery_1",
        },
        lastRun: {
          id: "run_1",
          status: "ACTIVE",
          currentStep: "thinking",
          idleMs: 61_000,
        },
        lastDelivery: {
          id: "delivery_1",
          status: "FAILED",
          attempts: 3,
          lastError: "Bearer abc123 secret=hidden https://gateway.example.com",
        },
      },
    });

    expect(report).toContain("Forge chat diagnostic report");
    expect(report).toContain("Thread: thread_123");
    expect(report).toContain("- handle: @victor");
    expect(report).toContain("- reason: runtime-probe-failed");
    expect(report).toContain("- dispatch state: stalled");
    expect(report).toContain("- idle: 1m");
    expect(report).toContain("[REDACTED]");
    expect(report).toContain("[REDACTED_URL]");
    expect(report).not.toContain("abc123");
    expect(report).not.toContain("gateway.example.com");
    expect(report).not.toContain("topsecret");
  });
});
