import { describe, expect, it } from "vitest";
import {
  assertValidSchedule,
  nextScheduledRunAt,
  zonedDateTimeToUtc,
} from "@/server/services/scheduled-task-schedule";

describe("scheduled task schedule math", () => {
  it("advances interval schedules from their prior occurrence and skips missed slots", () => {
    const next = nextScheduledRunAt(
      { type: "INTERVAL", intervalMinutes: 30, timezone: "UTC" },
      new Date("2026-07-15T13:16:00Z"),
      new Date("2026-07-15T12:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-07-15T13:30:00.000Z");
  });

  it("keeps daily wall-clock time across daylight-saving offsets", () => {
    const summer = nextScheduledRunAt(
      { type: "DAILY", timeOfDayMinutes: 9 * 60, timezone: "America/New_York" },
      new Date("2026-07-15T14:00:00Z"),
    );
    const winter = nextScheduledRunAt(
      { type: "DAILY", timeOfDayMinutes: 9 * 60, timezone: "America/New_York" },
      new Date("2026-12-15T15:00:00Z"),
    );
    expect(summer.toISOString()).toBe("2026-07-16T13:00:00.000Z");
    expect(winter.toISOString()).toBe("2026-12-16T14:00:00.000Z");
  });

  it("selects the earlier repeated time and advances nonexistent local times", () => {
    const repeated = zonedDateTimeToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      "America/New_York",
    );
    const missing = zonedDateTimeToUtc(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    );
    expect(repeated.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(missing.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("finds the next configured weekday", () => {
    const next = nextScheduledRunAt(
      {
        type: "WEEKLY",
        dayOfWeek: 1,
        timeOfDayMinutes: 8 * 60 + 15,
        timezone: "Europe/London",
      },
      new Date("2026-07-15T12:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-07-20T07:15:00.000Z");
  });

  it("rejects invalid timezone and interval inputs", () => {
    expect(() =>
      assertValidSchedule({ type: "INTERVAL", intervalMinutes: 1, timezone: "UTC" }),
    ).toThrow(/at least 5 minutes/i);
    expect(() =>
      assertValidSchedule({ type: "DAILY", timeOfDayMinutes: 300, timezone: "Mars/Olympus" }),
    ).toThrow(/valid IANA timezone/i);
  });
});
