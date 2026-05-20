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
  ChevronLeft,
  LayoutList,
  ListTree,
  Network,
  Plus,
  Trash2,
} from "lucide-react";
import { ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";
import { StepComments } from "@/components/plans/step-comments";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
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
  APPROVED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  COMPLETED: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

const STEP_STATUS_TONE: Record<ExecutionStepStatus, string> = {
  TODO: "bg-subtle text-muted-foreground",
  READY: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  REVIEW: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  DONE: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

// Used for the timeline connector and the stacked progress bar.
const STEP_STATUS_BAR: Record<ExecutionStepStatus, string> = {
  TODO: "bg-muted/50",
  READY: "bg-emerald-500/50",
  RUNNING: "bg-ember",
  BLOCKED: "bg-warning",
  REVIEW: "bg-amber-500",
  DONE: "bg-emerald-700",
  CANCELED: "bg-muted/40",
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
};

type ViewMode = "list" | "timeline";

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

  const { data: plan, isLoading } = trpc.executionPlan.get.useQuery({ id: params.planId });

  const update = trpc.executionPlan.update.useMutation({
    onSuccess: () => {
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

  const orderedSteps = useMemo<StepRow[]>(
    () =>
      (plan?.steps ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s) => ({
          id: s.id,
          title: s.title,
          body: s.body,
          position: s.position,
          status: s.status,
          expectedOutput: s.expectedOutput,
          assignedAgentId: s.assignedAgentId,
          assignedUserId: s.assignedUserId,
          dependsOnStepIds: s.dependsOnStepIds ?? [],
        })),
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
          <header className="rounded-lg border border-border bg-card/40 p-4">
            <input
              value={headTitle}
              onChange={(e) => {
                setHeadTitle(e.target.value);
                setHeadDirty(true);
              }}
              onFocus={() => setHeadEditing("title")}
              onBlur={() => setHeadEditing(null)}
              className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-lg font-medium leading-snug outline-none transition-colors hover:border-border focus:border-border focus:bg-card/40"
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
            </div>
            <span className="text-meta text-muted-foreground">
              {total} step{total === 1 ? "" : "s"}
            </span>
          </div>

          {view === "list" ? (
            <StepsList
              steps={orderedSteps}
              runningStepId={runningStep?.id ?? null}
              runningRef={runningRef}
              onTransitionStep={(id, status) => updateStep.mutate({ id, status })}
              onPatchStep={(id, patch) => updateStep.mutate({ id, ...patch })}
              onRemoveStep={(id) => setConfirmState({ kind: "remove-step", stepId: id })}
            />
          ) : (
            <TimelineView
              steps={orderedSteps}
              positionById={positionById}
              runningStepId={runningStep?.id ?? null}
              runningRef={runningRef}
              onTransitionStep={(id, status) => updateStep.mutate({ id, status })}
            />
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
              onChange={(e) =>
                update.mutate({
                  id: plan.id,
                  status: e.target.value as ExecutionPlanStatus,
                })
              }
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
          pending ? "bg-ember animate-pulse" : "bg-emerald-600",
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
  runningStepId,
  runningRef,
  onTransitionStep,
  onPatchStep,
  onRemoveStep,
}: {
  steps: StepRow[];
  runningStepId: string | null;
  runningRef: React.RefObject<HTMLDivElement | null>;
  onTransitionStep: (id: string, status: ExecutionStepStatus) => void;
  onPatchStep: (
    id: string,
    patch: { title?: string; expectedOutput?: string | null; body?: string | null },
  ) => void;
  onRemoveStep: (id: string) => void;
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
        <li key={step.id}>
          <StepCard
            step={step}
            index={idx}
            running={step.id === runningStepId}
            attachRef={step.id === runningStepId ? runningRef : undefined}
            onTransition={(status) => onTransitionStep(step.id, status)}
            onPatch={(patch) => onPatchStep(step.id, patch)}
            onRemove={() => onRemoveStep(step.id)}
          />
        </li>
      ))}
    </ol>
  );
}

function StepCard({
  step,
  index,
  running,
  attachRef,
  onTransition,
  onPatch,
  onRemove,
}: {
  step: StepRow;
  index: number;
  running: boolean;
  attachRef?: React.RefObject<HTMLDivElement | null>;
  onTransition: (status: ExecutionStepStatus) => void;
  onPatch: (patch: {
    title?: string;
    expectedOutput?: string | null;
    body?: string | null;
  }) => void;
  onRemove: () => void;
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
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card/40 p-3 transition-all duration-300",
        running
          ? "border-ember/40 ring-1 ring-ember/30 shadow-sm"
          : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-subtle text-[10px] font-mono text-muted-foreground">
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
          pending ? "bg-ember animate-pulse" : "bg-emerald-600/70",
        )}
        aria-hidden
      />
      {pending ? "saving…" : "saved"}
    </span>
  );
}

function TimelineView({
  steps,
  positionById,
  runningStepId,
  runningRef,
  onTransitionStep,
}: {
  steps: StepRow[];
  positionById: Map<string, number>;
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
  isRunning,
  isLast,
  attachRef,
  depsLabel,
  onTransition,
}: {
  step: StepRow;
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
          <button
            type="button"
            onClick={onToggle}
            className="flex min-w-0 flex-1 flex-col items-start text-left"
            aria-expanded={expanded}
          >
            <p className="break-words text-sm font-medium leading-snug">{step.title}</p>
            {depsLabel ? (
              <p className="mt-0.5 text-meta text-muted-foreground">
                ↳ depends on {depsLabel}
              </p>
            ) : null}
          </button>
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
