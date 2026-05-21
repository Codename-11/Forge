"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Target } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { EmptyState, SkeletonList } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  GOAL_STATUS_TONE,
  GOAL_STATUSES,
  isGoalLive,
  type GoalStatus,
} from "@/components/orchestration-ui/status";
import { fmtUsd } from "@/components/orchestration-ui/budget-meter";
import { useGoalRouter, type GoalRow } from "@/components/orchestration-ui/use-goal-trpc";

type Filter = "all" | GoalStatus;

/**
 * Goals index. Lists orchestration goals with status, plan/step
 * progress, and budget burn. Filterable by status. Live goals (ACTIVE /
 * PLANNING) carry a soft pulse so the operator can spot them at a
 * glance.
 *
 * `goal.list` is shipped by the orchestration backend agent; until its
 * types regenerate we reach it through `useGoalRouter()` and degrade to
 * a "coming online" empty state if the procedure isn't present yet.
 */
export default function GoalsPage() {
  const ws = useWorkspace();
  const [filter, setFilter] = useState<Filter>("all");
  const goalRouter = useGoalRouter();

  const listQuery = goalRouter?.list?.useQuery(
    filter === "all" ? undefined : { status: filter },
    { staleTime: 15_000 },
  );
  const available = Boolean(goalRouter?.list);
  const data = listQuery?.data;
  const isLoading = available ? (listQuery?.isLoading ?? true) : false;

  const items = useMemo<GoalRow[]>(() => {
    if (!data) return [];
    return Array.isArray(data) ? data : (data.items ?? []);
  }, [data]);

  return (
    <>
      <Topbar
        title="Goals"
        subtitle={available && data ? `${items.length} goals` : undefined}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <FilterPill
            label="All"
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {GOAL_STATUSES.map((s) => (
            <FilterPill
              key={s}
              label={s.toLowerCase()}
              active={filter === s}
              onClick={() => setFilter(s)}
            />
          ))}
        </div>

        {!available ? (
          <EmptyState
            variant="page"
            icon={<Target />}
            title="Goals are coming online"
            description={
              <span>
                The orchestration backend isn&apos;t wired into this
                workspace yet. Once it is, goals you spin up with{" "}
                <span className="font-mono">/goal</span> from an issue
                will appear here with live plan progress and budget burn.
              </span>
            }
          />
        ) : isLoading ? (
          <SkeletonList rows={4} />
        ) : items.length === 0 ? (
          <EmptyState
            variant="page"
            icon={<Target />}
            title={filter === "all" ? "No goals yet" : `No ${filter.toLowerCase()} goals`}
            description={
              <span>
                A goal is a high-level objective an agent crew decomposes
                into an execution plan, then drives to completion. Type{" "}
                <span className="font-mono">/goal &lt;objective&gt;</span>{" "}
                in any issue&apos;s comment composer to create one.
              </span>
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {items.map((goal) => (
              <li key={goal.id}>
                <GoalCard goal={goal} slug={ws.slug} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border border-border px-2.5 py-1 text-xs capitalize transition",
        active
          ? "bg-subtle text-foreground"
          : "bg-card/40 text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function GoalCard({ goal, slug }: { goal: GoalRow; slug: string }) {
  const status = goal.status as GoalStatus;
  const live = isGoalLive(goal.status);

  // Roll up step progress across embedded plans if the backend includes
  // them; otherwise fall back to plan count.
  const { stepsDone, stepsTotal, planCount } = useMemo(() => {
    const plans = goal.plans ?? (goal.activePlan ? [goal.activePlan] : []);
    let done = 0;
    let total = 0;
    for (const p of plans) {
      const steps = p.steps ?? [];
      total += steps.length || p._count?.steps || 0;
      done += steps.filter((s) => s.status === "DONE").length;
    }
    return {
      stepsDone: done,
      stepsTotal: total,
      planCount: plans.length || goal._count?.plans || 0,
    };
  }, [goal]);

  const spent = goal.totalCostUsd ?? 0;
  const cap = goal.maxTotalCostUsd ?? null;
  const pct =
    typeof cap === "number" && cap > 0 ? Math.min((spent / cap) * 100, 100) : 0;

  return (
    <Link
      href={`/w/${slug}/goals/${goal.id}`}
      className={cn(
        "group flex h-full flex-col gap-2 rounded-lg border bg-card/40 p-3 transition hover:border-ember/40 hover:bg-subtle",
        live ? "border-ember/30" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-meta uppercase tracking-wide text-muted-foreground">
          <span className="relative inline-flex">
            <Target className="h-3 w-3" />
            {live ? (
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-ember motion-safe:animate-pulse" />
            ) : null}
          </span>
          Goal
        </div>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] uppercase",
            GOAL_STATUS_TONE[status] ?? "bg-subtle text-muted-foreground",
          )}
        >
          {goal.status.toLowerCase()}
        </span>
      </div>

      <div className="text-sm font-medium leading-snug text-foreground group-hover:text-ember">
        {goal.title}
      </div>
      {goal.description ? (
        <p className="line-clamp-2 text-meta text-muted-foreground">
          {goal.description}
        </p>
      ) : null}

      <div className="mt-auto flex flex-col gap-1.5 pt-1">
        {stepsTotal > 0 ? (
          <div className="flex h-1 w-full overflow-hidden rounded-full bg-subtle">
            <div
              className="h-full bg-emerald-700 transition-all duration-500"
              style={{ width: `${(stepsDone / stepsTotal) * 100}%` }}
            />
          </div>
        ) : null}
        <div className="flex items-center justify-between text-meta text-muted-foreground">
          <span>
            {stepsTotal > 0
              ? `${stepsDone}/${stepsTotal} steps`
              : `${planCount} plan${planCount === 1 ? "" : "s"}`}
          </span>
          <span
            className={cn(
              "font-mono tabular-nums",
              pct >= 100
                ? "text-danger"
                : pct >= 80
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
          >
            {fmtUsd(spent)}
            {typeof cap === "number" && cap > 0 ? ` / ${fmtUsd(cap)}` : ""}
          </span>
        </div>
      </div>
    </Link>
  );
}
