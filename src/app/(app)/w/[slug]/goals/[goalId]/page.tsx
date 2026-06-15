"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Ban, ChevronLeft, ExternalLink, ListChecks, Target } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import {
  GOAL_STATUS_TONE,
  isGoalLive,
  type GoalStatus,
} from "@/components/orchestration-ui/status";
import { BudgetMeter } from "@/components/orchestration/budget-meter";
import { GoalLoopExplainerCollapsible } from "@/components/orchestration/goal-loop-explainer";
import {
  CrewRosterPanel,
  type CrewRosterData,
} from "@/components/orchestration/crew-roster-panel";
import {
  useGoalRouter,
  type GoalPlanRow,
} from "@/components/orchestration-ui/use-goal-trpc";

const STEP_DONE = "DONE";

/**
 * Goal detail — the orchestration objective view. Shows the goal's
 * status + description, a budget meter, the active plan (compact step
 * rollup with a deep-link to the plan cockpit), and attempt history
 * when the crew has retried with multiple plans. Auto-refreshes on
 * `goal` / `execution-plan` / `execution-step` / `agent-run` realtime
 * events so a running goal stays live without a manual reload.
 */
export default function GoalDetailPage() {
  const params = useParams<{ slug: string; goalId: string }>();
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const goalRouter = useGoalRouter();

  const available = Boolean(goalRouter?.get);
  const query = goalRouter?.get?.useQuery(
    { id: params.goalId },
    { staleTime: 10_000 },
  );
  const goal = query?.data;
  const isLoading = available ? (query?.isLoading ?? true) : false;

  // Reactivity: any orchestration event invalidates the goal so the
  // page repaints with fresh plan/step/budget state. The `goal` router
  // isn't on the typed utils proxy yet, so invalidate through a guarded
  // cast (same degrade pattern as the query accessor).
  useRealtime(
    () => {
      const u = utils as unknown as {
        goal?: { get?: { invalidate?: (i: { id: string }) => void } };
      };
      u.goal?.get?.invalidate?.({ id: params.goalId });
    },
    {
      subjectType: ["goal", "execution-plan", "execution-step", "agent-run"],
    },
  );

  const abandonM = goalRouter?.abandon?.useMutation({
    onSuccess: () => {
      toast.success("Goal abandoned");
      const u = utils as unknown as {
        goal?: { get?: { invalidate?: (i: { id: string }) => void } };
      };
      u.goal?.get?.invalidate?.({ id: params.goalId });
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const decomposeM = goalRouter?.decompose?.useMutation({
    onSuccess: (result) => {
      toast.success(
        result.plannerAgentId
          ? "Planner started — drafting the execution plan."
          : "Plan draft is live; assign a planner to continue.",
      );
      const u = utils as unknown as {
        goal?: { get?: { invalidate?: (i: { id: string }) => void } };
      };
      u.goal?.get?.invalidate?.({ id: params.goalId });
    },
    onError: (e: { message: string }) => toast.error(`Planning: ${e.message}`),
  });

  const [confirmAbandon, setConfirmAbandon] = useState(false);

  if (!available) {
    return (
      <>
        <Topbar title="Goal" />
        <div className="p-4">
          <EmptyState
            variant="page"
            icon={<Target />}
            title="Goals are coming online"
            description="The orchestration backend isn't wired into this workspace yet."
          />
        </div>
      </>
    );
  }

  if (isLoading) {
    return (
      <>
        <Topbar title="Goal" />
        <div className="p-4">
          <SkeletonList rows={5} />
        </div>
      </>
    );
  }

  if (!goal) {
    return (
      <>
        <Topbar title="Goal" />
        <div className="p-4">
          <EmptyState
            variant="page"
            title="Goal not found"
            description="This goal may have been abandoned or removed."
          />
        </div>
      </>
    );
  }

  const status = goal.status as GoalStatus;
  const live = isGoalLive(goal.status);
  const plans = (goal.plans ?? []).slice();
  const activePlan =
    goal.activePlan ??
    plans.find((p) => p.isActiveAttempt) ??
    plans[0] ??
    null;
  const priorAttempts = plans.filter((p) => p.id !== activePlan?.id);

  const canAbandon = goal.status !== "ACHIEVED" && goal.status !== "ABANDONED";
  const canStartPlanning = goal.status === "OPEN" && Boolean(decomposeM);
  const elapsedMinutes = goal.startedAt
    ? (Date.now() - new Date(goal.startedAt).getTime()) / 60_000
    : null;

  return (
    <>
      <Topbar
        title={goal.title}
        subtitle={`Goal · ${goal.status.toLowerCase()}`}
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => router.push(`/w/${ws.slug}/goals`)}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Back
          </Button>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_300px]">
        <section className="flex min-w-0 flex-col gap-4">
          <header className="rounded-lg border border-border bg-card/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex">
                  <Target className="h-4 w-4 text-muted-foreground" />
                  {live ? (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-ember motion-safe:animate-pulse" />
                  ) : null}
                </span>
                <h1 className="text-lg font-medium leading-snug">{goal.title}</h1>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded px-2 py-0.5 text-[10px] uppercase",
                  GOAL_STATUS_TONE[status] ?? "bg-subtle text-muted-foreground",
                )}
              >
                {goal.status.toLowerCase()}
              </span>
            </div>
            {goal.issue ? (
              <Link
                href={`/w/${ws.slug}/issues/${goal.issue.id}`}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 text-meta text-muted-foreground transition hover:border-ember/40 hover:text-ember"
              >
                <ListChecks className="h-3 w-3" />
                From issue {ws.key}-{goal.issue.number}
                <span className="truncate">· {goal.issue.title}</span>
              </Link>
            ) : null}
            {goal.description ? (
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {goal.description}
              </p>
            ) : null}
            <GoalLoopExplainerCollapsible className="mt-3" />
          </header>

          {/* Active attempt */}
          {activePlan ? (
            <PlanAttemptCard
              plan={activePlan}
              slug={ws.slug}
              isActive
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-card/20 p-4 text-meta text-muted-foreground">
              <div>
                {goal.status === "OPEN"
                  ? "No plan is running yet. Start the planner to create a live draft and dispatch feedback."
                  : "No plan yet. A planner agent will decompose this goal into an execution plan."}
              </div>
              {canStartPlanning ? (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="ember"
                  disabled={decomposeM?.isPending}
                  onClick={() => decomposeM?.mutate({ goalId: goal.id })}
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  {decomposeM?.isPending ? "Starting planner…" : "Start planner"}
                </Button>
              ) : null}
            </div>
          )}

          {/* Attempt history */}
          {priorAttempts.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="text-meta uppercase tracking-wide text-muted-foreground">
                Earlier attempts ({priorAttempts.length})
              </div>
              {priorAttempts.map((p) => (
                <PlanAttemptCard key={p.id} plan={p} slug={ws.slug} />
              ))}
            </div>
          ) : null}
        </section>

        <aside className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-card/40 p-3">
            <BudgetMeter
              spent={goal.totalCostUsd ?? 0}
              cap={goal.maxTotalCostUsd}
              wallTimeMinutes={goal.maxWallTimeMinutes}
              elapsedMinutes={elapsedMinutes}
            />
          </div>

          <CrewRosterPanel
            crew={(goal.crew ?? null) as CrewRosterData | null}
          />

          <div className="rounded-lg border border-border bg-card/40 p-3 text-meta">
            <div className="mb-2 uppercase tracking-wide text-muted-foreground">
              Details
            </div>
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row label="Plans" value={`${plans.length}`} />
              {goal.startedAt ? (
                <Row
                  label="Started"
                  value={new Date(goal.startedAt).toLocaleString()}
                />
              ) : null}
              {goal.achievedAt ? (
                <Row
                  label="Achieved"
                  value={new Date(goal.achievedAt).toLocaleString()}
                />
              ) : null}
            </dl>
          </div>

          {canAbandon ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-warning"
              onClick={() => setConfirmAbandon(true)}
              disabled={abandonM?.isPending}
            >
              <Ban className="h-3.5 w-3.5" /> Abandon goal
            </Button>
          ) : null}
        </aside>
      </div>

      <Confirm
        open={confirmAbandon}
        onOpenChange={(o) => {
          if (!o) setConfirmAbandon(false);
        }}
        title="Abandon goal?"
        description="The goal is marked ABANDONED and its crew stops working on it. This can't be undone."
        primaryLabel="Abandon goal"
        variant="destructive"
        loading={abandonM?.isPending}
        onConfirm={() => {
          abandonM?.mutate({ id: goal.id });
          setConfirmAbandon(false);
        }}
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

