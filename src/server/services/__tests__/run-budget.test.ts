import { describe, it, expect } from "vitest";
import { RunBudgetAction } from "@prisma/client";
import {
  evaluateRunBudget,
  budgetUsageFromRun,
  hasAnyBudget,
  clearBudgetMarkers,
  type RunBudgetLimits,
} from "@/server/services/run-budget";

function limits(partial: Partial<RunBudgetLimits>): RunBudgetLimits {
  return {
    runTokenBudget: null,
    runCostBudgetUsd: null,
    runMaxMinutes: null,
    runBudgetWarnPct: 80,
    runBudgetAction: RunBudgetAction.PAUSE,
    ...partial,
  } as RunBudgetLimits;
}

describe("hasAnyBudget", () => {
  it("is false when no cap is set (null/0)", () => {
    expect(hasAnyBudget(limits({}))).toBe(false);
    expect(hasAnyBudget(limits({ runTokenBudget: 0, runMaxMinutes: 0 }))).toBe(false);
  });
  it("is true when any positive cap is set", () => {
    expect(hasAnyBudget(limits({ runTokenBudget: 100 }))).toBe(true);
    expect(hasAnyBudget(limits({ runMaxMinutes: 5 }))).toBe(true);
    expect(hasAnyBudget(limits({ runCostBudgetUsd: 1 as never }))).toBe(true);
  });
});

describe("evaluateRunBudget", () => {
  it("returns ok when no budgets are configured", () => {
    const v = evaluateRunBudget(limits({}), { tokens: 9_999_999, costUsd: 999, elapsedMinutes: 999 });
    expect(v.state).toBe("ok");
    expect(v.metric).toBeNull();
  });

  it("returns ok well under the warn threshold", () => {
    const v = evaluateRunBudget(limits({ runTokenBudget: 1000 }), {
      tokens: 500,
      costUsd: null,
      elapsedMinutes: null,
    });
    expect(v.state).toBe("ok");
  });

  it("warns once the usage crosses runBudgetWarnPct", () => {
    const v = evaluateRunBudget(limits({ runTokenBudget: 1000, runBudgetWarnPct: 80 }), {
      tokens: 850,
      costUsd: null,
      elapsedMinutes: null,
    });
    expect(v.state).toBe("warn");
    expect(v.metric).toBe("tokens");
  });

  it("breaches at or over 100% of a token cap", () => {
    const v = evaluateRunBudget(limits({ runTokenBudget: 1000 }), {
      tokens: 1000,
      costUsd: null,
      elapsedMinutes: null,
    });
    expect(v.state).toBe("breach");
    expect(v.metric).toBe("tokens");
  });

  it("breaches on cost", () => {
    const v = evaluateRunBudget(limits({ runCostBudgetUsd: 20 as never }), {
      tokens: null,
      costUsd: 25,
      elapsedMinutes: null,
    });
    expect(v.state).toBe("breach");
    expect(v.metric).toBe("cost");
  });

  it("breaches on wall-clock time", () => {
    const v = evaluateRunBudget(limits({ runMaxMinutes: 60 }), {
      tokens: null,
      costUsd: null,
      elapsedMinutes: 61,
    });
    expect(v.state).toBe("breach");
    expect(v.metric).toBe("time");
  });

  it("reports the worst (closest-to-breach) metric across several caps", () => {
    const v = evaluateRunBudget(
      limits({ runTokenBudget: 1000, runMaxMinutes: 100 }),
      { tokens: 500 /* 50% */, costUsd: null, elapsedMinutes: 99 /* 99% */ },
    );
    expect(v.state).toBe("warn");
    expect(v.metric).toBe("time");
  });

  it("ignores a metric whose usage is unknown", () => {
    // token cap set but tokens null → only the (unset) others considered → ok
    const v = evaluateRunBudget(limits({ runTokenBudget: 1000 }), {
      tokens: null,
      costUsd: null,
      elapsedMinutes: null,
    });
    expect(v.state).toBe("ok");
  });

  it("warnPct=0 disables the early warning (only breach fires)", () => {
    const v = evaluateRunBudget(limits({ runTokenBudget: 1000, runBudgetWarnPct: 0 }), {
      tokens: 900,
      costUsd: null,
      elapsedMinutes: null,
    });
    expect(v.state).toBe("ok");
  });

  it("treats a 0 cap as unlimited (not an instant breach)", () => {
    const v = evaluateRunBudget(limits({ runTokenBudget: 0 }), {
      tokens: 5_000_000,
      costUsd: null,
      elapsedMinutes: null,
    });
    expect(v.state).toBe("ok");
  });
});

