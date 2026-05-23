"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, ChevronDown, ExternalLink, Target, Workflow } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";
import { DagView } from "@/components/orchestration/dag-view";
import { BudgetMeter } from "@/components/orchestration/budget-meter";
import {
  isStepDone,
  type DagAgent,
  type DagStep,
  type StepStatus,
} from "@/components/orchestration/types";

/**
 * Mission Control "Plans" tab (chord 7).
 *
 * Watches multi-agent goals execute in real time. Top level is a list
 * of active Goals (status ACTIVE/PLANNING) with plan progress + budget
 * burn; expanding one renders its active plan's DAG.
 *
 * Backend contract: `goal.list` / `goal.get` and the orchestration
 * fields on ExecutionPlan/Step (judgeVerdict, retryCount, budgets) ship
 * from the parallel backend wave. Until they're merged this tab
 * degrades to the base `executionPlan` router — it lists RUNNING plans
 * directly (no goal wrapper) so it's useful the moment plans run, and
 * lights up fully once goals + budgets land. The goal-aware path is
 * feature-detected at runtime via the tRPC client.
 *
 * Reactivity: SSE invalidation on execution-plan / execution-step /
 * goal / agent-run subjects. No polling.
 */

type PlanListItem = {
  id: string;
  title: string;
  status: string;
  goalId?: string | null;
  totalCostUsd?: number | null;
  maxTotalCostUsd?: number | null;
  _count?: { steps: number };
};

