"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Target, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { CrewSelector } from "@/components/crews/crew-selector";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  GOAL_STATUS_TONE,
  GOAL_STATUSES,
  isGoalLive,
  type GoalStatus,
} from "@/components/orchestration-ui/status";
import { fmtUsd } from "@/components/orchestration-ui/budget-meter";
import { GoalLoopExplainer } from "@/components/orchestration/goal-loop-explainer";
import { trpc } from "@/lib/trpc";
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
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

  // Goal creation: the `goal.create` procedure is shipped by the
  // orchestration backend (reached via the guarded shim). The form lets
  // the operator assign a crew at creation time via CrewSelector — the
  // crew the loop dispatches steps to.
  const [creating, setCreating] = useState(false);

  // Auto-open the "New goal" modal when navigated with ?new (the
  // command palette "Create goal" action lands here).
  useEffect(() => {
    if (searchParams?.has("new")) {
      setCreating(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("new");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
  }, [searchParams, pathname, router]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [crewId, setCrewId] = useState<string | null>(null);
  const createGoal = goalRouter?.create?.useMutation({
    onSuccess: (result) => {
      toast.success("Goal created");
      setCreating(false);
      setTitle("");
      setDescription("");
      setCrewId(null);
      const goalUtils = (utils as unknown as { goal?: { list?: { invalidate?: () => void } } }).goal;
      goalUtils?.list?.invalidate?.();
      if (result?.id) router.push(`/w/${ws.slug}/goals/${result.id}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const canCreate = Boolean(goalRouter?.create);

  return (
    <>
      <Topbar
        title="Goals"
        subtitle={available && data ? `${items.length} goals` : undefined}
        actions={
          canCreate ? (
            <Button size="sm" variant="ember" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> New goal
            </Button>
          ) : undefined
        }
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
          <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-6">
            <EmptyState
              variant="page"
              icon={<Target />}
              title={filter === "all" ? "No goals yet" : `No ${filter.toLowerCase()} goals`}
              description={
                <span>
                  A goal is a high-level objective an agent crew drives to
                  completion on its own. Hit{" "}
                  <span className="font-medium text-foreground">New goal</span>{" "}
                  above, or type{" "}
                  <span className="font-mono">/goal &lt;objective&gt;</span> in
                  any issue&apos;s comment composer.
                </span>
              }
              action={
                canCreate ? (
                  <Button size="sm" variant="ember" onClick={() => setCreating(true)}>
                    <Plus className="h-3.5 w-3.5" /> New goal
                  </Button>
                ) : undefined
              }
            />
            <GoalLoopExplainer className="w-full" />
          </div>
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

      {creating && createGoal ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setCreating(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-medium">New goal</h2>
            <p className="mb-3 mt-1 text-meta text-muted-foreground">
              The crew&apos;s planner will decompose this into a plan you
              approve, then run and review it to completion on its own.
            </p>
            <label className="block text-meta text-muted-foreground">
              Objective
            </label>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Migrate auth to NextAuth v5"
              className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            />
            <label className="mt-3 block text-meta text-muted-foreground">
              Context for the planner (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Constraints, links, acceptance criteria…"
              className="mt-1 w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-meta"
            />
            <label className="mt-3 block text-meta text-muted-foreground">
              Crew that runs it
            </label>
            <CrewSelector
              className="mt-1"
              value={crewId}
              onChange={setCrewId}
              noneLabel="No crew (assign later)"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                variant="ember"
                size="sm"
                disabled={createGoal.isPending || !title.trim()}
                onClick={() =>
                  createGoal.mutate({
                    title: title.trim(),
                    description: description.trim() || null,
                    crewId: crewId ?? undefined,
                  })
                }
              >
                {createGoal.isPending ? "Creating…" : "Create goal"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
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

      {/* Crew + plan-count meta row */}
      <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
        <UsersRound className="h-3 w-3" />
        {goal.crew?.name ? (
          <>
            <span className="truncate">{goal.crew.name}</span>
            <span>·</span>
          </>
        ) : null}
        <span>
          {planCount} plan{planCount === 1 ? "" : "s"}
        </span>
        {stepsTotal > 0 ? (
          <>
            <span>·</span>
            <span>
              {stepsTotal} step{stepsTotal === 1 ? "" : "s"}
            </span>
          </>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-1">
        {/* Segmented step ladder — one segment per step. */}
        {stepsTotal > 0 ? (
          <div>
            <div className="flex items-center justify-between text-meta text-muted-foreground">
              <span>
                {stepsDone}/{stepsTotal} steps
              </span>
              <span className="tabular-nums">
                {Math.round((stepsDone / stepsTotal) * 100)}%
              </span>
            </div>
            <div className="mt-1 flex h-1.5 gap-px overflow-hidden rounded-full bg-subtle">
              {Array.from({ length: stepsTotal }).map((_, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "h-full flex-1",
                    idx < stepsDone
                      ? "bg-success"
                      : idx === stepsDone
                        ? "bg-ember"
                        : "bg-transparent",
                  )}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* Dedicated budget meter. */}
        {typeof cap === "number" && cap > 0 ? (
          <div>
            <div className="flex items-center justify-between text-meta text-muted-foreground">
              <span>Budget</span>
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
                {fmtUsd(spent)} / {fmtUsd(cap)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  pct >= 80 ? "bg-warning" : "bg-ember",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between text-meta text-muted-foreground">
            <span>Budget</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {fmtUsd(spent)}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}