describe("budgetUsageFromRun", () => {
  it("sums tokensIn + tokensOut and computes elapsed minutes", () => {
    const started = new Date("2026-06-23T00:00:00.000Z");
    const now = new Date("2026-06-23T00:30:00.000Z");
    const u = budgetUsageFromRun(
      { startedAt: started, tokensIn: 1000, tokensOut: 234, costUsd: 1.5 },
      now,
    );
    expect(u.tokens).toBe(1234);
    expect(u.costUsd).toBe(1.5);
    expect(u.elapsedMinutes).toBe(30);
  });

  it("returns null tokens when neither in nor out is reported", () => {
    const started = new Date("2026-06-23T00:00:00.000Z");
    const now = new Date("2026-06-23T00:10:00.000Z");
    const u = budgetUsageFromRun({ startedAt: started, tokensIn: null, tokensOut: null }, now);
    expect(u.tokens).toBeNull();
    expect(u.costUsd).toBeNull();
    expect(u.elapsedMinutes).toBe(10);
  });

  it("counts a one-sided token report", () => {
    const started = new Date("2026-06-23T00:00:00.000Z");
    const now = new Date("2026-06-23T00:00:00.000Z");
    const u = budgetUsageFromRun({ startedAt: started, tokensIn: 42, tokensOut: null }, now);
    expect(u.tokens).toBe(42);
  });
});

describe("clearBudgetMarkers (re-arm on resume)", () => {
  it("returns undefined for non-object / missing budget meta (no-op resume)", () => {
    expect(clearBudgetMarkers(null)).toBeUndefined();
    expect(clearBudgetMarkers(undefined)).toBeUndefined();
    expect(clearBudgetMarkers("nope")).toBeUndefined();
    expect(clearBudgetMarkers({ other: 1 })).toBeUndefined();
    expect(clearBudgetMarkers({ budget: {} })).toBeUndefined();
    expect(clearBudgetMarkers({ budget: { warnPct: 80 } })).toBeUndefined();
  });

  it("strips breach markers so enforcement re-arms, preserving other keys", () => {
    const meta = {
      contractVersion: "1",
      budget: {
        breachedAt: "2026-06-23T00:00:00.000Z",
        breachedMetric: "tokens",
        warnedAt: "2026-06-22T23:00:00.000Z",
        warnedMetric: "tokens",
        used: 21_000_000,
        limit: 5_000_000,
        action: "PAUSE",
        stopped: true,
      },
    };
    const out = clearBudgetMarkers(meta) as Record<string, unknown>;
    expect(out).toBeDefined();
    // unrelated meta preserved
    expect(out.contractVersion).toBe("1");
    const budget = out.budget as Record<string, unknown>;
    // breach/warn markers gone -> the breachedAt short-circuit no longer fires
    expect(budget.breachedAt).toBeUndefined();
    expect(budget.warnedAt).toBeUndefined();
    expect(budget.breachedMetric).toBeUndefined();
    expect(budget.warnedMetric).toBeUndefined();
    expect(budget.stopped).toBeUndefined();
    // a breadcrumb of the re-arm is left
    expect(typeof budget.rearmedAt).toBe("string");
  });

  it("does not mutate the input object", () => {
    const meta = { budget: { breachedAt: "x", limit: 5 } };
    clearBudgetMarkers(meta);
    expect(meta.budget.breachedAt).toBe("x");
  });
});