export function PlansTab({ slug }: { slug: string }) {
  const utils = trpc.useUtils();

  // Feature-detect the goal router. The orchestration backend ships it;
  // until then we operate purely on execution plans.
  const goalRouter = (trpc as unknown as {
    goal?: {
      list?: { useQuery: (input: unknown, opts?: unknown) => { data?: unknown } };
    };
  }).goal;
  const hasGoalRouter = Boolean(goalRouter?.list);

  // Active plans — DRAFT/APPROVED/RUNNING/BLOCKED are the "live" set we
  // care about. We can't pass an OR of statuses to the list query, so we
  // fetch broadly (no status filter) and filter client-side to the
  // states worth surfacing on an ops dashboard.
  const { data: planList, isLoading } = trpc.executionPlan.list.useQuery(
    { limit: 50 },
    { enabled: Boolean(slug), staleTime: 4_000 },
  );

  useRealtime((evt) => {
    const t = evt.subjectType ?? "";
    if (
      t === "execution-plan" ||
      t === "execution-step" ||
      t === "goal" ||
      t === "agent-run" ||
      (evt.kind ?? "").startsWith("AGENT_RUN_")
    ) {
      void utils.executionPlan.list.invalidate();
      void utils.executionPlan.get.invalidate();
      if (hasGoalRouter) {
        // best-effort: invalidate the goal cache when present
        void (utils as unknown as { goal?: { list?: { invalidate?: () => void } } })
          .goal?.list?.invalidate?.();
      }
    }
  });

  const LIVE_STATUSES = new Set(["RUNNING", "BLOCKED", "APPROVED", "DRAFT"]);
  const plans = useMemo(() => {
    const items = (planList?.items ?? []) as PlanListItem[];
    return items.filter((p) => LIVE_STATUSES.has(p.status));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planList]);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="px-3 py-4 text-meta text-muted-foreground">
        Loading plans…
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <Target className="h-5 w-5 text-muted-foreground/50" />
        <p className="text-meta text-muted-foreground">
          Nothing running.
        </p>
        <p className="max-w-[16rem] text-[0.625rem] leading-relaxed text-muted-foreground/70">
          Active goals and their execution plans light up here as agents
          work the DAG.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-1.5 overflow-y-auto px-2 py-2">
        {plans.map((p) => (
          <PlanRow
            key={p.id}
            slug={slug}
            plan={p}
            expanded={expandedId === p.id}
            onToggle={() =>
              setExpandedId((cur) => (cur === p.id ? null : p.id))
            }
          />
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-meta text-muted-foreground">
        <span>
          {plans.length} active {plans.length === 1 ? "plan" : "plans"}
        </span>
        <Link
          href={`/w/${slug}/plans`}
          className="flex items-center gap-1 hover:text-foreground"
        >
          All plans <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

function PlanRow({
  slug,
  plan,
  expanded,
  onToggle,
}: {
  slug: string;
  plan: PlanListItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Hydrate full plan (steps + relations) only when expanded — keeps the
  // list cheap. The detail query returns steps with the orchestration
  // contract fields once the backend merges.
  const { data: detail } = trpc.executionPlan.get.useQuery(
    { id: plan.id },
    { enabled: expanded, staleTime: 3_000 },
  );

  const steps = useMemo<DagStep[]>(() => {
    const raw = (detail?.steps ?? []) as Array<Record<string, unknown>>;
    return raw.map((s) => ({
      id: String(s.id),
      title: String(s.title ?? ""),
      body: (s.body as string | null) ?? null,
      position: Number(s.position ?? 0),
      status: (s.status as StepStatus) ?? "TODO",
      assignedAgentId: (s.assignedAgentId as string | null) ?? null,
      dependsOnStepIds: Array.isArray(s.dependsOnStepIds)
        ? (s.dependsOnStepIds as string[])
        : [],
      expectedOutput: (s.expectedOutput as string | null) ?? null,
      judgeVerdict:
        (s.judgeVerdict as DagStep["judgeVerdict"]) ?? null,
      retryCount: (s.retryCount as number | null) ?? null,
      lastFeedback: (s.lastFeedback as string | null) ?? null,
      childPlanId: (s.childPlanId as string | null) ?? null,
      sourceRunId: (s.sourceRunId as string | null) ?? null,
    }));
  }, [detail]);

  // Resolve each step's sourceRun for per-step cost + approval overlay.
  // Steps carry a loose sourceRunId (no relation), so batch-fetch the meta.
  const sourceRunIds = useMemo(
    () =>
      steps.map((s) => s.sourceRunId).filter((id): id is string => !!id),
    [steps],
  );
  const { data: runMeta } = trpc.agentRun.metaByIds.useQuery(
    { ids: sourceRunIds },
    { enabled: expanded && sourceRunIds.length > 0, staleTime: 3_000 },
  );
  const dagSteps = useMemo<DagStep[]>(() => {
    if (!runMeta || runMeta.length === 0) return steps;
    const metaById = new Map(runMeta.map((m) => [m.id, m]));
    return steps.map((s) => {
      const meta = s.sourceRunId ? metaById.get(s.sourceRunId) : undefined;
      return meta
        ? { ...s, costUsd: meta.costUsd, awaitingApproval: meta.awaitingApproval }
        : s;
    });
  }, [steps, runMeta]);

  // Build an agent lookup. The detail query may include assigned-agent
  // relations on steps in the contract; fall back to the workspace agent
  // list so glyphs render even on the base schema.
  const { data: agents } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: expanded, staleTime: 30_000 },
  );
  const agentsById = useMemo<Record<string, DagAgent>>(() => {
    const map: Record<string, DagAgent> = {};
    for (const a of agents ?? []) {
      map[a.id] = {
        id: a.id,
        name: a.name,
        profileKey: a.profileKey,
        status: a.status as DagAgent["status"],
        avatar: (a as { avatar?: string | null }).avatar ?? null,
      };
    }
    return map;
  }, [agents]);

  const totalSteps = plan._count?.steps ?? steps.length;
  const doneSteps = steps.filter((s) => isStepDone(s.status)).length;
  const runningSteps = steps.filter((s) => s.status === "RUNNING").length;

  // Budget: prefer the contract fields on the list/detail row; absent →
  // hide the meter rather than render a fake bar.
  const totalCost =
    plan.totalCostUsd ??
    (detail as { totalCostUsd?: number } | undefined)?.totalCostUsd ??
    null;
  const maxCost =
    plan.maxTotalCostUsd ??
    (detail as { maxTotalCostUsd?: number | null } | undefined)
      ?.maxTotalCostUsd ??
    null;
  const showBudget = typeof totalCost === "number";

  const statusTone =
    plan.status === "RUNNING"
      ? "text-ember"
      : plan.status === "BLOCKED"
        ? "text-danger"
        : "text-muted-foreground";

  return (
    <div
      className={cn(
        "rounded-md border bg-card/40 text-[0.75rem] transition-colors",
        expanded ? "border-ember/30" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Workflow className="h-3 w-3 shrink-0 text-ember/70" />
        <span className="truncate text-foreground" title={plan.title}>
          {plan.title}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {runningSteps > 0 && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-ember opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ember" />
            </span>
          )}
          <span className={cn("font-mono text-[0.625rem] uppercase tracking-wide", statusTone)}>
            {plan.status.toLowerCase()}
          </span>
          <span className="font-mono text-[0.625rem] text-muted-foreground">
            {doneSteps}/{totalSteps}
          </span>
        </span>
      </button>

      {/* progress + budget strip (always visible on the row) */}
      <div className="flex items-center gap-3 border-t border-border/40 px-2.5 py-1">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-subtle">
          <div
            className="h-full rounded-full bg-success transition-[width] duration-500 ease-out"
            style={{
              width: `${totalSteps > 0 ? (doneSteps / totalSteps) * 100 : 0}%`,
            }}
          />
        </div>
        {showBudget && (
          <BudgetMeter
            variant="cost"
            value={totalCost as number}
            max={maxCost}
            className="w-28 shrink-0"
          />
        )}
      </div>

      {expanded && (
        <div className="border-t border-border/40">
          {!detail ? (
            <div className="px-3 py-4 text-meta text-muted-foreground">
              Loading DAG…
            </div>
          ) : (
            <DagView
              steps={dagSteps}
              agentsById={agentsById}
              planHref={`/w/${slug}/plans/${plan.id}`}
              className="max-h-72"
            />
          )}
        </div>
      )}
    </div>
  );
}
