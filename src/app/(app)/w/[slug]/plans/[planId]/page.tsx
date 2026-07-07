"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  ChevronLeft,
  CornerDownRight,
  FilePlus2,
  LayoutList,
  ListTree,
  Network,
  Plus,
  RotateCcw,
  Target,
  Trash2,
  Workflow,
  XCircle,
} from "lucide-react";
import { ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
import type { AgentStatus } from "@prisma/client";
import { presenceAvailability } from "@/lib/transport-display";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";
import { StepComments } from "@/components/plans/step-comments";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { Avatar } from "@/components/ui/avatar";
import { BudgetMeter } from "@/components/orchestration/budget-meter";
import {
  DagStepStrip,
  toneForStepStatus,
} from "@/components/orchestration/dag-step-strip";
import { DagView } from "@/components/orchestration/dag-view";
import type { DagAgent, DagStep } from "@/components/orchestration/types";
import {
  CrewRosterPanel,
  type ActiveStepByAgent,
  type CrewRosterData,
} from "@/components/orchestration/crew-roster-panel";
import {
  RunAttentionPanel,
  pickAttentionRun,
  type OrchestrationAttentionRun,
} from "@/components/orchestration/run-attention-panel";
import { ActionRequestCard } from "@/components/action-requests/action-request-card";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";

const PLAN_STATUSES: ExecutionPlanStatus[] = [
  ExecutionPlanStatus.DRAFT,
  ExecutionPlanStatus.APPROVED,
  ExecutionPlanStatus.RUNNING,
  ExecutionPlanStatus.BLOCKED,
  ExecutionPlanStatus.COMPLETED,
  ExecutionPlanStatus.CANCELED,
];

const STEP_STATUSES: ExecutionStepStatus[] = [
  ExecutionStepStatus.TODO,
  ExecutionStepStatus.READY,
  ExecutionStepStatus.RUNNING,
  ExecutionStepStatus.BLOCKED,
  ExecutionStepStatus.REVIEW,
  ExecutionStepStatus.DONE,
  ExecutionStepStatus.CANCELED,
];

const PLAN_STATUS_TONE: Record<ExecutionPlanStatus, string> = {
  DRAFT: "bg-subtle text-muted-foreground",
  APPROVED: "bg-success/15 text-success",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  COMPLETED: "bg-success/15 text-success",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

const STEP_STATUS_TONE: Record<ExecutionStepStatus, string> = {
  TODO: "bg-subtle text-muted-foreground",
  READY: "bg-success/10 text-success",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  REVIEW: "bg-warning/15 text-warning",
  DONE: "bg-success/15 text-success",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

// Used for the timeline connector and the stacked progress bar.
const STEP_STATUS_BAR: Record<ExecutionStepStatus, string> = {
  TODO: "bg-muted/50",
  READY: "bg-success/50",
  RUNNING: "bg-ember",
  BLOCKED: "bg-warning",
  REVIEW: "bg-warning",
  DONE: "bg-success",
  CANCELED: "bg-muted/40",
};

const ROSTER_ACTIVE_STEP_STATUSES = new Set<ExecutionStepStatus>([
  ExecutionStepStatus.READY,
  ExecutionStepStatus.RUNNING,
  ExecutionStepStatus.REVIEW,
]);

type JudgeVerdict = {
  verdict: "PASS" | "FAIL";
  feedback?: string | null;
  score?: number | null;
  judgedByAgentId?: string | null;
  judgedAt?: string | null;
};

type StepRow = {
  id: string;
  title: string;
  body: string | null;
  position: number;
  status: ExecutionStepStatus;
  expectedOutput: string | null;
  assignedAgentId: string | null;
  assignedUserId: string | null;
  dependsOnStepIds: string[];
  // Orchestration-loop fields (backend agent ships these on the schema;
  // optional here so the page compiles before the Prisma client
  // regenerates).
  retryCount: number;
  judgeVerdict: JudgeVerdict | null;
  childPlanId: string | null;
  lastFeedback: string | null;
  // Materialized issue (AXI-56). Null = pure orchestration scaffolding.
  issue: {
    id: string;
    number: number;
    title: string;
    assignedAgentId?: string | null;
    workspace: { key: string; slug: string };
    agentRuns?: OrchestrationAttentionRun[];
  } | null;
  runs?: OrchestrationAttentionRun[];
};

/** Lightweight agent presence map keyed by agent id. */
type AgentLite = {
  id: string;
  name: string;
  profileKey: string;
  image: string | null;
  status: AgentStatus;
  lastHeartbeatAt: string | Date | null;
  // Presence inputs (carried by agent.list) so on-demand agents — e.g. a
  // Codex app-server — read "on-demand" on step dots, not a false "offline".
  provider?: string | null;
  runtimeMode?: string | null;
  runtimeId?: string | null;
  webhookUrl?: string | null;
};

type ViewMode = "list" | "timeline" | "graph";

const SAVE_DEBOUNCE_MS = 600;

/**
 * Execution plan detail + builder. Header carries inline-edit title +
 * markdown description; the main column lists steps in position order with
 * inline auto-save, a list/timeline view toggle, live progress, and a
 * currently-running highlight that scrolls into view. Linked
 * issue/project/context-set are surfaced as deep-links in the sidebar.
 */
export default function PlanDetailPage() {
  const params = useParams<{ slug: string; planId: string }>();
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();

  const {
    data: plan,
    isLoading,
    isError,
    refetch,
  } = trpc.executionPlan.get.useQuery({ id: params.planId });

  // Agents — for presence dots + glyphs on assigned steps. Cheap list,
  // cached; we index by id below.
  const { data: agentsList } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { staleTime: 30_000 },
  );
  const agentsById = useMemo(() => {
    const m = new Map<string, AgentLite>();
    for (const a of (agentsList ?? []) as unknown as AgentLite[]) {
      m.set(a.id, a);
    }
    return m;
  }, [agentsList]);

  // Reactivity: invalidate this plan on any orchestration event so the
  // cockpit stays live — steps flip status, judge verdicts land, the
  // budget ticks, all without a manual reload. Cheap synchronous
  // invalidate in the SSE callback (per the hook's contract).
  useRealtime(
    () => {
      utils.executionPlan.get.invalidate({ id: params.planId });
    },
    {
      subjectType: ["execution-plan", "execution-step", "goal", "agent-run"],
    },
  );

  const update = trpc.executionPlan.update.useMutation({
    onSuccess: () => {
      utils.executionPlan.get.invalidate({ id: params.planId });
      utils.executionPlan.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const activate = trpc.executionPlan.activate.useMutation({
    onSuccess: () => {
      toast.success("Crew started");
      utils.executionPlan.get.invalidate({ id: params.planId });
      utils.executionPlan.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.executionPlan.archive.useMutation({
    onSuccess: () => {
      toast.success("Plan archived");
      utils.executionPlan.list.invalidate();
      router.push(`/w/${ws.slug}/plans`);
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteM = trpc.executionPlan.delete.useMutation({
    onSuccess: () => {
      toast.success("Plan deleted");
      utils.executionPlan.list.invalidate();
      utils.executionPlan.get.invalidate({ id: params.planId });
      router.push(`/w/${ws.slug}/plans`);
    },
    onError: (e) => toast.error(e.message),
  });

  const addStep = trpc.executionPlan.addStep.useMutation({
    onSuccess: () => {
      utils.executionPlan.get.invalidate({ id: params.planId });
      toast.success("Step added");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateStep = trpc.executionPlan.updateStep.useMutation({
    onSuccess: () => {
      utils.executionPlan.get.invalidate({ id: params.planId });
    },
    onError: (e) => toast.error(e.message),
  });

  const removeStep = trpc.executionPlan.removeStep.useMutation({
    onSuccess: () => {
      utils.executionPlan.get.invalidate({ id: params.planId });
      toast.success("Step removed");
    },
    onError: (e) => toast.error(e.message),
  });

  // AXI-56 — turn an orchestration step into a first-class tracked Issue.
  const materializeStep = trpc.executionPlan.materializeStep.useMutation({
    onSuccess: (res) => {
      utils.executionPlan.get.invalidate({ id: params.planId });
      toast.success(
        res.created ? "Step materialized as issue" : "Step already has an issue",
      );
    },
    onError: (e) => toast.error(e.message),
  });

  const orderedSteps = useMemo<StepRow[]>(
    () =>
      (plan?.steps ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s) => {
          // Backend orchestration fields may not be on the typed row
          // until the Prisma client regenerates — read them loosely.
          const x = s as unknown as {
            retryCount?: number;
            judgeVerdict?: JudgeVerdict | null;
            childPlanId?: string | null;
            lastFeedback?: string | null;
            issue?: StepRow["issue"];
            runs?: OrchestrationAttentionRun[];
          };
          return {
            id: s.id,
            title: s.title,
            body: s.body,
            position: s.position,
            status: s.status,
            expectedOutput: s.expectedOutput,
            assignedAgentId: s.assignedAgentId,
            assignedUserId: s.assignedUserId,
            dependsOnStepIds: s.dependsOnStepIds ?? [],
            retryCount: x.retryCount ?? 0,
            judgeVerdict: x.judgeVerdict ?? null,
            childPlanId: x.childPlanId ?? null,
            lastFeedback: x.lastFeedback ?? null,
            issue: x.issue ?? null,
            runs: x.runs ?? [],
          };
        }),
    [plan?.steps],
  );

  const positionById = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of orderedSteps) map.set(s.id, s.position);
    return map;
  }, [orderedSteps]);

  // Inline auto-save state for the header (title + description).
  const [headTitle, setHeadTitle] = useState<string>("");
  const [headDescription, setHeadDescription] = useState<string>("");
  const [headEditing, setHeadEditing] = useState<null | "title" | "description">(null);
  const [headDirty, setHeadDirty] = useState(false);

  useEffect(() => {
    if (plan && !headEditing && !headDirty) {
      setHeadTitle(plan.title);
      setHeadDescription(plan.description ?? "");
    }
  }, [plan, headEditing, headDirty]);

  // Debounced auto-save for the header.
  useEffect(() => {
    if (!plan || !headDirty) return;
    const handle = setTimeout(() => {
      update.mutate(
        {
          id: plan.id,
          title: headTitle.trim() || undefined,
          description: headDescription.trim() ? headDescription : null,
        },
        {
          onSettled: () => setHeadDirty(false),
        },
      );
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headTitle, headDescription, headDirty, plan?.id]);

  // View toggle.
  const [view, setView] = useState<ViewMode>("list");

  type ConfirmState =
    | { kind: "remove-step"; stepId: string }
    | { kind: "archive" }
    | { kind: "delete" }
    | null;
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);

  // Track the operator's recent manual scroll so auto-scroll doesn't fight them.
  const lastUserScrollAt = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      lastUserScrollAt.current = Date.now();
    };
    window.addEventListener("wheel", onScroll, { passive: true });
    window.addEventListener("touchmove", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", onScroll);
      window.removeEventListener("touchmove", onScroll);
    };
  }, []);

  // Currently-running step (first one wins if multiple).
  const runningStep = useMemo(
    () => orderedSteps.find((s) => s.status === ExecutionStepStatus.RUNNING) ?? null,
    [orderedSteps],
  );
  const runningRef = useRef<HTMLDivElement | null>(null);
  const lastRunningId = useRef<string | null>(null);
  useEffect(() => {
    if (!runningStep) {
      lastRunningId.current = null;
      return;
    }
    if (lastRunningId.current === runningStep.id) return;
    lastRunningId.current = runningStep.id;
    const elapsed = Date.now() - lastUserScrollAt.current;
    if (elapsed < 5_000) return;
    const el = runningRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningStep?.id]);

  // Counts for the stacked progress bar.
  const counts = useMemo(() => {
    const c: Record<ExecutionStepStatus, number> = {
      TODO: 0,
      READY: 0,
      RUNNING: 0,
      BLOCKED: 0,
      REVIEW: 0,
      DONE: 0,
      CANCELED: 0,
    };
    for (const s of orderedSteps) c[s.status]++;
    return c;
  }, [orderedSteps]);
  const total = orderedSteps.length;
  const stepTones = useMemo(
    () => orderedSteps.map((s) => toneForStepStatus(s.status)),
    [orderedSteps],
  );

  // Orchestration contract reads (loose — these land on the schema via
  // the backend agent; optional-chained until types regenerate).
  const planX = plan as unknown as {
    totalCostUsd?: number | null;
    maxTotalCostUsd?: number | null;
    maxWallTimeMinutes?: number | null;
    startedAt?: string | Date | null;
    goalId?: string | null;
    goal?: { id: string; title: string; status: string } | null;
    autoJudge?: boolean;
    maxStepRetries?: number | null;
  } | undefined;
  const totalCostUsd = planX?.totalCostUsd ?? 0;
  const maxTotalCostUsd = planX?.maxTotalCostUsd ?? null;
  const maxWallTimeMinutes = planX?.maxWallTimeMinutes ?? null;
  // Wall-clock since the plan started running (P1.7 added `startedAt`).
  // Mirrors the goal cockpit; feeds the budget meter's wall-time bar.
  const planStartedAt = planX?.startedAt ?? null;
  const elapsedMinutes = planStartedAt
    ? (Date.now() - new Date(planStartedAt).getTime()) / 60_000
    : null;
  const goalId = planX?.goalId ?? planX?.goal?.id ?? null;
  const goalTitle = planX?.goal?.title ?? null;
  const hasBudget =
    maxTotalCostUsd != null || totalCostUsd > 0 || maxWallTimeMinutes != null;

  // Crew roster — embedded on `executionPlan.get`. Loosely read until
  // the Prisma client regenerates the `crew` relation onto the type.
  const crew =
    (plan as unknown as { crew?: CrewRosterData | null } | undefined)?.crew ?? null;

  // Which crew member has active or queued work — drives the roster
  // highlight. READY means the worker dispatch was queued and is waiting
  // for pickup/ack, so it should not read as idle.
  const activeByAgent = useMemo<ActiveStepByAgent>(() => {
    const m: ActiveStepByAgent = new Map();
    for (const s of orderedSteps) {
      if (ROSTER_ACTIVE_STEP_STATUSES.has(s.status) && s.assignedAgentId) {
        m.set(s.assignedAgentId, { id: s.id, title: s.title, status: s.status });
      }
    }
    return m;
  }, [orderedSteps]);

  const attention = useMemo(
    () => pickAttentionRun(orderedSteps),
    [orderedSteps],
  );

  // DAG view inputs — the graph consumes the same step rows the page
  // already has, plus a presence-light agent map keyed by id.
  const dagSteps = useMemo<DagStep[]>(
    () =>
      orderedSteps.map((s) => ({
        id: s.id,
        title: s.title,
        body: s.body,
        position: s.position,
        status: s.status,
        assignedAgentId: s.assignedAgentId,
        dependsOnStepIds: s.dependsOnStepIds,
        expectedOutput: s.expectedOutput,
        judgeVerdict: s.judgeVerdict
          ? {
              verdict: s.judgeVerdict.verdict,
              feedback: s.judgeVerdict.feedback ?? "",
              score: s.judgeVerdict.score ?? null,
              judgedByAgentId: s.judgeVerdict.judgedByAgentId ?? null,
              judgedAt: s.judgeVerdict.judgedAt ?? "",
            }
          : null,
        retryCount: s.retryCount,
        lastFeedback: s.lastFeedback,
        childPlanId: s.childPlanId,
      })),
    [orderedSteps],
  );
  const dagAgentsById = useMemo<Record<string, DagAgent>>(() => {
    const rec: Record<string, DagAgent> = {};
    for (const [id, a] of agentsById) {
      rec[id] = {
        id: a.id,
        name: a.name,
        profileKey: a.profileKey,
        status:
          a.status === "ONLINE" || a.status === "BUSY" ? a.status : "OFFLINE",
        avatar: a.image,
        availability: presenceAvailability(a),
      };
    }
    return rec;
  }, [agentsById]);

  // Optional canvas integration (Agent D delivers `canvas.createFromPlan`).
  // If the procedure isn't on the trpc proxy at runtime, we degrade
  // gracefully to a disabled button with a tooltip.
  const canvasRouterAny = (trpc as unknown as Record<string, unknown>).canvas as
    | Record<string, unknown>
    | undefined;
  const createFromPlanAny = canvasRouterAny?.createFromPlan as
    | {
        useMutation: (opts?: unknown) => {
          mutate: (input: { planId: string }) => void;
          isPending: boolean;
        };
      }
    | undefined;
  const canvasIntegrationAvailable = Boolean(createFromPlanAny);
  const createCanvasMut = createFromPlanAny?.useMutation({
    onSuccess: (result: { canvasId?: string } | undefined) => {
      const canvasId = result?.canvasId;
      if (canvasId) {
        router.push(`/w/${ws.slug}/canvas/${canvasId}`);
      } else {
        toast.error("Canvas creation returned no id.");
      }
    },
    onError: (e: { message: string }) => toast.error(e.message),
  }) as
    | { mutate: (input: { planId: string }) => void; isPending: boolean }
    | undefined;

  if (isLoading) {
    return (
      <>
        <Topbar title="Plan" />
        <div className="p-4">
          <SkeletonList rows={6} />
        </div>
      </>
    );
  }
  if (isError) {
    return (
      <>
        <Topbar title="Plan" />
        <div className="p-4">
          <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-6">
            <EmptyState
              variant="page"
              title="Couldn't load this plan"
              description="Something went wrong fetching it — this is a load error, not a deletion. The plan is still there."
            />
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        </div>
      </>
    );
  }
  if (!plan) {
    return (
      <>
        <Topbar title="Plan" />
        <div className="p-4">
          <EmptyState
            variant="page"
            title="Plan not found"
            description="This plan may have been archived or deleted."
          />
        </div>
      </>
    );
  }

  const savePending = update.isPending || headDirty;

  return (
    <>
      <Topbar
        title={plan.title}
        subtitle={`Plan · ${plan.status.toLowerCase()} · ${orderedSteps.length} steps`}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/w/${ws.slug}/plans`)}
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </Button>
            <SaveIndicator pending={savePending} />
            <Button
              size="sm"
              variant="ghost"
              disabled={
                !canvasIntegrationAvailable ||
                !createCanvasMut ||
                createCanvasMut.isPending
              }
              title={
                canvasIntegrationAvailable
                  ? "Open this plan as a canvas"
                  : "Canvas integration loading"
              }
              onClick={() => {
                if (!createCanvasMut) return;
                createCanvasMut.mutate({ planId: plan.id });
              }}
            >
              <Network className="h-3.5 w-3.5" /> Open as Canvas
            </Button>
          </>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_280px]">
        <section className="flex min-w-0 flex-col gap-4">
          {plan.status === ExecutionPlanStatus.DRAFT ? (
            <PlanApproval
              planId={plan.id}
              issueNumber={plan.issue?.number ?? null}
              workspaceSlug={ws.slug}
              workspaceKey={ws.key}
              onApproved={() => {
                utils.executionPlan.get.invalidate({ id: plan.id });
                utils.executionPlan.list.invalidate();
              }}
            />
          ) : null}

          {plan.status === ExecutionPlanStatus.APPROVED ? (
            <PlanStartBanner
              busy={activate.isPending}
              onStart={() => activate.mutate({ id: plan.id })}
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
              onChanged={() => {
                utils.executionPlan.get.invalidate({ id: plan.id });
                utils.executionPlan.list.invalidate();
              }}
            />
          ) : null}

          {goalId ? (
            <a
              href={`/w/${ws.slug}/goals/${goalId}`}
              className="group inline-flex items-center gap-1.5 self-start rounded-md border border-border bg-card/40 px-2.5 py-1 text-meta text-muted-foreground transition hover:border-ember/40 hover:text-foreground"
            >
              <Target className="h-3 w-3 text-ember" />
              <span className="uppercase tracking-wide">Goal ·</span>
              <span className="truncate group-hover:text-ember">
                {goalTitle ?? "view goal"}
              </span>
            </a>
          ) : null}

          <header className="rounded-lg border border-border bg-card/40 p-4">
            <input
              value={headTitle}
              onChange={(e) => {
                setHeadTitle(e.target.value);
                setHeadDirty(true);
              }}
              onFocus={() => setHeadEditing("title")}
              onBlur={() => setHeadEditing(null)}
              className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold leading-snug outline-none transition-colors hover:border-border focus:border-border focus:bg-card/40"
              aria-label="Plan title"
            />
            <div className="mt-2">
              {headEditing === "description" ? (
                <textarea
                  autoFocus
                  value={headDescription}
                  onChange={(e) => {
                    setHeadDescription(e.target.value);
                    setHeadDirty(true);
                  }}
                  onBlur={() => setHeadEditing(null)}
                  onKeyDown={(e) => {
                    // Cmd/Ctrl+Enter commits by blurring — the onBlur
                    // handler then closes the editor and the parent
                    // autosave effect picks up the dirty flag. Esc also
                    // blurs (existing autosave runs on the dirty body —
                    // matches the same "implicit save" semantics as
                    // clicking outside).
                    if (
                      ((e.metaKey || e.ctrlKey) && e.key === "Enter") ||
                      e.key === "Escape"
                    ) {
                      e.preventDefault();
                      (e.currentTarget as HTMLTextAreaElement).blur();
                    }
                  }}
                  rows={6}
                  placeholder="Description (markdown supported)…"
                  className="w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setHeadEditing("description")}
                  className="block w-full rounded-md border border-transparent px-2 py-1 text-left transition-colors hover:border-border"
                  aria-label="Edit plan description"
                >
                  {headDescription.trim() ? (
                    <div className="text-sm text-muted-foreground">
                      <ChatMarkdown body={headDescription} />
                    </div>
                  ) : (
                    <p className="text-meta text-muted-foreground">
                      No description yet. Click to add one.
                    </p>
                  )}
                </button>
              )}
            </div>

            <ProgressBar counts={counts} total={total} />
            {total > 0 ? (
              <DagStepStrip
                tones={stepTones}
                done={counts.DONE}
                total={total}
                showLabel={false}
                className="mt-3 overflow-x-auto"
              />
            ) : null}
          </header>

          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-1 rounded-md border border-border bg-card/40 p-0.5 text-meta">
              <button
                type="button"
                onClick={() => setView("list")}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 transition-colors",
                  view === "list"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={view === "list"}
              >
                <LayoutList className="h-3 w-3" /> List
              </button>
              <button
                type="button"
                onClick={() => setView("timeline")}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 transition-colors",
                  view === "timeline"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={view === "timeline"}
              >
                <ListTree className="h-3 w-3" /> Timeline
              </button>
              <button
                type="button"
                onClick={() => setView("graph")}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 transition-colors",
                  view === "graph"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={view === "graph"}
              >
                <Workflow className="h-3 w-3" /> Graph
              </button>
            </div>
            <span className="text-meta text-muted-foreground">
              {total} step{total === 1 ? "" : "s"}
            </span>
          </div>

          {view === "list" ? (
            <StepsList
              steps={orderedSteps}
              positionById={positionById}
              agentsById={agentsById}
              workspaceSlug={ws.slug}
              runningStepId={runningStep?.id ?? null}
              runningRef={runningRef}
              onTransitionStep={(id, status) => updateStep.mutate({ id, status })}
              onPatchStep={(id, patch) => updateStep.mutate({ id, ...patch })}
              onRemoveStep={(id) => setConfirmState({ kind: "remove-step", stepId: id })}
              onMaterializeStep={(id) => materializeStep.mutate({ stepId: id })}
              materializingStepId={
                materializeStep.isPending
                  ? (materializeStep.variables?.stepId ?? null)
                  : null
              }
            />
          ) : view === "timeline" ? (
            <TimelineView
              steps={orderedSteps}
              positionById={positionById}
              agentsById={agentsById}
              workspaceSlug={ws.slug}
              runningStepId={runningStep?.id ?? null}
              runningRef={runningRef}
              onTransitionStep={(id, status) => updateStep.mutate({ id, status })}
            />
          ) : (
            <div className="rounded-lg border border-border bg-card/40 p-2">
              <DagView
                steps={dagSteps}
                agentsById={dagAgentsById}
                planHref={`/w/${ws.slug}/plans/${plan.id}`}
                className="max-h-[60vh]"
              />
            </div>
          )}

          <AddStepForm
            disabled={addStep.isPending}
            onAdd={(payload) => addStep.mutate({ planId: plan.id, ...payload })}
          />
        </section>

        <aside className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-card/40 p-3">
            <div className="mb-2 text-meta uppercase tracking-wide text-muted-foreground">
              Plan status
            </div>
            <select
              value={plan.status}
              onChange={(e) => {
                const next = e.target.value as ExecutionPlanStatus;
                if (next === ExecutionPlanStatus.RUNNING) {
                  activate.mutate({ id: plan.id });
                  return;
                }
                update.mutate({ id: plan.id, status: next });
              }}
              disabled={activate.isPending || update.isPending}
              className={cn(
                "w-full rounded-md border border-border bg-card/40 px-2 py-1 text-xs",
                PLAN_STATUS_TONE[plan.status],
              )}
            >
              {PLAN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          {hasBudget ? (
            <div className="rounded-lg border border-border bg-card/40 p-3">
              <BudgetMeter
                spent={totalCostUsd}
                cap={maxTotalCostUsd}
                wallTimeMinutes={maxWallTimeMinutes}
                elapsedMinutes={elapsedMinutes}
              />
            </div>
          ) : null}

          <CrewRosterPanel crew={crew} activeByAgent={activeByAgent} />

          <div className="rounded-lg border border-border bg-card/40 p-3 text-meta">
            <div className="mb-2 uppercase tracking-wide text-muted-foreground">Links</div>
            <ul className="flex flex-col gap-2 text-sm">
              {plan.issue ? (
                <li>
                  <span className="text-muted-foreground">Issue · </span>
                  <a
                    href={`/w/${ws.slug}/i/${ws.key}-${plan.issue.number}`}
                    className="text-ember hover:underline"
                  >
                    {ws.key}-{plan.issue.number} · {plan.issue.title}
                  </a>
                </li>
              ) : null}
              {plan.project ? (
                <li>
                  <span className="text-muted-foreground">Project · </span>
                  <a
                    href={`/w/${ws.slug}/projects/${plan.project.key}`}
                    className="text-ember hover:underline"
                  >
                    {plan.project.name}
                  </a>
                </li>
              ) : null}
              {plan.contextSet ? (
                <li>
                  <span className="text-muted-foreground">Context set · </span>
                  <span>{plan.contextSet.name}</span>
                </li>
              ) : null}
              {!plan.issue && !plan.project && !plan.contextSet ? (
                <li className="text-muted-foreground">No links.</li>
              ) : null}
            </ul>
          </div>

          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="text-warning"
              onClick={() => setConfirmState({ kind: "archive" })}
              disabled={archive.isPending}
            >
              <Archive className="h-3.5 w-3.5" /> Archive plan
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmState({ kind: "delete" })}
              disabled={deleteM.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete plan
            </Button>
          </div>
        </aside>
      </div>

      <Confirm
        open={confirmState?.kind === "remove-step"}
        onOpenChange={(o) => {
          if (!o) setConfirmState(null);
        }}
        title="Remove step?"
        description="The step will be deleted from this plan."
        primaryLabel="Remove step"
        variant="destructive"
        loading={removeStep.isPending}
        onConfirm={() => {
          if (confirmState?.kind !== "remove-step") return;
          const stepId = confirmState.stepId;
          removeStep.mutate(
            { id: stepId },
            { onSettled: () => setConfirmState(null) },
          );
        }}
      />

      <Confirm
        open={confirmState?.kind === "archive"}
        onOpenChange={(o) => {
          if (!o) setConfirmState(null);
        }}
        title="Archive plan?"
        description="Hides the plan from the active list. You can restore it later."
        primaryLabel="Archive plan"
        variant="destructive"
        loading={archive.isPending}
        onConfirm={() =>
          archive.mutate(
            { id: plan.id },
            { onSettled: () => setConfirmState(null) },
          )
        }
      />

      <Confirm
        open={confirmState?.kind === "delete"}
        onOpenChange={(o) => {
          if (!o) setConfirmState(null);
        }}
        title="Delete plan?"
        description={
          <>
            This permanently removes the plan and its steps. Type the
            plan&apos;s title to confirm.
          </>
        }
        variant="destructive"
        typeToConfirm={plan.title}
        primaryLabel="Delete plan"
        loading={deleteM.isPending}
        onConfirm={() =>
          deleteM.mutate(
            { id: plan.id, confirm: plan.title },
            { onSettled: () => setConfirmState(null) },
          )
        }
      />
    </>
  );
}

/**
 * Approval surface for DRAFT plans, with a clear precedence:
 *
 *   1. PROPER PATH — if the backend opened an approval ActionRequest
 *      (`sourceType="execution-plan"`, `sourceId=planId`, created by
 *      `plans.requestApproval`), render the inline `<ActionRequestCard
 *      planId>`. Accepting it runs the real activation server-side:
 *      DRAFT→RUNNING + goal→ACTIVE + crew kickoff. This is preferred
 *      because the direct status flip below skips that dispatch.
 *
 *   2. FALLBACK — if NO ActionRequest exists (e.g. a plan created before
 *      this flow shipped, or a hand-authored draft), fall back to the
 *      `<PlanApprovalBanner>` whose "Approve" button flips the plan to
 *      APPROVED via `executionPlan.update`. Last resort only.
 *
 * The card self-fetches via `actionRequest.forPlan`; we fetch the same
 * row here to decide which surface to show (the card renders `null`
 * when none is bound, so without this gate the operator would see no
 * approval affordance at all for legacy drafts).
 */
function PlanApproval({
  planId,
  issueNumber,
  workspaceSlug,
  workspaceKey,
  onApproved,
}: {
  planId: string;
  issueNumber: number | null;
  workspaceSlug: string;
  workspaceKey: string;
  onApproved: () => void;
}) {
  const { data: request, isLoading } = trpc.actionRequest.forPlan.useQuery(
    { planId },
    { staleTime: 30_000 },
  );

  // Don't flash the fallback while the lookup is in flight.
  if (isLoading) return null;

  // Proper path: an open/bound ActionRequest drives activation.
  if (request) {
    return (
      <ActionRequestCard
        planId={planId}
        onResolved={onApproved}
      />
    );
  }

  // Last-resort fallback: no ActionRequest — direct status flip.
  return (
    <PlanApprovalBanner
      planId={planId}
      issueNumber={issueNumber}
      workspaceSlug={workspaceSlug}
      workspaceKey={workspaceKey}
      onApproved={onApproved}
    />
  );
}

/**
 * Fallback "Pending your approval" banner for DRAFT plans with NO bound
 * ActionRequest. Uses the same activation path as accepting the
 * ActionRequest: DRAFT/APPROVED → RUNNING, goal → ACTIVE, root steps
 * dispatched. Only rendered by `<PlanApproval>` when no ActionRequest exists.
 */
function PlanApprovalBanner({
  planId,
  issueNumber,
  workspaceSlug,
  workspaceKey,
  onApproved,
}: {
  planId: string;
  issueNumber: number | null;
  workspaceSlug: string;
  workspaceKey: string;
  onApproved: () => void;
}) {
  const approve = trpc.executionPlan.activate.useMutation({
    onSuccess: () => {
      toast.success("Plan approved · crew started");
      onApproved();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border-l-2 border-y border-r border-l-ember border-y-border border-r-border bg-ember/[0.05] p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-ember" />
        <span className="text-sm font-medium">Pending your approval</span>
      </div>
      <p className="text-meta text-muted-foreground">
        A planner finished decomposing this goal into steps. Approve to
        let the crew start executing.
        {issueNumber != null
          ? " The full Accept / Decline recommendation lives on the source issue."
          : ""}
      </p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button
          size="sm"
          variant="ember"
          disabled={approve.isPending}
          onClick={() => approve.mutate({ id: planId })}
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Approve and start
        </Button>
        {issueNumber != null ? (
          <a
            href={`/w/${workspaceSlug}/i/${workspaceKey}-${issueNumber}`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-meta text-muted-foreground transition hover:text-foreground"
          >
            Review on issue
          </a>
        ) : null}
      </div>
    </div>
  );
}

function PlanStartBanner({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border-l-2 border-y border-r border-l-ember border-y-border border-r-border bg-ember/[0.05] p-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-ember" />
        <span className="text-sm font-medium">Approved, not running</span>
      </div>
      <p className="text-meta text-muted-foreground">
        This plan was approved before the crew kickoff ran. Start it to flip
        the goal active and dispatch the ready root steps.
      </p>
      <div>
        <Button size="sm" variant="ember" disabled={busy} onClick={onStart}>
          <CheckCircle2 className="h-3.5 w-3.5" />
          {busy ? "Starting…" : "Start crew"}
        </Button>
      </div>
    </div>
  );
}

function SaveIndicator({ pending }: { pending: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-meta transition-opacity",
        pending ? "text-muted-foreground" : "text-muted-foreground/70",
      )}
      aria-live="polite"
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full transition-colors",
          pending ? "bg-ember animate-pulse" : "bg-success",
        )}
        aria-hidden
      />
      {pending ? "saving…" : "saved"}
    </span>
  );
}

function ProgressBar({
  counts,
  total,
}: {
  counts: Record<ExecutionStepStatus, number>;
  total: number;
}) {
  if (total === 0) return null;
  const order: ExecutionStepStatus[] = [
    ExecutionStepStatus.DONE,
    ExecutionStepStatus.REVIEW,
    ExecutionStepStatus.RUNNING,
    ExecutionStepStatus.READY,
    ExecutionStepStatus.BLOCKED,
    ExecutionStepStatus.CANCELED,
    ExecutionStepStatus.TODO,
  ];
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-subtle">
        {order.map((s) => {
          const n = counts[s];
          if (!n) return null;
          const pct = (n / total) * 100;
          return (
            <div
              key={s}
              className={cn("h-full transition-all duration-300", STEP_STATUS_BAR[s])}
              style={{ width: `${pct}%` }}
              title={`${s.toLowerCase()}: ${n}`}
            />
          );
        })}
      </div>
      <div className="text-meta text-muted-foreground">
        {counts.DONE}/{total} done
        {counts.RUNNING > 0 ? ` · ${counts.RUNNING} running` : ""}
        {counts.BLOCKED > 0 ? ` · ${counts.BLOCKED} blocked` : ""}
      </div>
    </div>
  );
}

function StepsList({
  steps,
  positionById,
  agentsById,
  workspaceSlug,
  runningStepId,
  runningRef,
  onTransitionStep,
  onPatchStep,
  onRemoveStep,
  onMaterializeStep,
  materializingStepId,
}: {
  steps: StepRow[];
  positionById: Map<string, number>;
  agentsById: Map<string, AgentLite>;
  workspaceSlug: string;
  runningStepId: string | null;
  runningRef: React.RefObject<HTMLDivElement | null>;
  onTransitionStep: (id: string, status: ExecutionStepStatus) => void;
  onPatchStep: (
    id: string,
    patch: { title?: string; expectedOutput?: string | null; body?: string | null },
  ) => void;
  onRemoveStep: (id: string) => void;
  onMaterializeStep: (id: string) => void;
  materializingStepId: string | null;
}) {
  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/20 p-4 text-meta text-muted-foreground">
        No steps yet. Add the first one below.
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, idx) => (
        <li
          key={step.id}
          className="forge-row-rise"
          style={{ "--row-i": idx } as React.CSSProperties}
        >
          <StepCard
            step={step}
            index={idx}
            agent={step.assignedAgentId ? agentsById.get(step.assignedAgentId) ?? null : null}
            depsLabel={dependencyLabel(step, positionById)}
            workspaceSlug={workspaceSlug}
            running={step.id === runningStepId}
            attachRef={step.id === runningStepId ? runningRef : undefined}
            onTransition={(status) => onTransitionStep(step.id, status)}
            onPatch={(patch) => onPatchStep(step.id, patch)}
            onRemove={() => onRemoveStep(step.id)}
            onMaterialize={() => onMaterializeStep(step.id)}
            materializing={step.id === materializingStepId}
          />
        </li>
      ))}
    </ol>
  );
}

function StepCard({
  step,
  index,
  agent,
  depsLabel,
  workspaceSlug,
  running,
  attachRef,
  onTransition,
  onPatch,
  onRemove,
  onMaterialize,
  materializing,
}: {
  step: StepRow;
  index: number;
  agent: AgentLite | null;
  depsLabel: string | null;
  workspaceSlug: string;
  running: boolean;
  attachRef?: React.RefObject<HTMLDivElement | null>;
  onTransition: (status: ExecutionStepStatus) => void;
  onPatch: (patch: {
    title?: string;
    expectedOutput?: string | null;
    body?: string | null;
  }) => void;
  onRemove: () => void;
  onMaterialize: () => void;
  materializing: boolean;
}) {
  const [title, setTitle] = useState(step.title);
  const [body, setBody] = useState(step.body ?? "");
  const [expected, setExpected] = useState(step.expectedOutput ?? "");
  const [editingField, setEditingField] = useState<null | "title" | "body" | "expected">(
    null,
  );
  const [dirty, setDirty] = useState<{ title: boolean; body: boolean; expected: boolean }>(
    { title: false, body: false, expected: false },
  );

  // Sync from server when not actively editing.
  useEffect(() => {
    if (!dirty.title && editingField !== "title") setTitle(step.title);
  }, [step.title, dirty.title, editingField]);
  useEffect(() => {
    if (!dirty.body && editingField !== "body") setBody(step.body ?? "");
  }, [step.body, dirty.body, editingField]);
  useEffect(() => {
    if (!dirty.expected && editingField !== "expected") setExpected(step.expectedOutput ?? "");
  }, [step.expectedOutput, dirty.expected, editingField]);

  // Debounced auto-save per field.
  useEffect(() => {
    if (!dirty.title) return;
    const h = setTimeout(() => {
      const next = title.trim();
      if (!next) {
        setDirty((d) => ({ ...d, title: false }));
        return;
      }
      onPatch({ title: next });
      setDirty((d) => ({ ...d, title: false }));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, dirty.title]);

  useEffect(() => {
    if (!dirty.body) return;
    const h = setTimeout(() => {
      onPatch({ body: body.trim() ? body : null });
      setDirty((d) => ({ ...d, body: false }));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, dirty.body]);

  useEffect(() => {
    if (!dirty.expected) return;
    const h = setTimeout(() => {
      onPatch({ expectedOutput: expected.trim() ? expected : null });
      setDirty((d) => ({ ...d, expected: false }));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expected, dirty.expected]);

  return (
    <div
      ref={attachRef}
      data-status={step.status}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card/40 p-3 transition-all duration-300 motion-safe:animate-in motion-safe:fade-in",
        running
          ? "forge-active-node border-ember/40"
          : step.status === ExecutionStepStatus.BLOCKED
            ? "border-warning/40"
            : step.judgeVerdict?.verdict === "FAIL"
              ? "border-danger/40"
              : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-mono transition-colors",
            running
              ? "bg-ember/15 text-ember motion-safe:animate-pulse"
              : "bg-subtle text-muted-foreground",
          )}
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty((d) => ({ ...d, title: true }));
            }}
            onFocus={() => setEditingField("title")}
            onBlur={() => setEditingField(null)}
            className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium leading-snug outline-none transition-colors hover:border-border focus:border-border focus:bg-card/40"
            aria-label={`Step ${index + 1} title`}
          />

          <StepMetaStrip
            agent={agent}
            depsLabel={depsLabel}
            retryCount={step.retryCount}
            childPlanId={step.childPlanId}
            workspaceSlug={workspaceSlug}
            issue={step.issue}
            onMaterialize={onMaterialize}
            materializing={materializing}
          />

          {step.judgeVerdict ? (
            <JudgeVerdictBlock verdict={step.judgeVerdict} agentName={agent?.name ?? null} />
          ) : null}
          {editingField === "body" ? (
            <textarea
              autoFocus
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setDirty((d) => ({ ...d, body: true }));
              }}
              onBlur={() => setEditingField(null)}
              onKeyDown={(e) => {
                if (
                  ((e.metaKey || e.ctrlKey) && e.key === "Enter") ||
                  e.key === "Escape"
                ) {
                  e.preventDefault();
                  (e.currentTarget as HTMLTextAreaElement).blur();
                }
              }}
              rows={4}
              placeholder="Body (markdown supported)…"
              className="mt-1 w-full resize-y rounded-md border border-border bg-card/40 px-2 py-1 text-sm"
            />
          ) : body.trim() ? (
            <button
              type="button"
              onClick={() => setEditingField("body")}
              className="mt-1 block w-full rounded-md border border-transparent px-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:border-border"
              aria-label={`Edit step ${index + 1} body`}
            >
              <ChatMarkdown body={body} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditingField("body")}
              className="mt-1 text-meta text-muted-foreground/70 hover:text-muted-foreground"
            >
              + Add body…
            </button>
          )}
          {editingField === "expected" ? (
            <textarea
              autoFocus
              value={expected}
              onChange={(e) => {
                setExpected(e.target.value);
                setDirty((d) => ({ ...d, expected: true }));
              }}
              onBlur={() => setEditingField(null)}
              onKeyDown={(e) => {
                if (
                  ((e.metaKey || e.ctrlKey) && e.key === "Enter") ||
                  e.key === "Escape"
                ) {
                  e.preventDefault();
                  (e.currentTarget as HTMLTextAreaElement).blur();
                }
              }}
              rows={3}
              placeholder="Expected output (markdown supported)…"
              className="mt-1 w-full resize-y rounded-md border border-border bg-card/40 px-2 py-1 text-meta"
            />
          ) : expected.trim() ? (
            <button
              type="button"
              onClick={() => setEditingField("expected")}
              className="mt-1 block w-full rounded-md border border-transparent px-2 py-1 text-left text-meta text-muted-foreground transition-colors hover:border-border"
              aria-label={`Edit step ${index + 1} expected output`}
            >
              <span className="uppercase tracking-wide opacity-70">Expected: </span>
              <ChatMarkdown body={expected} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditingField("expected")}
              className="mt-1 text-meta text-muted-foreground/70 hover:text-muted-foreground"
            >
              + Add expected output…
            </button>
          )}
          <div className="mt-2">
            <StepComments stepId={step.id} />
          </div>
        </div>
        <select
          value={step.status}
          onChange={(e) => onTransition(e.target.value as ExecutionStepStatus)}
          className={cn(
            "shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] uppercase",
            STEP_STATUS_TONE[step.status],
          )}
        >
          {STEP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-end gap-2">
        <FieldSaveTick pending={dirty.title || dirty.body || dirty.expected} />
        <Button size="sm" variant="ghost" className="text-warning" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function FieldSaveTick({ pending }: { pending: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-meta",
        pending ? "text-muted-foreground" : "text-muted-foreground/60",
      )}
      aria-live="polite"
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full transition-colors",
          pending ? "bg-ember animate-pulse" : "bg-success/70",
        )}
        aria-hidden
      />
      {pending ? "saving…" : "saved"}
    </span>
  );
}

/**
 * Compact meta strip under a step's title: assigned-agent glyph +
 * presence dot, dependency chips, retry-count badge, and a sub-plan
 * deep-link when the step spawned a child plan. Renders nothing when the
 * step carries none of these — keeps quiet steps clean.
 */
function StepMetaStrip({
  agent,
  depsLabel,
  retryCount,
  childPlanId,
  workspaceSlug,
  issue,
  onMaterialize,
  materializing,
}: {
  agent: AgentLite | null;
  depsLabel: string | null;
  retryCount: number;
  childPlanId: string | null;
  workspaceSlug: string;
  // AXI-56 — materialized-issue provenance + action. Optional so the
  // read-only graph/timeline meta strip can omit them.
  issue?: StepRow["issue"];
  onMaterialize?: () => void;
  materializing?: boolean;
}) {
  const canMaterialize = !issue && !!onMaterialize;
  const hasAny =
    agent || depsLabel || retryCount > 0 || childPlanId || issue || canMaterialize;
  if (!hasAny) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-meta text-muted-foreground">
      {agent ? (
        <span
          className="inline-flex items-center gap-1"
          title={`Assigned to @${agent.profileKey}`}
        >
          <span className="relative inline-flex items-center">
            <Avatar name={agent.name} image={agent.image} size={16} />
            <AgentPresenceDot
              status={agent.status}
              lastHeartbeatAt={agent.lastHeartbeatAt}
              availability={presenceAvailability(agent)}
              className="absolute -bottom-0.5 -right-0.5 ring-1 ring-card"
            />
          </span>
          <span className="font-mono text-id">@{agent.profileKey}</span>
        </span>
      ) : null}
      {depsLabel ? (
        <span
          className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5"
          title={`Runs after step(s) ${depsLabel}`}
        >
          after {depsLabel}
        </span>
      ) : null}
      {retryCount > 0 ? (
        <span
          className="inline-flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-warning"
          title={`Retried ${retryCount} time${retryCount === 1 ? "" : "s"}`}
        >
          <RotateCcw className="h-2.5 w-2.5" />
          {retryCount}
        </span>
      ) : null}
      {childPlanId ? (
        <a
          href={`/w/${workspaceSlug}/plans/${childPlanId}`}
          className="inline-flex items-center gap-1 rounded bg-ember/10 px-1.5 py-0.5 text-ember hover:bg-ember/20"
          title="Open the sub-plan this step spawned"
        >
          <CornerDownRight className="h-2.5 w-2.5" />
          sub-plan
        </a>
      ) : null}
      {issue ? (
        <a
          href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
          className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 hover:bg-subtle/70"
          title={`Tracked as ${issue.workspace.key}-${issue.number}: ${issue.title}`}
        >
          <span className="font-mono text-id">
            {issue.workspace.key}-{issue.number}
          </span>
        </a>
      ) : canMaterialize ? (
        <button
          type="button"
          onClick={onMaterialize}
          disabled={materializing}
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-subtle disabled:opacity-50"
          title="Create a tracked issue from this step"
        >
          <FilePlus2 className="h-2.5 w-2.5" />
          {materializing ? "materializing…" : "Materialize as issue"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Inline judge verdict. PASS reads quiet (it's the expected happy path);
 * FAIL is prominent — it's why a step is retrying — with the feedback
 * expandable so the operator can read why the judge rejected the work.
 */
function JudgeVerdictBlock({
  verdict,
  agentName,
}: {
  verdict: JudgeVerdict;
  agentName: string | null;
}) {
  const fail = verdict.verdict === "FAIL";
  const [expanded, setExpanded] = useState(fail);
  const feedback = verdict.feedback?.trim();

  return (
    <div
      className={cn(
        "mt-1.5 rounded-md border px-2 py-1.5 text-meta transition-colors motion-safe:animate-in motion-safe:fade-in",
        fail
          ? "border-danger/40 bg-danger/[0.05]"
          : "border-success/30 bg-success/[0.05]",
      )}
    >
      <button
        type="button"
        onClick={() => feedback && setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={feedback ? expanded : undefined}
      >
        {fail ? (
          <XCircle className="h-3 w-3 shrink-0 text-danger" />
        ) : (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
        )}
        <span
          className={cn(
            "font-medium uppercase tracking-wide",
            fail ? "text-danger" : "text-success",
          )}
        >
          Judge · {verdict.verdict.toLowerCase()}
        </span>
        {typeof verdict.score === "number" ? (
          <span className="font-mono text-muted-foreground">
            {Math.round(verdict.score * 100) / 100}
          </span>
        ) : null}
        {agentName ? (
          <span className="text-muted-foreground">· {agentName}</span>
        ) : null}
        {feedback && !expanded ? (
          <span className="ml-auto text-muted-foreground/70">show feedback</span>
        ) : null}
      </button>
      {feedback && expanded ? (
        <p
          className={cn(
            "mt-1 whitespace-pre-wrap break-words",
            fail ? "text-foreground/90" : "text-muted-foreground",
          )}
        >
          {feedback}
        </p>
      ) : null}
    </div>
  );
}

function TimelineView({
  steps,
  positionById,
  agentsById,
  workspaceSlug,
  runningStepId,
  runningRef,
  onTransitionStep,
}: {
  steps: StepRow[];
  positionById: Map<string, number>;
  agentsById: Map<string, AgentLite>;
  workspaceSlug: string;
  runningStepId: string | null;
  runningRef: React.RefObject<HTMLDivElement | null>;
  onTransitionStep: (id: string, status: ExecutionStepStatus) => void;
}) {
  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/20 p-4 text-meta text-muted-foreground">
        No steps yet. Add the first one below.
      </div>
    );
  }
  return (
    <ol className="relative flex flex-col">
      {steps.map((step, idx) => {
        const next = steps[idx + 1] ?? null;
        const isRunning = step.id === runningStepId;
        return (
          <TimelineRow
            key={step.id}
            step={step}
            agent={step.assignedAgentId ? agentsById.get(step.assignedAgentId) ?? null : null}
            workspaceSlug={workspaceSlug}
            isRunning={isRunning}
            isLast={!next}
            attachRef={isRunning ? runningRef : undefined}
            depsLabel={dependencyLabel(step, positionById)}
            onTransition={(status) => onTransitionStep(step.id, status)}
          />
        );
      })}
    </ol>
  );
}

function dependencyLabel(step: StepRow, positionById: Map<string, number>): string | null {
  if (!step.dependsOnStepIds.length) return null;
  const positions = step.dependsOnStepIds
    .map((id) => positionById.get(id))
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  if (!positions.length) return null;
  return positions.map((n) => `#${n}`).join(", ");
}

function TimelineRow({
  step,
  agent,
  workspaceSlug,
  isRunning,
  isLast,
  attachRef,
  depsLabel,
  onTransition,
}: {
  step: StepRow;
  agent: AgentLite | null;
  workspaceSlug: string;
  isRunning: boolean;
  isLast: boolean;
  attachRef?: React.RefObject<HTMLDivElement | null>;
  depsLabel: string | null;
  onTransition: (status: ExecutionStepStatus) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const onToggle = useCallback(() => setExpanded((v) => !v), []);
  const connectorTone = STEP_STATUS_BAR[step.status];

  return (
    <li className="flex">
      <div className="relative flex w-10 shrink-0 flex-col items-center">
        <span
          className={cn(
            "z-10 mt-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-[10px] font-mono text-muted-foreground transition-colors",
            isRunning && "border-ember/40 text-ember shadow-sm",
          )}
        >
          {step.position}
        </span>
        {!isLast ? (
          <div
            className={cn(
              "w-0.5 flex-1 rounded-full transition-colors duration-300",
              connectorTone,
            )}
          />
        ) : null}
      </div>
      <div
        ref={attachRef}
        className={cn(
          "mb-2 ml-2 flex-1 rounded-lg border bg-card/40 px-3 py-2 transition-all duration-300",
          isRunning
            ? "border-ember/40 ring-1 ring-ember/30 shadow-sm"
            : "border-border",
        )}
      >
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col items-start">
            <button
              type="button"
              onClick={onToggle}
              className="w-full text-left"
              aria-expanded={expanded}
            >
              <p className="break-words text-sm font-medium leading-snug">{step.title}</p>
            </button>
            <StepMetaStrip
              agent={agent}
              depsLabel={depsLabel}
              retryCount={step.retryCount}
              childPlanId={step.childPlanId}
              workspaceSlug={workspaceSlug}
            />
          </div>
          <select
            value={step.status}
            onChange={(e) => onTransition(e.target.value as ExecutionStepStatus)}
            className={cn(
              "shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] uppercase",
              STEP_STATUS_TONE[step.status],
            )}
          >
            {STEP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        {step.judgeVerdict ? (
          <JudgeVerdictBlock verdict={step.judgeVerdict} agentName={agent?.name ?? null} />
        ) : null}
        {expanded ? (
          <div className="mt-2 flex flex-col gap-2 border-t border-border/50 pt-2">
            {step.body?.trim() ? (
              <div className="text-sm text-muted-foreground">
                <ChatMarkdown body={step.body} />
              </div>
            ) : null}
            {step.expectedOutput?.trim() ? (
              <div className="text-meta text-muted-foreground">
                <span className="uppercase tracking-wide opacity-70">Expected: </span>
                <ChatMarkdown body={step.expectedOutput} />
              </div>
            ) : null}
            {!step.body?.trim() && !step.expectedOutput?.trim() ? (
              <p className="text-meta text-muted-foreground/70">
                No body or expected output.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function AddStepForm({
  onAdd,
  disabled,
}: {
  onAdd: (payload: { title: string; expectedOutput?: string | null }) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [expected, setExpected] = useState("");

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" /> Add step
      </Button>
    );
  }

  const cancel = () => {
    setOpen(false);
    setTitle("");
    setExpected("");
  };
  const commit = () => {
    if (disabled || !title.trim()) return;
    onAdd({
      title: title.trim(),
      expectedOutput: expected.trim() || null,
    });
    setTitle("");
    setExpected("");
    setOpen(false);
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card/20 p-3">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="Step title (what needs to happen)…"
        className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
      />
      <textarea
        value={expected}
        onChange={(e) => setExpected(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        rows={3}
        placeholder="Expected output (optional, markdown supported)"
        className="w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-meta"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button
          variant="ember"
          size="sm"
          disabled={disabled || !title.trim()}
          onClick={commit}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}