const PLAN_STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-subtle text-muted-foreground",
  APPROVED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  COMPLETED: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

function PlanAttemptCard({
  plan,
  slug,
  isActive,
}: {
  plan: GoalPlanRow;
  slug: string;
  isActive?: boolean;
}) {
  const steps = plan.steps ?? [];
  const total = steps.length || plan._count?.steps || 0;
  const done = steps.filter((s) => s.status === STEP_DONE).length;
  const running = isActive && plan.status === "RUNNING";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card/40 p-3 transition-all duration-300",
        running ? "border-ember/40 ring-1 ring-ember/20" : "border-border",
        !isActive && "opacity-80",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <a
          href={`/w/${slug}/plans/${plan.id}`}
          className="group flex min-w-0 flex-1 items-center gap-2"
        >
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium group-hover:text-ember">
            {plan.title}
          </span>
        </a>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase",
            PLAN_STATUS_TONE[plan.status] ?? "bg-subtle text-muted-foreground",
          )}
        >
          {plan.status.toLowerCase()}
        </span>
      </div>

      {total > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-subtle">
            <div
              className="h-full bg-emerald-700 transition-all duration-500"
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
          <div className="text-meta text-muted-foreground">
            {done}/{total} steps done
          </div>
        </div>
      ) : null}

      <a
        href={`/w/${slug}/plans/${plan.id}`}
        className="mt-2 inline-flex items-center gap-1 text-meta text-ember hover:underline"
      >
        Open plan cockpit <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
