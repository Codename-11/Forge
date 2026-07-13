import { AgentRunStatus, EngagementMode } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  deriveRunProtocolSignals,
  runProtocolDiagnostics,
} from "@/server/services/run-protocol-diagnostics";

const now = new Date("2026-07-13T12:10:00.000Z");

function run(
  overrides: Partial<Parameters<typeof deriveRunProtocolSignals>[0]["run"]> = {},
): Parameters<typeof deriveRunProtocolSignals>[0]["run"] {
  return {
    status: AgentRunStatus.ACTIVE,
    engagementMode: EngagementMode.EXECUTE,
    acknowledgedAt: new Date("2026-07-13T12:00:05.000Z"),
    outputStartedAt: new Date("2026-07-13T12:00:10.000Z"),
    lastEventAt: new Date("2026-07-13T12:09:50.000Z"),
    statusComment: { updatedAt: new Date("2026-07-13T12:09:00.000Z") },
    ...overrides,
  };
}

describe("deriveRunProtocolSignals", () => {
  it("tracks the four protocol signals independently", () => {
    expect(deriveRunProtocolSignals({ run: run(), now })).toEqual({
      acknowledgement: {
        state: "RECORDED",
        at: new Date("2026-07-13T12:00:05.000Z"),
      },
      output: { state: "RECORDED", at: new Date("2026-07-13T12:00:10.000Z") },
      progress: { state: "CURRENT", at: new Date("2026-07-13T12:09:00.000Z") },
      completion: { state: "PENDING", at: null },
    });
  });

  it("does not let fresh mechanical events disguise a quiet semantic checkpoint", () => {
    const signals = deriveRunProtocolSignals({
      run: run({
        lastEventAt: new Date("2026-07-13T12:09:59.000Z"),
        statusComment: { updatedAt: new Date("2026-07-13T12:00:00.000Z") },
      }),
      now,
    });

    expect(signals.progress).toMatchObject({ state: "QUIET" });
    expect(signals.completion).toMatchObject({ state: "PENDING" });
  });

  it("distinguishes loaded-but-missing progress from progress not loaded by the caller", () => {
    expect(
      deriveRunProtocolSignals({ run: run({ statusComment: null }), now }).progress.state,
    ).toBe("MISSING");

    const withoutStatusRelation = run();
    delete withoutStatusRelation.statusComment;
    expect(deriveRunProtocolSignals({ run: withoutStatusRelation, now }).progress.state).toBe(
      "UNKNOWN",
    );
  });

  it("disables timed semantic-progress warnings when workspace cadence is zero", () => {
    const target = run({
      statusComment: null,
      outputStartedAt: new Date("2026-07-13T10:00:00.000Z"),
    });
    expect(
      deriveRunProtocolSignals({ run: target, now, progressUpdateMs: 0 }).progress.state,
    ).toBe("UNKNOWN");
    expect(runProtocolDiagnostics({ run: target, now, progressUpdateMs: 0 })).toEqual([]);
  });

  it("keeps an intentional WAITING run out of quiet progress", () => {
    const signals = deriveRunProtocolSignals({
      run: run({
        status: AgentRunStatus.WAITING,
        lastEventAt: new Date("2026-07-13T10:00:00.000Z"),
        statusComment: null,
      }),
      now,
    });

    expect(signals.progress.state).toBe("WAITING");
    expect(signals.completion.state).toBe("PENDING");
  });

  it("represents canonical terminal outcomes without inferring them from age", () => {
    expect(
      deriveRunProtocolSignals({ run: run({ status: AgentRunStatus.STALLED }), now }).completion
        .state,
    ).toBe("FAILED");
    expect(
      deriveRunProtocolSignals({ run: run({ status: AgentRunStatus.COMPLETED }), now }).completion
        .state,
    ).toBe("RECORDED");
  });
});

describe("runProtocolDiagnostics", () => {
  it("reports quiet semantic progress even while mechanical events remain fresh", () => {
    const diagnostics = runProtocolDiagnostics({
      run: run({
        lastEventAt: new Date("2026-07-13T12:09:59.000Z"),
        statusComment: { updatedAt: new Date("2026-07-13T12:00:00.000Z") },
      }),
      now,
    });

    expect(diagnostics.map((item) => item.code)).toEqual(["progress-quiet"]);
  });

  it("calls an old active run quiet and completion-missing, not canonically stalled", () => {
    const diagnostics = runProtocolDiagnostics({
      run: run({
        lastEventAt: new Date("2026-07-13T12:00:00.000Z"),
        statusComment: { updatedAt: new Date("2026-07-13T12:09:00.000Z") },
      }),
      now,
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "completion-missing",
        title: "Completion not recorded",
      }),
    ]);
    expect(diagnostics[0]?.description).toContain("not canonically stalled");
  });

  it("disables the quiet-run completion reminder when the workspace threshold is zero", () => {
    const diagnostics = runProtocolDiagnostics({
      run: run({
        lastEventAt: new Date("2026-07-13T10:00:00.000Z"),
        statusComment: { updatedAt: new Date("2026-07-13T12:09:00.000Z") },
      }),
      now,
      quietMs: 0,
    });

    expect(diagnostics).toEqual([]);
  });

  it("does not raise quiet-progress or completion reminders for WAITING runs", () => {
    const diagnostics = runProtocolDiagnostics({
      run: run({
        status: AgentRunStatus.WAITING,
        lastEventAt: new Date("2026-07-13T10:00:00.000Z"),
        statusComment: null,
      }),
      now,
    });

    expect(diagnostics).toEqual([]);
  });
});
