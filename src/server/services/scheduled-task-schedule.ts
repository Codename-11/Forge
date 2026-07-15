export type ScheduledTaskSchedule =
  | { type: "INTERVAL"; intervalMinutes: number; timezone: string }
  | { type: "DAILY"; timeOfDayMinutes: number; timezone: string }
  | {
      type: "WEEKLY";
      timeOfDayMinutes: number;
      dayOfWeek: number;
      timezone: string;
    };

type WallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function assertValidSchedule(schedule: ScheduledTaskSchedule): void {
  if (!isValidTimeZone(schedule.timezone)) {
    throw new Error("Enter a valid IANA timezone, such as America/New_York.");
  }
  if (schedule.type === "INTERVAL") {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 5) {
      throw new Error("Interval schedules must run at least 5 minutes apart.");
    }
    if (schedule.intervalMinutes > 525_600) {
      throw new Error("Interval schedules cannot exceed one year.");
    }
    return;
  }
  if (
    !Number.isInteger(schedule.timeOfDayMinutes) ||
    schedule.timeOfDayMinutes < 0 ||
    schedule.timeOfDayMinutes > 1_439
  ) {
    throw new Error("Time of day must be between 00:00 and 23:59.");
  }
  if (
    schedule.type === "WEEKLY" &&
    (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)
  ) {
    throw new Error("Weekday must be between Sunday and Saturday.");
  }
}

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, value);
  }
  return value;
}

function wallParts(date: Date, timezone: string): WallParts {
  const parts = formatter(timezone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function wallSerial(parts: WallParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function sameWall(a: WallParts, b: WallParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * Resolve a local wall-clock instant without relying on the host timezone.
 * Ambiguous fall-back times select the earlier occurrence. A nonexistent
 * spring-forward time advances to the first valid minute after the gap.
 */
export function zonedDateTimeToUtc(parts: WallParts, timezone: string): Date {
  const desired = wallSerial(parts);
  const sampleInstants = [desired - 172_800_000, desired, desired + 172_800_000];
  const offsets = new Set(
    sampleInstants.map((instant) => {
      const date = new Date(instant);
      return wallSerial(wallParts(date, timezone)) - instant;
    }),
  );
  const guesses = [...offsets].map((offset) => desired - offset);
  const exact = guesses
    .filter((instant) => sameWall(wallParts(new Date(instant), timezone), parts))
    .sort((a, b) => a - b);
  if (exact.length) return new Date(exact[0]);

  // DST gaps have no exact instant. Search around the offset-derived guesses
  // and choose the nearest later local minute on the requested calendar day.
  const start = Math.min(...guesses) - 180 * 60_000;
  const end = Math.max(...guesses) + 180 * 60_000;
  let best: { instant: number; delta: number } | null = null;
  for (let instant = start; instant <= end; instant += 60_000) {
    const candidate = wallParts(new Date(instant), timezone);
    if (
      candidate.year !== parts.year ||
      candidate.month !== parts.month ||
      candidate.day !== parts.day
    ) {
      continue;
    }
    const delta = wallSerial(candidate) - desired;
    if (
      delta >= 0 &&
      (!best || delta < best.delta || (delta === best.delta && instant < best.instant))
    ) {
      best = { instant, delta };
    }
  }
  if (best) return new Date(best.instant);

  // Defensive fallback for historical timezone oddities beyond the sampled
  // offset window. This remains deterministic and future-facing.
  return new Date(Math.max(...guesses));
}

function addCalendarDays(parts: Pick<WallParts, "year" | "month" | "day">, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Return the first occurrence strictly after `after`. */
export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  after: Date,
  intervalAnchor?: Date,
): Date {
  assertValidSchedule(schedule);
  if (schedule.type === "INTERVAL") {
    const step = schedule.intervalMinutes * 60_000;
    const anchor = intervalAnchor?.getTime() ?? after.getTime();
    const elapsed = after.getTime() - anchor;
    const steps = elapsed >= 0 ? Math.floor(elapsed / step) + 1 : 0;
    return new Date(anchor + steps * step);
  }

  const local = wallParts(after, schedule.timezone);
  const hour = Math.floor(schedule.timeOfDayMinutes / 60);
  const minute = schedule.timeOfDayMinutes % 60;
  let date = { year: local.year, month: local.month, day: local.day };

  if (schedule.type === "WEEKLY") {
    const currentDay = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    const delta = (schedule.dayOfWeek - currentDay + 7) % 7;
    date = addCalendarDays(date, delta);
  }

  let candidate = zonedDateTimeToUtc({ ...date, hour, minute }, schedule.timezone);
  if (candidate.getTime() <= after.getTime()) {
    date = addCalendarDays(date, schedule.type === "DAILY" ? 1 : 7);
    candidate = zonedDateTimeToUtc({ ...date, hour, minute }, schedule.timezone);
  }
  return candidate;
}

export function scheduleFromTask(task: {
  scheduleType: "INTERVAL" | "DAILY" | "WEEKLY";
  intervalMinutes: number | null;
  timeOfDayMinutes: number | null;
  dayOfWeek: number | null;
  timezone: string;
}): ScheduledTaskSchedule {
  if (task.scheduleType === "INTERVAL") {
    return {
      type: "INTERVAL",
      intervalMinutes: task.intervalMinutes ?? 0,
      timezone: task.timezone,
    };
  }
  if (task.scheduleType === "DAILY") {
    return {
      type: "DAILY",
      timeOfDayMinutes: task.timeOfDayMinutes ?? -1,
      timezone: task.timezone,
    };
  }
  return {
    type: "WEEKLY",
    timeOfDayMinutes: task.timeOfDayMinutes ?? -1,
    dayOfWeek: task.dayOfWeek ?? -1,
    timezone: task.timezone,
  };
}
