"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
import { Archive, Clock, Copy, ListChecks, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { Combobox } from "@/components/ui/combobox";
import { cn, relativeTime } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  DagStepStrip,
  countBasedTones,
  toneForStepStatus,
} from "@/components/orchestration/dag-step-strip";

const STATUS_TONE: Record<ExecutionPlanStatus, string> = {
  DRAFT: "bg-subtle text-muted-foreground",
  APPROVED: "bg-success/15 text-success",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  COMPLETED: "bg-success/15 text-success",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

// Status-legend dot color, mirroring STATUS_TONE's semantic intent.
const STATUS_DOT: Record<ExecutionPlanStatus, string> = {
  DRAFT: "bg-muted-foreground/40",
  APPROVED: "bg-emerald-500",
  RUNNING: "bg-ember",
  BLOCKED: "bg-warning",
  COMPLETED: "bg-emerald-500",
  CANCELED: "bg-muted-foreground/30",
};

// Plain-language gloss per status — the right-rail legend reads off the
// same enum the cards render. Ordered DRAFT → CANCELED to match a plan's
// natural lifecycle.
const STATUS_LEGEND: { status: ExecutionPlanStatus; gloss: string }[] = [
  { status: "DRAFT", gloss: "pre-decisional" },
  { status: "APPROVED", gloss: "ready to run" },
  { status: "RUNNING", gloss: "agent + human moving" },
  { status: "BLOCKED", gloss: "needs you" },
  { status: "COMPLETED", gloss: "done" },
  { status: "CANCELED", gloss: "abandoned" },
];

interface TemplateStep {
  title: string;
  body?: string;
  expectedOutput?: string;
  /** Positional indices of prerequisite steps within the same template. */
  dependsOn?: number[];
}

interface PlanTemplate {
  id: string;
  label: string;
  blurb: string;
  description?: string;
  steps: TemplateStep[];
}

const PLAN_TEMPLATES: PlanTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    blurb: "Title only — start from scratch.",
    steps: [],
  },
  {
    id: "dag",
    label: "DAG",
    blurb: "Investigate → Design → Implement → Verify, each gating the next.",
    description: "High-level execution plan with parallel and dependent steps.",
    steps: [
      { title: "Investigate", expectedOutput: "Findings written up; gaps named." },
      { title: "Design", expectedOutput: "Approach selected, tradeoffs noted.", dependsOn: [0] },
      { title: "Implement", expectedOutput: "Code merged and tests pass.", dependsOn: [1] },
      { title: "Verify", expectedOutput: "Production smoke green; rollback path documented.", dependsOn: [2] },
    ],
  },
  {
    id: "rfc",
    label: "RFC",
    blurb: "Problem · Proposal · Alternatives · Tradeoffs + decision.",
    description: "RFC for a non-trivial change. Pre-decisional; comments welcome before approval.",
    steps: [
      {
        title: "Problem statement",
        body: "> Replace this paragraph with the problem statement, including who is affected and what success looks like.",
      },
      {
        title: "Proposal",
        body: "> Describe the proposed change in enough detail that a reader can evaluate it without reading the implementation.",
      },
      {
        title: "Alternatives considered",
        body: "> Two or three credible alternatives, each with the reason it was not chosen.",
      },
      {
        title: "Tradeoffs + decision",
        body: "> Final decision and the tradeoffs we are accepting.",
        dependsOn: [0, 1, 2],
      },
    ],
  },
  {
    id: "postmortem",
    label: "Post-mortem",
    blurb: "What happened · Timeline · Root cause · Action items.",
    description: "Blameless post-mortem.",
    steps: [
      {
        title: "What happened",
        body: "> Plain-language summary of the user-visible impact.",
      },
      {
        title: "Timeline",
        body: "> Chronological events, in UTC. Each row: HH:MM — what changed.",
      },
      {
        title: "Root cause",
        body: "> The actual underlying cause, not the proximate trigger.",
      },
      {
        title: "Action items",
        body: "> Concrete follow-ups with owners and target dates.",
        dependsOn: [2],
      },
    ],
  },
  {
    id: "feature-spec",
    label: "Feature spec",
    blurb: "Goal · Non-goals · Stories · Implementation · Risks · Rollout.",
    description: "Feature specification — keep it tight; link out for depth.",
    steps: [
      { title: "Goal", body: "> One sentence stating the outcome." },
      { title: "Non-goals", body: "> Bullet what this feature is explicitly NOT trying to do." },
      { title: "User stories", body: "> As a {role}, I want {action} so that {outcome}." },
      { title: "Implementation plan", body: "> Phases, with the riskiest step first." },
      { title: "Risks + mitigations", body: "> Failure modes and how we'll catch them early." },
      { title: "Rollout", body: "> Gating, dogfood plan, success metric, rollback path." },
    ],
  },
];

