"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Archive,
  ChevronLeft,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

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

/**
 * Execution plan detail + builder. The header carries title/description
 * editors and the status selector; the main column lists steps in
 * position order with inline status pickers, expected-output edit, and
 * an at-bottom "+ Add step" form. Linked issue/project/context-set are
 * surfaced as deep-links in the sidebar.
 */
export default function PlanDetailPage() {
  const params = useParams<{ slug: string; planId: string }>();
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();

  const { data: plan, isLoading } = trpc.executionPlan.get.useQuery({ id: params.planId });

  const [editingHead, setEditingHead] = useState(false);
  const [headTitle, setHeadTitle] = useState<string>("");
  const [headDescription, setHeadDescription] = useState<string>("");

  useEffect(() => {
    if (plan && !editingHead) {
      setHeadTitle(plan.title);
      setHeadDescription(plan.description ?? "");
    }
  }, [plan, editingHead]);

  const update = trpc.executionPlan.update.useMutation({
    onSuccess: () => {
      utils.executionPlan.get.invalidate({ id: params.planId });
      utils.executionPlan.list.invalidate();
      setEditingHead(false);
      toast.success("Plan updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.executionPlan.archive.useMutation({
    onSuccess: () => {
      toast.success("Plan archived");
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

  const orderedSteps = useMemo(
    () => (plan?.steps ?? []).slice().sort((a, b) => a.position - b.position),
    [plan?.steps],
  );

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
            {editingHead ? (
              <Button
                size="sm"
                variant="ember"
                onClick={() =>
                  update.mutate({
                    id: plan.id,
                    title: headTitle.trim() || undefined,
                    description: headDescription.trim() || null,
                  })
                }
                disabled={update.isPending}
              >
                <Save className="h-3.5 w-3.5" /> Save
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setEditingHead(true)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_280px]">
        <section className="flex min-w-0 flex-col gap-4">
          <header className="rounded-lg border border-border bg-card/40 p-4">
            {editingHead ? (
              <div className="flex flex-col gap-2">
                <input
                  value={headTitle}
                  onChange={(e) => setHeadTitle(e.target.value)}
                  className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-lg font-medium"
                />
                <textarea
                  value={headDescription}
                  onChange={(e) => setHeadDescription(e.target.value)}
                  rows={4}
                  placeholder="Description (markdown ok)…"
                  className="w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
                />
              </div>
            ) : (
              <>
                <h1 className="text-lg font-medium leading-snug">{plan.title}</h1>
                {plan.description ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {plan.description}
                  </p>
                ) : (
                  <p className="mt-2 text-meta text-muted-foreground">
                    No description yet. Click <span className="font-mono">Edit</span> to add one.
                  </p>
                )}
              </>
            )}
          </header>

          <StepsList
            steps={orderedSteps}
            onTransitionStep={(id, status) =>
              updateStep.mutate({ id, status })
            }
            onPatchStep={(id, patch) => updateStep.mutate({ id, ...patch })}
            onRemoveStep={(id) => {
              if (window.confirm("Remove this step?")) {
                removeStep.mutate({ id });
              }
            }}
          />

          <AddStepForm
            disabled={addStep.isPending}
            onAdd={(payload) =>
              addStep.mutate({ planId: plan.id, ...payload })
            }
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
              className={`w-full rounded-md border border-border bg-card/40 px-2 py-1 text-xs ${PLAN_STATUS_TONE[plan.status]}`}
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

          <Button
            size="sm"
            variant="ghost"
            className="text-warning"
            onClick={() => {
              if (window.confirm("Archive this plan?")) {
                archive.mutate({ id: plan.id });
              }
            }}
            disabled={archive.isPending}
          >
            <Archive className="h-3.5 w-3.5" /> Archive plan
          </Button>
        </aside>
      </div>
    </>
  );
}

type StepRow = {
  id: string;
  title: string;
  body: string | null;
  position: number;
  status: ExecutionStepStatus;
  expectedOutput: string | null;
  assignedAgentId: string | null;
  assignedUserId: string | null;
};

function StepsList({
  steps,
  onTransitionStep,
  onPatchStep,
  onRemoveStep,
}: {
  steps: StepRow[];
  onTransitionStep: (id: string, status: ExecutionStepStatus) => void;
  onPatchStep: (id: string, patch: { title?: string; expectedOutput?: string | null }) => void;
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
  onTransition,
  onPatch,
  onRemove,
}: {
  step: StepRow;
  index: number;
  onTransition: (status: ExecutionStepStatus) => void;
  onPatch: (patch: { title?: string; expectedOutput?: string | null }) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(step.title);
  const [expected, setExpected] = useState(step.expectedOutput ?? "");

  useEffect(() => {
    if (!editing) {
      setTitle(step.title);
      setExpected(step.expectedOutput ?? "");
    }
  }, [step.title, step.expectedOutput, editing]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-subtle text-[10px] font-mono text-muted-foreground">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-border bg-card/40 px-2 py-1 text-sm font-medium"
            />
          ) : (
            <p className="break-words text-sm font-medium leading-snug">
              {step.title}
            </p>
          )}
          {editing ? (
            <textarea
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              rows={3}
              placeholder="Expected output (what 'done' means)…"
              className="mt-1 w-full resize-y rounded-md border border-border bg-card/40 px-2 py-1 text-meta"
            />
          ) : step.expectedOutput ? (
            <p className="mt-1 whitespace-pre-wrap text-meta text-muted-foreground">
              <span className="uppercase tracking-wide opacity-70">Expected: </span>
              {step.expectedOutput}
            </p>
          ) : null}
        </div>
        <select
          value={step.status}
          onChange={(e) => onTransition(e.target.value as ExecutionStepStatus)}
          className={`shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] uppercase ${STEP_STATUS_TONE[step.status]}`}
        >
          {STEP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-end gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="ember"
              onClick={() => {
                onPatch({
                  title: title.trim() || undefined,
                  expectedOutput: expected.trim() || null,
                });
                setEditing(false);
              }}
            >
              <Save className="h-3 w-3" /> Save
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-warning"
              onClick={onRemove}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </>
        )}
      </div>
    </div>
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card/20 p-3">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Step title (what needs to happen)…"
        className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
      />
      <textarea
        value={expected}
        onChange={(e) => setExpected(e.target.value)}
        rows={3}
        placeholder="Expected output (optional)"
        className="w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-meta"
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setTitle("");
            setExpected("");
          }}
        >
          Cancel
        </Button>
        <Button
          variant="ember"
          size="sm"
          disabled={disabled || !title.trim()}
          onClick={() => {
            onAdd({
              title: title.trim(),
              expectedOutput: expected.trim() || null,
            });
            setTitle("");
            setExpected("");
            setOpen(false);
          }}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}
