"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExecutionPlanStatus } from "@prisma/client";
import { ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

const STATUS_TONE: Record<ExecutionPlanStatus, string> = {
  DRAFT: "bg-subtle text-muted-foreground",
  APPROVED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  RUNNING: "bg-ember/15 text-ember",
  BLOCKED: "bg-warning/15 text-warning",
  COMPLETED: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

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

/**
 * Execution plans index. Lists every non-archived plan in the workspace
 * along with its status, target issue/project (when set), and step
 * count. "+ New plan" opens a tiny dialog that creates a DRAFT plan
 * and routes to its detail page so the operator can start adding
 * steps immediately.
 */
export default function PlansPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.executionPlan.list.useQuery({
    includeArchived: false,
  });
  const [creating, setCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [templateId, setTemplateId] = useState<string>("blank");
  const [seeding, setSeeding] = useState(false);

  const items = useMemo(() => data?.items ?? [], [data]);
  const selectedTemplate = useMemo(
    () => PLAN_TEMPLATES.find((t) => t.id === templateId) ?? PLAN_TEMPLATES[0],
    [templateId],
  );

  const addStep = trpc.executionPlan.addStep.useMutation();
  const create = trpc.executionPlan.create.useMutation({
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
      utils.executionPlan.list.invalidate();
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
        subtitle={data ? `${items.length} active` : undefined}
        actions={
          <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New plan
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <SkeletonList rows={4} />
        ) : items.length === 0 ? (
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
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {items.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/w/${ws.slug}/plans/${row.id}`}
                  className="group flex h-full flex-col gap-2 rounded-lg border border-border bg-card/40 p-3 transition hover:border-ember/40 hover:bg-subtle"
                >
                  <div className="flex items-start justify-between gap-2">
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
                  <p className="mt-auto text-meta text-muted-foreground">
                    {row._count.steps} step{row._count.steps === 1 ? "" : "s"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
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
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={seeding}
              className="mt-1 w-full rounded-md border border-border bg-card/40 px-2 py-1.5 text-sm"
            >
              {PLAN_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
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
    </>
  );
}
