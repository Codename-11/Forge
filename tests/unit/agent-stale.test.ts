import { describe, expect, it } from "vitest";
import { deriveRunFreshness } from "@/lib/agent-stale";

const now = new Date("2026-07-13T12:10:00.000Z");

describe("deriveRunFreshness", () => {
  it("calls an active run quiet without promoting it to canonical STALLED", () => {
    expect(
      deriveRunFreshness({
        status: "ACTIVE",
        lastEventAt: "2026-07-13T12:00:00.000Z",
        now,
      }),
    ).toBe("QUIET");
  });

  it("reserves STALLED for the persisted run status", () => {
    expect(
      deriveRunFreshness({
        status: "STALLED",
        lastEventAt: "2026-07-13T12:09:59.000Z",
        now,
      }),
    ).toBe("STALLED");
  });

  it("does not age WAITING or terminal non-stalled runs into quiet", () => {
    const old = "2026-07-13T11:00:00.000Z";
    expect(deriveRunFreshness({ status: "WAITING", lastEventAt: old, now })).toBe("LIVE");
    expect(deriveRunFreshness({ status: "COMPLETED", lastEventAt: old, now })).toBe("LIVE");
    expect(deriveRunFreshness({ status: "ABANDONED", lastEventAt: old, now })).toBe("LIVE");
  });
});
