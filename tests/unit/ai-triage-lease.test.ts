import { describe, expect, it } from "vitest";
import { AI_TRIAGE_PENDING_LEASE_MS, isAiTriagePendingStale } from "@/lib/ai-triage";

describe("AI triage pending lease", () => {
  it("keeps a recent claim active", () => {
    const now = Date.now();
    expect(isAiTriagePendingStale(new Date(now - 1_000), now)).toBe(false);
  });

  it("allows retry after the lease and recovers legacy pending rows without a timestamp", () => {
    const now = Date.now();
    expect(isAiTriagePendingStale(new Date(now - AI_TRIAGE_PENDING_LEASE_MS), now)).toBe(true);
    expect(isAiTriagePendingStale(null, now)).toBe(true);
  });
});
