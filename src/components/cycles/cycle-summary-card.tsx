"use client";
import { CycleStatus } from "@prisma/client";
import { cn } from "@/lib/utils";
import {
  cycleProgress,
  daysRemaining,
  formatDateShort,
  isFinalDay,
  burndownSeries,
} from "@/lib/cycles";
import { Button } from "@/components/ui/button";
import { BurndownSparkline } from "./burndown-sparkline";

type CycleIssue = {
  id: string;
  createdAt: Date | string;
  completedAt?: Date | null | string;
  canceledAt?: Date | null | string;
  status: { category: string };
};

export function CycleSummaryCard({
  cycle,
  issues,
  onRollover,
  rolloverPending,
}: {
  cycle: {
    id: string;
    name: string;
    startsAt: Date | string;
    endsAt: Date | string;
    status: CycleStatus;
  };
  issues: CycleIssue[];
  onRollover?: () => void;
  rolloverPending?: boolean;
}) {
  const startsAt = new Date(cycle.startsAt);
  const endsAt = new Date(cycle.endsAt);
  const progress = cycleProgress(startsAt, endsAt);
  const remaining = daysRemaining(endsAt);
  const finalDay = isFinalDay(endsAt);
  const done = issues.filter(
    (i) => i.status.category === "DONE" || i.status.category === "CANCELED",
  ).length;
  const total = issues.length;
  const completion = total === 0 ? 0 : done / total;
  const series = burndownSeries(startsAt, endsAt, issues);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              cycle.status === CycleStatus.ACTIVE
                ? "bg-ember"
                : cycle.status === CycleStatus.COMPLETED
                  ? "bg-success"
                  : "bg-muted",
            )}
          />
          <h2 className="text-sm font-semibold">{cycle.name}</h2>
          <span className="font-mono text-[10px] text-muted-foreground">
            {cycle.status}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatDateShort(startsAt)} → {formatDateShort(endsAt)}
          <span className="mx-1.5">·</span>
          <span className={cn(finalDay && "text-ember")}>
            {remaining === 0 ? "ended" : `${remaining}d remaining`}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-[11px]">
          <Stat label="Issues" value={total} />
          <Stat label="Done" value={done} />
          <Stat
            label="Completion"
            value={`${Math.round(completion * 100)}%`}
          />
        </div>
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-subtle">
          <div
            className="h-full rounded-full bg-ember transition-[width]"
            style={{ width: `${progress * 100}%` }}
            aria-label={`Timeline ${Math.round(progress * 100)}%`}
          />
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <BurndownSparkline actual={series.actual} ideal={series.ideal} />
        {onRollover && finalDay && cycle.status === CycleStatus.ACTIVE && (
          <Button
            size="sm"
            variant="ember"
            onClick={onRollover}
            disabled={rolloverPending}
          >
            {rolloverPending ? "Rolling over…" : "Rollover to next cycle"}
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}
