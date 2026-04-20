/**
 * Cycle helpers — date math + simple burndown series derivation.
 *
 * Kept pure (no `Date.now()` default) so tests and SSR stay deterministic
 * when a reference instant is passed explicitly. All math is UTC-day based
 * to match how the cycle router stores `startsAt`/`endsAt`.
 */

const MS_PER_DAY = 86_400_000;

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

export function daysRemaining(endsAt: Date, now: Date = new Date()): number {
  const remaining = Math.ceil((endsAt.getTime() - now.getTime()) / MS_PER_DAY);
  return Math.max(remaining, 0);
}

export function isFinalDay(endsAt: Date, now: Date = new Date()): boolean {
  const remaining = daysRemaining(endsAt, now);
  return remaining <= 1 && endsAt.getTime() > now.getTime();
}

export function cycleProgress(
  startsAt: Date,
  endsAt: Date,
  now: Date = new Date(),
): number {
  const total = endsAt.getTime() - startsAt.getTime();
  if (total <= 0) return 1;
  const elapsed = now.getTime() - startsAt.getTime();
  return Math.max(0, Math.min(1, elapsed / total));
}

export function formatDateShort(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * Derive a burndown series from a list of issues. We infer per-day
 * remaining counts by walking day buckets between `startsAt` and `endsAt`
 * and counting how many issues had *not yet* reached a DONE/CANCELED
 * `completedAt`/`canceledAt` on that day.
 *
 * This is intentionally simple (no ActivityEvent replay) — good enough for
 * the sparkline and cheap to compute client-side.
 */
export function burndownSeries(
  startsAt: Date,
  endsAt: Date,
  issues: Array<{
    createdAt: Date | string;
    completedAt?: Date | null | string;
    canceledAt?: Date | null | string;
  }>,
  now: Date = new Date(),
): { actual: number[]; ideal: number[]; totalScope: number } {
  const start = new Date(startsAt);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(endsAt);
  end.setUTCHours(0, 0, 0, 0);
  const days = Math.max(1, daysBetween(start, end));

  const totalScope = issues.length;
  const actual: number[] = [];
  const ideal: number[] = [];

  for (let i = 0; i <= days; i++) {
    const dayCutoff = new Date(start.getTime() + i * MS_PER_DAY);
    dayCutoff.setUTCHours(23, 59, 59, 999);

    // Only count up to today — future days should trail off as "unknown"
    // and aren't plotted. We still push a null-ish zero so the sparkline
    // has a consistent length, but callers can truncate with `now`.
    if (dayCutoff > now) {
      actual.push(NaN);
    } else {
      const remaining = issues.reduce((acc, issue) => {
        const done = issue.completedAt
          ? new Date(issue.completedAt)
          : issue.canceledAt
            ? new Date(issue.canceledAt)
            : null;
        if (done && done <= dayCutoff) return acc;
        return acc + 1;
      }, 0);
      actual.push(remaining);
    }
    ideal.push(totalScope - (i / days) * totalScope);
  }

  return { actual, ideal, totalScope };
}
