"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  Ban,
  Check,
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
  type ActiveStepByAgent,
  type CrewRosterData,
} from "@/components/orchestration/crew-roster-panel";
import {
  useGoalRouter,
  type GoalPlanRow,
  type GoalPlannerInfo,
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
  const { data: crewList } = trpc.agentCrew.list.useQuery({});
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
    onError: (e: { message: string }) => toast.error(e.message),
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
  const canPlan = goal.status !== "ACHIEVED" && goal.status !== "ABANDONED";
  const activeStepCount =
    activePlan?.steps?.length ?? activePlan?._count?.steps ?? 0;
  const activePlanEmpty =
    !!activePlan && activePlan.status === "DRAFT" && activeStepCount === 0;
  // Offer the planner actions whenever there's nothing to run yet: no active
  // plan, or an active plan still sitting as an empty DRAFT (the bug the user
  // hit). A plan with steps hides the panel.
  const needsPlanner = canPlan && (!activePlan || activePlanEmpty);
  const elapsedMinutes = goal.startedAt
    ? (Date.now() - new Date(goal.startedAt).getTime()) / 60_000
    : null;
  const activeByAgent: ActiveStepByAgent = new Map();
  for (const step of activePlan?.steps ?? []) {
    if (
      step.assignedAgentId &&
      ["READY", "RUNNING", "REVIEW"].includes(step.status)
    ) {
      activeByAgent.set(step.assignedAgentId, {
        id: step.id,
        title: step.title ?? "Step",
        status: step.status,
      });
    }
  }

  return (
    <>
      <Topbar
        title={goal.title}
        subtitle={`Goal · ${goal.status.toLowerCase()}`}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/w/${ws.slug}/goals`)}
            >
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
              onStart={
                activePlan.status === "APPROVED"
                  ? () => activatePlanM.mutate({ id: activePlan.id })
                  : undefined
              }
              starting={activatePlanM.isPending}
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

      {editingGoal ? (
        <GoalEditModal
          goal={goal}
          crews={crewList?.items ?? []}
          busy={Boolean(updateM?.isPending)}
          onClose={() => setEditingGoal(false)}
          onSave={(payload) =>
            updateM?.mutate({
              id: goal.id,
              ...payload,
            })
          }
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
    crewId: string | null;
    maxTotalCostUsd: number | null;
    maxWallTimeMinutes: number | null;
  }) => void;
}) {
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description ?? "");
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
  const invalidTime =
    parsedTime != null && (!Number.isInteger(parsedTime) || parsedTime <= 0);
  const canSave = title.trim().length > 0 && !invalidCost && !invalidTime;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/20 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Edit goal</h2>
          <span className="text-meta text-muted-foreground">Budgets apply to the active plan</span>
        </div>

        <label className="mt-3 block text-meta text-muted-foreground">Title</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-meta text-muted-foreground">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="mt-1 w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-meta text-muted-foreground">Crew</label>
        <select
          value={crewId}
          onChange={(e) => setCrewId(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        >
          <option value="">No crew</option>
          {crews.map((crew) => (
            <option key={crew.id} value={crew.id}>
              {crew.name}
            </option>
          ))}
        </select>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-meta text-muted-foreground">Cost cap (USD)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={costCap}
              onChange={(e) => setCostCap(e.target.value)}
              placeholder="No cap"
              className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm tabular-nums"
            />
          </label>
          <label className="block">
            <span className="text-meta text-muted-foreground">Wall-time cap (minutes)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={timeCap}
              onChange={(e) => setTimeCap(e.target.value)}
              placeholder="No cap"
              className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm tabular-nums"
            />
          </label>
        </div>

        {(invalidCost || invalidTime) ? (
          <p className="mt-2 text-meta text-warning">
            Cost must be zero or higher. Wall time must be a whole positive minute.
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="ember"
            size="sm"
            disabled={busy || !canSave}
            onClick={() =>
              onSave({
                title: title.trim(),
                description: description.trim() || null,
                crewId: crewId || null,
                maxTotalCostUsd: parsedCost,
                maxWallTimeMinutes: parsedTime,
              })
            }
          >
            <Check className="h-3.5 w-3.5" />
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
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

  const phase = (() => {
    if (!plan) return { title: "No plan yet", body: "Generate a plan or dispatch the crew planner." };
    if (plan.status === "DRAFT" && total === 0) {
      return { title: "Draft is empty", body: "The planner has not added steps yet." };
    }
    if (plan.status === "DRAFT") {
      return { title: "Waiting for approval", body: "Approve the draft plan to start the crew." };
    }
    if (plan.status === "APPROVED") {
      return { title: "Approved, not running", body: "Start the crew to dispatch ready root steps." };
    }
    if (plan.status === "RUNNING") {
      if (blocked > 0) return { title: "Blocked", body: `${blocked} step${blocked === 1 ? "" : "s"} need attention.` };
      if (running > 0) return { title: "Crew working", body: `${running} step${running === 1 ? "" : "s"} running now.` };
      if (review > 0) return { title: "In review", body: `${review} step${review === 1 ? "" : "s"} waiting on judging.` };
      if (queued > 0) return { title: "Queued for pickup", body: `${queued} step${queued === 1 ? "" : "s"} dispatched and waiting for acknowledgement.` };
      if (done === total && total > 0) return { title: "Wrapping up", body: "Every step is done; completion should land shortly." };
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
        <div className="flex items-center gap-1.5 text-meta uppercase tracking-wide text-muted-foreground">
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
      <p className="mt-1 text-meta text-muted-foreground">{phase.body}</p>
      {plan ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-meta">
          <Metric label="Steps" value={String(total)} />
          <Metric label="Done" value={`${done}/${total}`} />
          <Metric label="Queued" value={String(queued)} />
          <Metric label="Running" value={String(running + review)} />
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
      <p className="mt-1 text-meta text-muted-foreground">
        Generate the steps with Forge, or dispatch the crew&apos;s planner agent
        to draft them.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ember"
          disabled={!canGenerate || busy}
          onClick={onGenerate}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {generating ? "Generating…" : "Generate with Forge"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canDispatch || busy}
          onClick={onDispatch}
        >
          <Send className="h-3.5 w-3.5" />
          {dispatching ? "Dispatching…" : "Dispatch to crew planner"}
        </Button>
      </div>

      {dispatchResult ? (
        <DispatchFeedback
          result={dispatchResult}
          activePlanId={activePlanId}
          slug={slug}
        />
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
      <div className="mt-3 rounded-md border border-border bg-card/40 p-2.5 text-meta">
        <div className="flex flex-wrap items-center gap-1.5 text-foreground">
          <span className="forge-breath" aria-hidden />
          Dispatched to <span className="font-medium">{planner.name}</span>
          <span className="text-id text-muted-foreground">{planner.profileKey}</span>
          · waiting for steps.
        </div>
        {offline ? (
          <div className="mt-1 text-warning">
            Agent is currently offline — it&apos;ll pick this up when it
            reconnects.
          </div>
        ) : null}
      </div>
    );
  }

  // Not dispatchable — say exactly why, and what to do instead.
  const reason = !planner
    ? "No planner agent is assigned to this goal's crew."
    : `${planner.name} can't be reached — it ${
        planner.runEngine === "RUNS"
          ? "has no runtime attached"
          : "has no webhook configured"
      }.`;
  return (
    <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-meta text-foreground">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <div>
          <div>{reason}</div>
          <div className="mt-1 text-muted-foreground">
            Generate with Forge instead, or assign a reachable planner to the
            crew.
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

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          href={`/w/${slug}/plans/${plan.id}`}
          className="inline-flex items-center gap-1 text-meta text-ember hover:underline"
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
