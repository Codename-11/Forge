import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveRunOperationalState } from "@/components/orchestration/run-operational-status";
import type { OrchestrationAttentionRun } from "@/components/orchestration/run-attention-panel";

function run(overrides: Partial<OrchestrationAttentionRun> = {}): OrchestrationAttentionRun {
  return {
    id: "run_1",
    status: "ACTIVE",
    startedAt: new Date("2026-07-11T12:00:00.000Z"),
    lastEventAt: new Date("2026-07-11T12:09:30.000Z"),
    ...overrides,
  };
}

describe("deriveRunOperationalState", () => {
  afterEach(() => vi.useRealTimers());

  it("distinguishes dispatched, acknowledged, and producing work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:10:00.000Z"));

    expect(deriveRunOperationalState(run(), "RUNNING").phase).toBe("DISPATCHED");
    expect(
      deriveRunOperationalState(
        run({ acknowledgedAt: new Date("2026-07-11T12:09:35.000Z") }),
        "RUNNING",
      ).phase,
    ).toBe("ACKNOWLEDGED");
    expect(
      deriveRunOperationalState(
        run({
          acknowledgedAt: new Date("2026-07-11T12:09:35.000Z"),
          outputStartedAt: new Date("2026-07-11T12:09:40.000Z"),
          currentStep: "running verification",
        }),
        "RUNNING",
      ),
    ).toMatchObject({ phase: "WORKING", detail: "running verification", live: true });
  });

  it("promotes waiting, stale, and review work into operator attention", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:10:00.000Z"));

    expect(deriveRunOperationalState(run({ status: "WAITING" }), "RUNNING")).toMatchObject({
      phase: "WAITING",
      needsAttention: true,
    });
    expect(
      deriveRunOperationalState(
        run({ lastEventAt: new Date("2026-07-11T12:00:00.000Z") }),
        "RUNNING",
      ),
    ).toMatchObject({ phase: "STALLED", label: "Quiet", needsAttention: true });
    expect(deriveRunOperationalState(run({ status: "COMPLETED" }), "REVIEW")).toMatchObject({
      phase: "REVIEW",
      label: "Needs review",
      needsAttention: true,
    });
  });

  it("shows ready work without a run as queued", () => {
    expect(deriveRunOperationalState(null, "READY")).toMatchObject({
      phase: "QUEUED",
      label: "Queued",
      live: false,
    });
  });
});
