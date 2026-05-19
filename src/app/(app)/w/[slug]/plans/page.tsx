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

  const items = useMemo(() => data?.items ?? [], [data]);

  const create = trpc.executionPlan.create.useMutation({
    onSuccess: ({ id }) => {
      toast.success("Plan created");
      utils.executionPlan.list.invalidate();
      setCreating(false);
      setDraftTitle("");
      router.push(`/w/${ws.slug}/plans/${id}`);
    },
    onError: (e) => toast.error(e.message),
  });

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
          onClick={() => setCreating(false)}
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
                if (e.key === "Enter" && draftTitle.trim()) {
                  create.mutate({ title: draftTitle.trim() });
                }
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Plan title"
              className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                variant="ember"
                size="sm"
                onClick={() => create.mutate({ title: draftTitle.trim() || "Untitled plan" })}
                disabled={create.isPending || !draftTitle.trim()}
              >
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