type PlanStripStep = {
  id: string;
  position: number;
  status: ExecutionStepStatus;
};

type PlanOwnerUser = {
  id: string;
  name: string | null;
  image: string | null;
} | null;

type PlanOwnerAgent = {
  id: string;
  profileKey: string;
  name: string | null;
  avatar: string | null;
} | null;

type PlanRow = {
  id: string;
  title: string;
  description: string | null;
  status: ExecutionPlanStatus;
  updatedAt: Date | string;
  _count: { steps: number };
  steps?: PlanStripStep[];
  doneSteps?: number;
  createdBy?: PlanOwnerUser;
  createdByAgent?: PlanOwnerAgent;
};

type Tab = "active" | "archived";

function PlanOwner({
  createdBy,
  createdByAgent,
}: {
  createdBy?: PlanOwnerUser;
  createdByAgent?: PlanOwnerAgent;
}) {
  const agentName = createdByAgent?.name ?? createdByAgent?.profileKey ?? null;
  const name = agentName ?? createdBy?.name ?? null;
  if (!name) return null;
  const image = createdByAgent ? createdByAgent.avatar : (createdBy?.image ?? null);
  const initial = name.charAt(0).toUpperCase();
  return (
    <span className="flex min-w-0 items-center gap-1 text-[0.625rem] text-muted-foreground">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-subtle font-mono text-[0.5rem] text-muted-foreground">
          {initial}
        </span>
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Execution plans index. Active tab lists non-archived plans (the
 * default). Archived tab surfaces soft-deleted plans so operators can
 * restore or hard-delete them. Each card has a "..." menu exposing
 * Duplicate / Archive on Active and Restore / Delete on Archived.
 */
export default function PlansPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<Tab>("active");
  const { data, isLoading, isError, refetch } = trpc.executionPlan.list.useQuery(
    tab === "archived"
      ? { archivedOnly: true }
      : { includeArchived: false },
  );
  const [creating, setCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [templateId, setTemplateId] = useState<string>("blank");
  const [seeding, setSeeding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PlanRow | null>(null);

  const items = useMemo(() => data?.items ?? [], [data]);
  const selectedTemplate = useMemo(
    () => PLAN_TEMPLATES.find((t) => t.id === templateId) ?? PLAN_TEMPLATES[0],
    [templateId],
  );

  const invalidateLists = () => {
    void utils.executionPlan.list.invalidate();
  };

  // Open the New-plan modal pre-selected to a template. Reuses the same
  // modal + templateId state the Combobox drives — the rail cards are
  // just another trigger.
  const openCreate = (presetTemplateId = "blank") => {
    setTemplateId(presetTemplateId);
    setCreating(true);
  };

  const addStep = trpc.executionPlan.addStep.useMutation();
  const create = trpc.executionPlan.create.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.executionPlan.archive.useMutation({
    onSuccess: () => {
      toast.success("Plan archived");
      invalidateLists();
    },
    onError: (e) => toast.error(e.message),
  });
  const restore = trpc.executionPlan.restore.useMutation({
    onSuccess: () => {
      toast.success("Plan restored");
      invalidateLists();
    },
    onError: (e) => toast.error(e.message),
  });
  const duplicate = trpc.executionPlan.duplicate.useMutation({
    onSuccess: ({ id }) => {
      toast.success("Plan duplicated");
      invalidateLists();
      router.push(`/w/${ws.slug}/plans/${id}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteM = trpc.executionPlan.delete.useMutation({
    onSuccess: () => {
      toast.success("Plan deleted");
      invalidateLists();
      setDeleteTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = async () => {
    if (seeding) return;
    const title = draftTitle.trim() || "Untitled plan";
    setSeeding(true);
    let toastId: string | number | undefined;
    try {
      const plan = await create.mutateAsync({
        title,
        description: selectedTemplate.description ?? null,
      });
      const steps = selectedTemplate.steps;
      if (steps.length > 0) {
        toastId = toast.loading(`Seeding 0 / ${steps.length} steps…`);
        const positionToId = new Map<number, string>();
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          const dependsOnStepIds = (s.dependsOn ?? [])
            .map((pos) => positionToId.get(pos))
            .filter((id): id is string => Boolean(id));
          const created = await addStep.mutateAsync({
            planId: plan.id,
            title: s.title,
            body: s.body ?? null,
            expectedOutput: s.expectedOutput ?? null,
            dependsOnStepIds,
          });
          positionToId.set(i, created.id);
          toast.loading(`Seeding ${i + 1} / ${steps.length} steps…`, { id: toastId });
        }
        toast.success(`Plan created · ${steps.length} step${steps.length === 1 ? "" : "s"} seeded`, {
          id: toastId,
        });
      } else {
        toast.success("Plan created");
      }
      invalidateLists();
      setCreating(false);
      setDraftTitle("");
      setTemplateId("blank");
      router.push(`/w/${ws.slug}/plans/${plan.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to seed plan";
      if (toastId !== undefined) {
        toast.error(message, { id: toastId });
      } else {
        toast.error(message);
      }
    } finally {
      setSeeding(false);
    }
  };

  return (
    <>
      <Topbar
        title="Plans"
        subtitle={
          data
            ? `${items.length} ${tab === "archived" ? "archived" : "active"}`
            : undefined
        }
        actions={
          <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New plan
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_300px]">
          <div className="min-w-0">
        <div className="mb-3 inline-flex items-center gap-1 rounded-md border border-border bg-card/40 p-0.5">
          <button
            type="button"
            onClick={() => setTab("active")}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition",
              tab === "active"
                ? "bg-subtle text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => setTab("archived")}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition",
              tab === "archived"
                ? "bg-subtle text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Archived
          </button>
        </div>

        {isLoading ? (
          <SkeletonList rows={4} />
        ) : isError ? (
          <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-6">
            <EmptyState
              variant="page"
              icon={<ListChecks />}
              title="Couldn't load plans"
              description="Something went wrong fetching plans — this is a load error, not an empty list. Nothing was deleted."
            />
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          tab === "archived" ? (
            <EmptyState
              variant="page"
              icon={<Archive />}
              title="No archived plans"
              description={
                <span>
                  Archived plans show up here so you can restore them or
                  hard-delete with a type-to-confirm gate. Nothing yet.
                </span>
              }
            />
          ) : (
            <EmptyState
              variant="page"
              icon={<ListChecks />}
              title="No execution plans yet"
              description={
                <span>
                  Plans coordinate multi-step work across humans and agent
                  crews. Draft one to break a goal into ordered steps with
                  expected outputs and verification, then approve when
                  ready.
                </span>
              }
              action={
                <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
                  Draft plan
                </Button>
              }
            />
          )
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {items.map((row, idx) => (
              <li
                key={row.id}
                className="relative forge-row-rise"
                style={{ "--row-i": idx } as React.CSSProperties}
              >
                <Link
                  href={`/w/${ws.slug}/plans/${row.id}`}
                  className={cn(
                    "group flex h-full flex-col gap-2 rounded-lg border border-border bg-card/40 p-3 transition hover:border-ember/40 hover:bg-subtle",
                    row.status === "RUNNING" && "forge-active-node border-ember/40",
                    tab === "archived" && "opacity-70",
                  )}
                >
                  <div className="flex items-start justify-between gap-2 pr-7">
                    <div className="flex items-center gap-2 text-meta uppercase tracking-wide text-muted-foreground">
                      <ListChecks className="h-3 w-3" /> Plan
                    </div>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${STATUS_TONE[row.status]}`}>
                      {row.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="text-sm font-medium leading-snug text-foreground group-hover:text-ember">
                    {row.title}
                  </div>
                  {row.description ? (
                    <p className="line-clamp-3 text-meta text-muted-foreground">
                      {row.description}
                    </p>
                  ) : null}
                  <div className="mt-auto flex flex-col gap-2">
                    {/* DAG step strip — numbered chips in position order,
                        tinted by status with the running node glowing. */}
                    <DagStepStrip
                      tones={
                        row.steps && row.steps.length > 0
                          ? row.steps.map((s) => toneForStepStatus(s.status))
                          : countBasedTones(
                              row._count.steps,
                              row.doneSteps ?? 0,
                              row.status,
                            )
                      }
                      done={row.doneSteps ?? 0}
                      total={row._count.steps}
                      max={10}
                    />
                    {row.updatedAt ? (
                      <div className="flex items-center text-meta text-muted-foreground">
                        <span className="ml-auto inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Updated {relativeTime(row.updatedAt)}
                        </span>
                      </div>
                    ) : null}
                    {/* Owner footer — authoring agent preferred over user. */}
                    {row.createdByAgent || row.createdBy ? (
                      <div className="flex items-center border-t border-border/60 pt-2">
                        <PlanOwner
                          createdBy={row.createdBy}
                          createdByAgent={row.createdByAgent}
                        />
                      </div>
                    ) : null}
                  </div>
                </Link>
                <RowMenu
                  align="right"
                  tab={tab}
                  busy={
                    archive.isPending ||
                    restore.isPending ||
                    duplicate.isPending ||
                    deleteM.isPending
                  }
                  onDuplicate={() => duplicate.mutate({ id: row.id })}
                  onArchive={() => archive.mutate({ id: row.id })}
                  onRestore={() => restore.mutate({ id: row.id })}
                  onDelete={() => setDeleteTarget(row)}
                />
              </li>
            ))}
          </ul>
        )}
          </div>

          {/* Right rail — template launcher + status legend. Hidden
              below xl; sticky so it tracks the scrolling card grid. */}
          <aside className="hidden xl:block">
            <div className="sticky top-0 flex flex-col gap-5">
              <section>
                <h3 className="mb-2 text-sm font-semibold">Start from a template</h3>
                <ul className="flex flex-col gap-2">
                  {PLAN_TEMPLATES.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => openCreate(t.id)}
                        className="group block w-full rounded-md border border-border bg-card/40 p-3 text-left transition hover:border-ember/40 hover:bg-subtle"
                      >
                        <div className="flex items-center gap-2">
                          <ListChecks className="h-3 w-3 text-ember" />
                          <span className="text-sm font-semibold text-foreground group-hover:text-ember">
                            {t.label}
                          </span>
                          <span className="ml-auto text-muted-foreground transition group-hover:text-ember">
                            →
                          </span>
                        </div>
                        <p className="mt-1 text-meta text-muted-foreground">{t.blurb}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Status legend</h3>
                <ul className="flex flex-col gap-1.5 text-meta">
                  {STATUS_LEGEND.map(({ status, gloss }) => (
                    <li key={status} className="flex items-center gap-2">
                      <span
                        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
                        aria-hidden
                      />
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] uppercase",
                          STATUS_TONE[status],
                        )}
                      >
                        {status.toLowerCase()}
                      </span>
                      <span className="text-muted-foreground">{gloss}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </aside>
        </div>
      </div>

      {creating && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={() => {
            if (!seeding) setCreating(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 text-sm font-medium">New plan</h2>
            <input
              autoFocus
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftTitle.trim() && !seeding) {
                  void submit();
                }
                if (e.key === "Escape" && !seeding) setCreating(false);
              }}
              placeholder="Plan title"
              className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            />
            <label className="mt-3 block text-meta uppercase tracking-wide text-muted-foreground">
              Template
            </label>
            <Combobox
              value={templateId}
              onChange={(v) => setTemplateId(v ?? "blank")}
              options={PLAN_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
              disabled={seeding}
              ariaLabel="Plan template"
              matchTriggerWidth
              className="mt-1 w-full"
            />
            <p className="mt-1.5 text-meta text-muted-foreground">
              {selectedTemplate.blurb}
              {selectedTemplate.steps.length > 0 && (
                <>
                  {" "}· {selectedTemplate.steps.length} step
                  {selectedTemplate.steps.length === 1 ? "" : "s"}
                </>
              )}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreating(false)}
                disabled={seeding}
              >
                Cancel
              </Button>
              <Button
                variant="ember"
                size="sm"
                onClick={() => void submit()}
                disabled={seeding || !draftTitle.trim()}
              >
                {seeding ? "Seeding…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete plan?"
        description={
          deleteTarget ? (
            <>
              This permanently removes the plan and its steps. Type the
              plan&apos;s title to confirm.
            </>
          ) : null
        }
        variant="destructive"
        typeToConfirm={deleteTarget?.title}
        primaryLabel="Delete plan"
        loading={deleteM.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteM.mutate({ id: deleteTarget.id, confirm: deleteTarget.title });
        }}
      />
    </>
  );
}

function RowMenu({
  tab,
  busy,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
  align = "right",
}: {
  tab: Tab;
  busy: boolean;
  onDuplicate: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="absolute right-2 top-2">
      <button
        type="button"
        aria-label="Plan actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md bg-card/80 text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-40",
          open && "bg-subtle text-foreground",
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className={cn(
            "absolute top-full z-30 mt-1 w-40 rounded-md border border-border bg-card py-1 shadow-md",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {tab === "active" ? (
            <>
              <MenuItem
                icon={<Copy className="h-3.5 w-3.5" />}
                label="Duplicate"
                onClick={() => {
                  setOpen(false);
                  onDuplicate();
                }}
              />
              <MenuItem
                icon={<Archive className="h-3.5 w-3.5" />}
                label="Archive"
                onClick={() => {
                  setOpen(false);
                  onArchive();
                }}
              />
            </>
          ) : (
            <>
              <MenuItem
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                label="Restore"
                onClick={() => {
                  setOpen(false);
                  onRestore();
                }}
              />
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5 text-ember" />}
                label="Delete…"
                destructive
                onClick={() => {
                  setOpen(false);
                  onDelete();
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle",
        destructive && "text-ember",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
