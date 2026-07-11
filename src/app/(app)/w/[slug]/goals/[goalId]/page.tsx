"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  Ban,
  ChevronLeft,
  Clock3,
  ExternalLink,
  ListChecks,
  Pencil,
  Play,
  Send,
  Sparkles,
  Target,
} from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Combobox } from "@/components/ui/combobox";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
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
  type ActiveStepByAgent,
  type CrewRosterData,
} from "@/components/orchestration/crew-roster-panel";
import {
  RunAttentionPanel,
  pickAttentionRun,
} from "@/components/orchestration/run-attention-panel";
import {
  RunOperationalStatus,
  deriveRunOperationalState,
  type RunOperationalState,
  useOperationalClock,
} from "@/components/orchestration/run-operational-status";
import {
  useGoalRouter,
  type GoalPlanRow,
  type GoalPlannerInfo,
  type GoalStepRun,
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
  const operationalNow = useOperationalClock();
  const goalRouter = useGoalRouter();

  const available = Boolean(goalRouter?.get);
  const query = goalRouter?.get?.useQuery({ id: params.goalId }, { staleTime: 10_000 });
  const { data: crewList } = trpc.agentCrew.list.useQuery({});
  const goal = query?.data;
  const isLoading = available ? (query?.isLoading ?? true) : false;
  // A fetch failure must not read as "Goal not found — abandoned or removed".
  const isError = available ? (query?.isError ?? false) : false;

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

  const updateM = goalRouter?.update?.useMutation({
    onSuccess: () => {
      toast.success("Goal updated");
      invalidateGoal();
      const u = utils as unknown as {
        goal?: { list?: { invalidate?: () => void } };
      };
      u.goal?.list?.invalidate?.();
      setEditingGoal(false);
    },
    // Errors surface in the GoalEditModal QuickForm banner (onSave awaits
    // mutateAsync); the modal stays open for a retry.
  });

  const activatePlanM = trpc.executionPlan.activate.useMutation({
    onSuccess: () => {
      toast.success("Crew started");
      invalidateGoal();
      utils.executionPlan.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const invalidateGoal = () => {
    const u = utils as unknown as {
      goal?: { get?: { invalidate?: (i: { id: string }) => void } };
    };
    u.goal?.get?.invalidate?.({ id: params.goalId });
  };

  // Result of the most recent "Dispatch to crew planner" — drives the
  // reachability banner so the operator isn't left staring at an empty plan.
  const [dispatchResult, setDispatchResult] = useState<{
    planner: GoalPlannerInfo | null;
    dispatchable: boolean;
  } | null>(null);

  const decomposeM = goalRouter?.decompose?.useMutation({
    onSuccess: (result) => {
      setDispatchResult({
        planner: result.planner,
        dispatchable: result.dispatchable,
      });
      if (result.dispatchable && result.planner) {
        toast.success(`Dispatched to ${result.planner.name} — awaiting steps.`);
      } else {
        toast.warning("Plan draft created, but no planner could be reached.");
      }
      invalidateGoal();
    },
    onError: (e: { message: string }) => toast.error(`Dispatch: ${e.message}`),
  });

  const generatePlanM = goalRouter?.generatePlan?.useMutation({
    onSuccess: (result) => {
      setDispatchResult(null);
      toast.success(
        `Plan generated · ${result.stepCount} step${result.stepCount === 1 ? "" : "s"}.`,
      );
      invalidateGoal();
    },
    onError: (e: { message: string }) => toast.error(`Generate: ${e.message}`),
  });

  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [editingGoal, setEditingGoal] = useState(false);

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

  if (isError) {
    return (
      <>
        <Topbar title="Goal" />
        <div className="p-4">
          <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-6">
            <EmptyState
              variant="page"
              title="Couldn't load this goal"
              description="Something went wrong fetching it — this is a load error, not a deletion. The goal is still there."
            />
            <Button size="sm" variant="outline" onClick={() => query?.refetch()}>
              Retry
            </Button>
          </div>
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
  const activePlan = goal.activePlan ?? plans.find((p) => p.isActiveAttempt) ?? plans[0] ?? null;
  const priorAttempts = plans.filter((p) => p.id !== activePlan?.id);

  const canAbandon = goal.status !== "ACHIEVED" && goal.status !== "ABANDONED";
  const canPlan = goal.status !== "ACHIEVED" && goal.status !== "ABANDONED";
  const activeStepCount = activePlan?.steps?.length ?? activePlan?._count?.steps ?? 0;
  const attention = activePlan
    ? pickAttentionRun(
        (activePlan.steps ?? []).map((step) => ({
          ...step,
          title: step.title ?? "Step",
        })),
      )
    : null;
  const activePlanEmpty = !!activePlan && activePlan.status === "DRAFT" && activeStepCount === 0;
  // Offer the planner actions whenever there's nothing to run yet: no active
  // plan, or an active plan still sitting as an empty DRAFT (the bug the user
  // hit). A plan with steps hides the panel.
  const needsPlanner = canPlan && (!activePlan || activePlanEmpty);
  const elapsedMinutes = goal.startedAt
    ? (Date.now() - new Date(goal.startedAt).getTime()) / 60_000
    : null;
  const activeByAgent: ActiveStepByAgent = new Map();
  for (const step of activePlan?.steps ?? []) {
    const run = step.runs?.[0] ?? step.issue?.agentRuns?.[0] ?? null;
    const agentId = run?.agentId ?? step.assignedAgentId;
    const operational = deriveRunOperationalState(run, step.status, operationalNow);
    if (agentId && (operational.live || operational.phase === "WAITING")) {
      activeByAgent.set(agentId, {
        id: step.id,
        title: step.title ?? "Step",
        status: operational.label,
      });
    } else if (step.assignedAgentId && step.status === "READY") {
      activeByAgent.set(step.assignedAgentId, {
        id: step.id,
        title: step.title ?? "Step",
        status: "Queued",
      });
    }
  }
  const operationalRows = (activePlan?.steps ?? []).map((step) => {
    const run = step.runs?.[0] ?? step.issue?.agentRuns?.[0] ?? null;
    return {
      step,
      run,
      state: deriveRunOperationalState(run, step.status, operationalNow),
    };
  });
  const workingRows = operationalRows.filter((row) => row.state.live && !row.state.needsAttention);
  const attentionRows = operationalRows.filter((row) => row.state.needsAttention);
  const nextRows = operationalRows.filter(
    (row) => row.state.phase === "QUEUED" && row.step.status !== "DONE",
  );
  const latestGoalActivity = operationalRows
    .map((row) => row.run?.lastEventAt)
    .filter((value): value is string | Date => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  return (
    <>
      <Topbar
        title={goal.title}
        subtitle={`Goal · ${goal.status.toLowerCase()}`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => router.push(`/w/${ws.slug}/goals`)}>
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </Button>
            {canPlan ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditingGoal(true)}
                disabled={!updateM}
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_300px]">
        <section className="flex min-w-0 flex-col gap-4">
          {goal.operating &&
          ["NEEDS_REVIEW", "BLOCKED", "WAITING_REVIEW"].includes(goal.operating.health) ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-warning">
                  <AlertTriangle className="h-4 w-4" />
                  {goal.operating.health.replaceAll("_", " ").toLowerCase()}
                </div>
                <p className="text-meta mt-1 text-muted-foreground">{goal.operating.nextAction}</p>
              </div>
              {goal.operating.pendingGates?.length ? (
                <Link
                  href={`/w/${ws.slug}/review`}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-card/40 px-3 text-xs font-medium transition hover:border-ember/40 hover:text-ember"
                >
                  Review now
                </Link>
              ) : goal.operating.focusStep && activePlan ? (
                <Link
                  href={`/w/${ws.slug}/plans/${activePlan.id}#step-${goal.operating.focusStep.id}`}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-card/40 px-3 text-xs font-medium transition hover:border-ember/40 hover:text-ember"
                >
                  Open step
                </Link>
              ) : null}
            </div>
          ) : null}
          <GoalOperationsSummary
            working={workingRows.length}
            needsYou={attentionRows.length}
            queued={nextRows.length}
            activeAgents={activeByAgent.size}
            latestActivity={latestGoalActivity ?? null}
          />
          <header className="rounded-lg border border-border bg-card/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex">
                  <Target className="h-4 w-4 text-muted-foreground" />
                  {live ? (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-ember motion-safe:animate-pulse" />
                  ) : null}
                </span>
                <h1 className="text-base font-semibold leading-snug">{goal.title}</h1>
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
                className="text-meta mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 text-muted-foreground transition hover:border-ember/40 hover:text-ember"
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
            {goal.successCriteria ? (
              <div className="mt-3 rounded-md border border-border bg-background/30 p-3">
                <div className="text-meta mb-1 font-medium uppercase tracking-wide text-muted-foreground">
                  Success criteria
                </div>
                <p className="whitespace-pre-wrap text-sm">{goal.successCriteria}</p>
              </div>
            ) : null}
            {goal.outcomeSummary ? (
              <div className="mt-3 rounded-md border border-success/30 bg-success/5 p-3">
                <div className="text-meta mb-1 font-medium uppercase tracking-wide text-success">
                  Outcome
                </div>
                <p className="whitespace-pre-wrap text-sm">{goal.outcomeSummary}</p>
              </div>
            ) : null}
            <GoalLoopExplainerCollapsible className="mt-3" />
          </header>

          {activePlan && operationalRows.length > 0 ? (
            <GoalOperationsBoard
              planId={activePlan.id}
              slug={ws.slug}
              working={workingRows}
              attention={attentionRows}
              next={nextRows}
            />
          ) : null}

          {/* Active attempt */}
          {activePlan ? (
            <PlanAttemptCard
              plan={activePlan}
              slug={ws.slug}
              isActive
              onStart={
                activePlan.status === "APPROVED"
                  ? () => activatePlanM.mutate({ id: activePlan.id })
                  : undefined
              }
              starting={activatePlanM.isPending}
            />
          ) : null}

          {attention ? (
            <RunAttentionPanel
              run={attention.run}
              step={{
                id: attention.step.id,
                title: attention.step.title,
                status: attention.step.status,
                issue: attention.step.issue ?? attention.run.issue ?? null,
              }}
              workspaceSlug={ws.slug}
              workspaceKey={ws.key}
              onChanged={invalidateGoal}
            />
          ) : null}

          {/* Planner actions — shown when there's nothing to run yet (no plan,
              or an empty DRAFT no one filled). Offers Forge's built-in
              generator and a dispatch to the crew's planner, and surfaces the
              dispatch outcome so an unreachable planner isn't a silent dead end. */}
          {needsPlanner ? (
            <PlannerPanel
              hasEmptyDraft={activePlanEmpty}
              activePlanId={activePlan?.id ?? null}
              slug={ws.slug}
              dispatchResult={dispatchResult}
              canGenerate={Boolean(generatePlanM)}
              canDispatch={Boolean(decomposeM)}
              generating={Boolean(generatePlanM?.isPending)}
              dispatching={Boolean(decomposeM?.isPending)}
              onGenerate={() => generatePlanM?.mutate({ goalId: goal.id })}
              onDispatch={() => decomposeM?.mutate({ goalId: goal.id })}
            />
          ) : null}

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
          <GoalLiveStatus
            goalStatus={goal.status}
            plan={activePlan}
            elapsedMinutes={elapsedMinutes}
            onStart={
              activePlan?.status === "APPROVED"
                ? () => activatePlanM.mutate({ id: activePlan.id })
                : undefined
            }
            starting={activatePlanM.isPending}
          />

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
            activeByAgent={activeByAgent}
          />

          {goal.operating?.outputs?.length ? (
            <div className="rounded-lg border border-border bg-card/40 p-3">
              <div className="text-meta mb-2 uppercase tracking-wide text-muted-foreground">
                Outputs ({goal.operating.outputs.length})
              </div>
              <div className="flex flex-col gap-1">
                {goal.operating.outputs.slice(0, 6).map((output) => (
                  <Link
                    key={output.id}
                    href={`/w/${ws.slug}/artifacts/${output.slug}`}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-subtle hover:text-ember"
                  >
                    <span className="truncate">{output.title}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          {goal.operating?.recentDecisions?.length ? (
            <div className="rounded-lg border border-border bg-card/40 p-3">
              <div className="text-meta mb-2 uppercase tracking-wide text-muted-foreground">
                Recent decisions
              </div>
              <div className="flex flex-col gap-2">
                {goal.operating.recentDecisions.slice(0, 5).map((decision) => (
                  <div key={decision.id} className="text-meta border-l border-border pl-2">
                    <div className="font-medium text-foreground">
                      {decision.status.toLowerCase()} · {decision.prompt}
                    </div>
                    {decision.resolution ? (
                      <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                        {decision.resolution}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="text-meta rounded-lg border border-border bg-card/40 p-3">
            <div className="mb-2 uppercase tracking-wide text-muted-foreground">Details</div>
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row label="Plans" value={`${plans.length}`} />
              {goal.startedAt ? (
                <Row label="Started" value={new Date(goal.startedAt).toLocaleString()} />
              ) : null}
              {goal.achievedAt ? (
                <Row label="Achieved" value={new Date(goal.achievedAt).toLocaleString()} />
              ) : null}
              {goal.targetDate ? (
                <Row label="Target" value={new Date(goal.targetDate).toLocaleDateString()} />
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

      {editingGoal ? (
        <GoalEditModal
          goal={goal}
          crews={crewList?.items ?? []}
          busy={Boolean(updateM?.isPending)}
          onClose={() => setEditingGoal(false)}
          onSave={async (payload) => {
            await updateM?.mutateAsync({
              id: goal.id,
              ...payload,
            });
          }}
        />
      ) : null}
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

type GoalOperationalRow = {
  step: NonNullable<GoalPlanRow["steps"]>[number];
  run: GoalStepRun | null;
  state: RunOperationalState;
};

function GoalOperationsSummary({
  working,
  needsYou,
  queued,
  activeAgents,
  latestActivity,
}: {
  working: number;
  needsYou: number;
  queued: number;
  activeAgents: number;
  latestActivity: string | Date | null;
}) {
  const cells = [
    { label: "Agents active", value: activeAgents, tone: "text-ember" },
    { label: "Working now", value: working, tone: "text-ember" },
    {
      label: "Needs you",
      value: needsYou,
      tone: needsYou > 0 ? "text-warning" : "text-muted-foreground",
    },
    { label: "Queued", value: queued, tone: "text-muted-foreground" },
  ];
  return (
    <section
      aria-label="Live goal operations"
      className="rounded-lg border border-border bg-card/40"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="relative flex h-2 w-2">
            {working > 0 ? (
              <span className="absolute inline-flex h-full w-full rounded-full bg-ember opacity-50 motion-safe:animate-ping" />
            ) : null}
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                working > 0 ? "bg-ember" : "bg-muted-foreground/40",
              )}
            />
          </span>
          Goal operations
        </div>
        <span className="text-meta text-muted-foreground">
          {latestActivity ? `last activity ${relativeTime(latestActivity)}` : "no run activity yet"}
        </span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
        {cells.map((cell) => (
          <div key={cell.label} className="px-3 py-2.5">
            <div className={cn("font-mono text-lg tabular-nums", cell.tone)}>{cell.value}</div>
            <div className="text-meta text-muted-foreground">{cell.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GoalOperationsBoard({
  planId,
  slug,
  working,
  attention,
  next,
}: {
  planId: string;
  slug: string;
  working: GoalOperationalRow[];
  attention: GoalOperationalRow[];
  next: GoalOperationalRow[];
}) {
  return (
    <section className="grid grid-cols-1 gap-3 xl:grid-cols-3" aria-label="Goal work lanes">
      <GoalOperationsLane
        title="Working now"
        description="Fresh agent activity"
        rows={working}
        empty="No agents are actively producing output."
        planId={planId}
        slug={slug}
      />
      <GoalOperationsLane
        title="Needs you"
        description="Review, waiting, or stalled"
        rows={attention}
        empty="Nothing currently needs operator attention."
        planId={planId}
        slug={slug}
        attention
      />
      <GoalOperationsLane
        title="Up next"
        description="Queued or dependency-bound"
        rows={next}
        empty="No additional work is queued."
        planId={planId}
        slug={slug}
      />
    </section>
  );
}

function GoalOperationsLane({
  title,
  description,
  rows,
  empty,
  planId,
  slug,
  attention = false,
}: {
  title: string;
  description: string;
  rows: GoalOperationalRow[];
  empty: string;
  planId: string;
  slug: string;
  attention?: boolean;
}) {
  const visible = rows.slice(0, 4);
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border bg-card/40",
        attention && rows.length > 0 ? "border-warning/35" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-meta text-muted-foreground">{description}</div>
        </div>
        <span className="text-meta rounded bg-subtle px-1.5 py-0.5 font-mono text-muted-foreground">
          {rows.length}
        </span>
      </div>
      <div className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <p className="text-meta px-1 py-3 text-muted-foreground">{empty}</p>
        ) : (
          visible.map((row) => (
            <div key={row.step.id} className="rounded-md border border-border bg-background/20 p-2">
              <Link
                href={`/w/${slug}/plans/${planId}#step-${row.step.id}`}
                className="block truncate text-sm font-medium hover:text-ember"
              >
                {row.step.title || "Untitled step"}
              </Link>
              <RunOperationalStatus
                run={row.run}
                stepStatus={row.step.status}
                showTrace={Boolean(row.run)}
                className="mt-1.5 border-0 bg-transparent"
              />
            </div>
          ))
        )}
      </div>
      {rows.length > visible.length ? (
        <Link
          href={`/w/${slug}/plans/${planId}`}
          className="text-meta block border-t border-border px-3 py-2 text-muted-foreground hover:text-ember"
        >
          {rows.length - visible.length} more in plan →
        </Link>
      ) : null}
    </div>
  );
}

type GoalCrewOption = {
  id: string;
  name: string;
  maxParallel?: number | null;
  members?: unknown[];
};

function GoalEditModal({
  goal,
  crews,
  busy,
  onClose,
  onSave,
}: {
  goal: {
    title: string;
    description?: string | null;
    successCriteria?: string | null;
    outcomeSummary?: string | null;
    targetDate?: string | Date | null;
    crewId?: string | null;
    maxTotalCostUsd?: number | null;
    maxWallTimeMinutes?: number | null;
  };
  crews: GoalCrewOption[];
  busy: boolean;
  onClose: () => void;
  onSave: (payload: {
    title: string;
    description: string | null;
    successCriteria: string | null;
    outcomeSummary: string | null;
    targetDate: Date | null;
    crewId: string | null;
    maxTotalCostUsd: number | null;
    maxWallTimeMinutes: number | null;
  }) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description ?? "");
  const [successCriteria, setSuccessCriteria] = useState(goal.successCriteria ?? "");
  const [outcomeSummary, setOutcomeSummary] = useState(goal.outcomeSummary ?? "");
  const [targetDate, setTargetDate] = useState(
    goal.targetDate ? new Date(goal.targetDate).toISOString().slice(0, 10) : "",
  );
  const [crewId, setCrewId] = useState(goal.crewId ?? "");
  const [costCap, setCostCap] = useState(
    goal.maxTotalCostUsd == null ? "" : String(goal.maxTotalCostUsd),
  );
  const [timeCap, setTimeCap] = useState(
    goal.maxWallTimeMinutes == null ? "" : String(goal.maxWallTimeMinutes),
  );

  const parsedCost = costCap.trim() ? Number(costCap) : null;
  const parsedTime = timeCap.trim() ? Number(timeCap) : null;
  const invalidCost = parsedCost != null && (!Number.isFinite(parsedCost) || parsedCost < 0);
  const invalidTime = parsedTime != null && (!Number.isInteger(parsedTime) || parsedTime <= 0);

  return (
    <QuickForm
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Edit goal"
      description="Budgets apply to the active plan"
      primaryLabel={busy ? "Saving…" : "Save"}
      loading={busy}
      className="max-w-lg"
      onSubmit={async () => {
        if (!title.trim()) return { error: "Title is required." };
        if (invalidCost || invalidTime)
          return {
            error: "Cost must be zero or higher. Wall time must be a whole positive minute.",
          };
        await onSave({
          title: title.trim(),
          description: description.trim() || null,
          successCriteria: successCriteria.trim() || null,
          outcomeSummary: outcomeSummary.trim() || null,
          targetDate: targetDate ? new Date(`${targetDate}T12:00:00`) : null,
          crewId: crewId || null,
          maxTotalCostUsd: parsedCost,
          maxWallTimeMinutes: parsedTime,
        });
      }}
    >
      <QuickForm.Field label="Title">
        <input
          autoFocus
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />
      </QuickForm.Field>
      <QuickForm.Field label="Success criteria">
        <textarea
          name="successCriteria"
          value={successCriteria}
          onChange={(e) => setSuccessCriteria(e.target.value)}
          rows={3}
          placeholder="Observable conditions that prove completion"
          className="w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />
      </QuickForm.Field>
      <QuickForm.Field label="Outcome summary">
        <textarea
          name="outcomeSummary"
          value={outcomeSummary}
          onChange={(e) => setOutcomeSummary(e.target.value)}
          rows={3}
          placeholder="What changed or was delivered?"
          className="w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />
      </QuickForm.Field>
      <QuickForm.Field label="Target date">
        <input
          type="date"
          name="targetDate"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />
      </QuickForm.Field>
      <QuickForm.Field label="Description">
        <textarea
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />
      </QuickForm.Field>
      <QuickForm.Field label="Crew">
        <Combobox
          ariaLabel="Crew"
          className="h-9 w-full"
          matchTriggerWidth
          allowNone
          noneLabel="No crew"
          placeholder="No crew"
          value={crewId || null}
          onChange={(v) => setCrewId(v ?? "")}
          options={crews.map((crew) => ({ value: crew.id, label: crew.name }))}
        />
      </QuickForm.Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <QuickForm.Field label="Cost cap (USD)">
          <input
            type="number"
            name="costCap"
            min={0}
            step="0.01"
            value={costCap}
            onChange={(e) => setCostCap(e.target.value)}
            placeholder="No cap"
            className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm tabular-nums"
          />
        </QuickForm.Field>
        <QuickForm.Field label="Wall-time cap (minutes)">
          <input
            type="number"
            name="timeCap"
            min={1}
            step={1}
            value={timeCap}
            onChange={(e) => setTimeCap(e.target.value)}
            placeholder="No cap"
            className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm tabular-nums"
          />
        </QuickForm.Field>
      </div>
    </QuickForm>
  );
}

function GoalLiveStatus({
  goalStatus,
  plan,
  elapsedMinutes,
  onStart,
  starting,
}: {
  goalStatus: string;
  plan: GoalPlanRow | null;
  elapsedMinutes: number | null;
  onStart?: () => void;
  starting?: boolean;
}) {
  const steps = plan?.steps ?? [];
  const total = steps.length || plan?._count?.steps || 0;
  const counts = steps.reduce<Record<string, number>>((acc, step) => {
    acc[step.status] = (acc[step.status] ?? 0) + 1;
    return acc;
  }, {});
  const queued = counts.READY ?? 0;
  const running = counts.RUNNING ?? 0;
  const review = counts.REVIEW ?? 0;
  const blocked = counts.BLOCKED ?? 0;
  const done = counts.DONE ?? 0;
  const latestRuns = steps.flatMap((step) => step.runs?.slice(0, 1) ?? []);
  const runCounts = latestRuns.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] ?? 0) + 1;
    return acc;
  }, {});
  const attentionRun =
    latestRuns.find((run) => run.status === "STALLED") ??
    latestRuns.find((run) => run.status === "WAITING") ??
    null;
  const activeRunCount = runCounts.ACTIVE ?? 0;
  const runMetric = (() => {
    if ((runCounts.STALLED ?? 0) > 0) return `${runCounts.STALLED} stalled`;
    if ((runCounts.WAITING ?? 0) > 0) return `${runCounts.WAITING} waiting`;
    if (activeRunCount > 0) return `${activeRunCount} active`;
    if ((runCounts.COMPLETED ?? 0) > 0) return `${runCounts.COMPLETED} done`;
    return null;
  })();

  const phase = (() => {
    if (!plan)
      return { title: "No plan yet", body: "Generate a plan or dispatch the crew planner." };
    if (plan.status === "DRAFT" && total === 0) {
      return { title: "Draft is empty", body: "The planner has not added steps yet." };
    }
    if (plan.status === "DRAFT") {
      return { title: "Waiting for approval", body: "Approve the draft plan to start the crew." };
    }
    if (plan.status === "APPROVED") {
      return {
        title: "Approved, not running",
        body: "Start the crew to dispatch ready root steps.",
      };
    }
    if (plan.status === "RUNNING") {
      if (attentionRun?.status === "STALLED") {
        return {
          title: "Run stalled",
          body: attentionRun.summary ?? "The latest worker run stopped and needs attention.",
        };
      }
      if (attentionRun?.status === "WAITING") {
        return {
          title: "Waiting on operator",
          body: attentionRun.summary ?? "The latest worker run is waiting before continuing.",
        };
      }
      if (blocked > 0)
        return {
          title: "Blocked",
          body: `${blocked} step${blocked === 1 ? "" : "s"} need attention.`,
        };
      if (activeRunCount > 0)
        return {
          title: "Crew working",
          body: `${activeRunCount} run${activeRunCount === 1 ? "" : "s"} active now.`,
        };
      if (running > 0)
        return {
          title: "Crew working",
          body: `${running} step${running === 1 ? "" : "s"} running now.`,
        };
      if (review > 0)
        return {
          title: "In review",
          body: `${review} step${review === 1 ? "" : "s"} waiting on judging.`,
        };
      if (queued > 0)
        return {
          title: "Queued for pickup",
          body: `${queued} step${queued === 1 ? "" : "s"} dispatched and waiting for acknowledgement.`,
        };
      if (done === total && total > 0)
        return {
          title: "Wrapping up",
          body: "Every step is done; completion should land shortly.",
        };
      return { title: "Waiting on dependencies", body: "No root step is ready yet." };
    }
    if (plan.status === "BLOCKED") {
      return { title: "Plan blocked", body: "Open the plan cockpit to resolve the blocker." };
    }
    if (plan.status === "COMPLETED") {
      return { title: "Completed", body: "The active plan has completed." };
    }
    return { title: goalStatus.toLowerCase(), body: "No active crew work is currently visible." };
  })();

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-meta flex items-center gap-1.5 uppercase tracking-wide text-muted-foreground">
          <Clock3 className="h-3 w-3" />
          <span>Live status</span>
        </div>
        {plan ? (
          <span className="font-mono text-[10px] uppercase text-muted-foreground">
            {plan.status.toLowerCase()}
          </span>
        ) : null}
      </div>
      <div className="text-sm font-medium">{phase.title}</div>
      <p className="text-meta mt-1 text-muted-foreground">{phase.body}</p>
      {plan ? (
        <dl className="text-meta mt-3 grid grid-cols-2 gap-2">
          <Metric label="Steps" value={String(total)} />
          <Metric label="Done" value={`${done}/${total}`} />
          <Metric label="Queued" value={String(queued)} />
          <Metric label="Running" value={String(running + review)} />
          {runMetric ? <Metric label="Runs" value={runMetric} /> : null}
          {elapsedMinutes != null ? (
            <Metric label="Elapsed" value={`${Math.max(0, Math.round(elapsedMinutes))}m`} />
          ) : null}
          {plan.updatedAt ? (
            <Metric
              label="Updated"
              value={new Date(plan.updatedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            />
          ) : null}
        </dl>
      ) : null}
      {attentionRun ? (
        <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <div className="text-meta font-medium uppercase tracking-wide text-warning">
                Run {attentionRun.status.toLowerCase()}
              </div>
              {attentionRun.summary ? (
                <p className="text-meta mt-1 line-clamp-3 text-muted-foreground">
                  {attentionRun.summary}
                </p>
              ) : null}
              {attentionRun.lastEventAt ? (
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {new Date(attentionRun.lastEventAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {onStart ? (
        <Button
          size="sm"
          variant="ember"
          className="mt-3 w-full"
          disabled={starting}
          onClick={onStart}
        >
          <Play className="h-3.5 w-3.5" />
          {starting ? "Starting…" : "Start crew"}
        </Button>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card/30 px-2 py-1.5">
      <dt className="uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function PlannerPanel({
  hasEmptyDraft,
  activePlanId,
  slug,
  dispatchResult,
  canGenerate,
  canDispatch,
  generating,
  dispatching,
  onGenerate,
  onDispatch,
}: {
  hasEmptyDraft: boolean;
  activePlanId: string | null;
  slug: string;
  dispatchResult: { planner: GoalPlannerInfo | null; dispatchable: boolean } | null;
  canGenerate: boolean;
  canDispatch: boolean;
  generating: boolean;
  dispatching: boolean;
  onGenerate: () => void;
  onDispatch: () => void;
}) {
  const busy = generating || dispatching;
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/20 p-4">
      <div className="flex items-center gap-2">
        <Target className="h-3.5 w-3.5 text-ember" />
        <span className="text-sm font-medium">
          {hasEmptyDraft ? "This plan has no steps yet" : "No plan yet"}
        </span>
      </div>
      <p className="text-meta mt-1 text-muted-foreground">
        Generate the steps with Forge, or dispatch the crew&apos;s planner agent to draft them.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ember" disabled={!canGenerate || busy} onClick={onGenerate}>
          <Sparkles className="h-3.5 w-3.5" />
          {generating ? "Generating…" : "Generate with Forge"}
        </Button>
        <Button size="sm" variant="outline" disabled={!canDispatch || busy} onClick={onDispatch}>
          <Send className="h-3.5 w-3.5" />
          {dispatching ? "Dispatching…" : "Dispatch to crew planner"}
        </Button>
      </div>

      {dispatchResult ? (
        <DispatchFeedback result={dispatchResult} activePlanId={activePlanId} slug={slug} />
      ) : null}
    </div>
  );
}

function DispatchFeedback({
  result,
  activePlanId,
  slug,
}: {
  result: { planner: GoalPlannerInfo | null; dispatchable: boolean };
  activePlanId: string | null;
  slug: string;
}) {
  const { planner, dispatchable } = result;

  if (dispatchable && planner) {
    const offline = planner.status === "OFFLINE";
    return (
      <div className="text-meta mt-3 rounded-md border border-border bg-card/40 p-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-foreground">
          <span className="forge-breath" aria-hidden />
          Dispatched to <span className="font-medium">{planner.name}</span>
          <span className="text-id text-muted-foreground">{planner.profileKey}</span>· waiting for
          steps.
        </div>
        {offline ? (
          <div className="mt-1 text-warning">
            Agent is currently offline — it&apos;ll pick this up when it reconnects.
          </div>
        ) : null}
      </div>
    );
  }

  // Not dispatchable — say exactly why, and what to do instead.
  const reason = !planner
    ? "No planner agent is assigned to this goal's crew."
    : `${planner.name} can't be reached — it ${
        planner.runEngine === "RUNS" ? "has no runtime attached" : "has no webhook configured"
      }.`;
  return (
    <div className="text-meta mt-3 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-foreground">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <div>
          <div>{reason}</div>
          <div className="mt-1 text-muted-foreground">
            Generate with Forge instead, or assign a reachable planner to the crew.
            {activePlanId ? (
              <>
                {" "}
                <Link
                  href={`/w/${slug}/plans/${activePlanId}`}
                  className="text-ember hover:underline"
                >
                  Open the draft to add steps manually →
                </Link>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const PLAN_STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-subtle text-muted-foreground",
  APPROVED: "bg-success/15 text-success",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  COMPLETED: "bg-success/15 text-success",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

function PlanAttemptCard({
  plan,
  slug,
  isActive,
  onStart,
  starting,
}: {
  plan: GoalPlanRow;
  slug: string;
  isActive?: boolean;
  onStart?: () => void;
  starting?: boolean;
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
          <span className="truncate text-sm font-medium group-hover:text-ember">{plan.title}</span>
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
              className="h-full bg-success transition-all duration-500"
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
          <div className="text-meta text-muted-foreground">
            {done}/{total} steps done
          </div>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          href={`/w/${slug}/plans/${plan.id}`}
          className="text-meta inline-flex items-center gap-1 text-ember hover:underline"
        >
          Open plan cockpit <ExternalLink className="h-3 w-3" />
        </a>
        {onStart ? (
          <Button size="sm" variant="ember" disabled={starting} onClick={onStart}>
            <Play className="h-3.5 w-3.5" />
            {starting ? "Starting…" : "Start crew"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
