"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { FileText, Plus, Sparkles } from "lucide-react";
import type { ArtifactStatus, ArtifactType } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

const TYPE_LABEL: Record<ArtifactType, string> = {
  DOCUMENT: "Document",
  DECISION: "Decision",
  RUNBOOK: "Runbook",
  REPORT: "Report",
  SPEC: "Spec",
  BRIEF: "Brief",
  VERIFICATION: "Verification",
};

const STATUS_TONE: Record<ArtifactStatus, string> = {
  DRAFT: "bg-subtle text-muted-foreground",
  IN_REVIEW: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  ACCEPTED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  ARCHIVED: "bg-muted/40 text-muted-foreground line-through",
};

/**
 * Artifacts index page. Lists every non-archived artifact in the
 * workspace; the "+ New" action creates a DRAFT row and lands on its
 * detail page. The route stays a thin shell — heavier surfaces (filter
 * chips, type-grouped sections) ship in a follow-up wave.
 */
export default function ArtifactsPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.artifact.list.useQuery({ includeArchived: false });
  const [creating, setCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const items = useMemo(() => data?.items ?? [], [data]);

  const create = trpc.artifact.create.useMutation({
    onSuccess: ({ slug }) => {
      toast.success("Artifact created");
      utils.artifact.list.invalidate();
      setCreating(false);
      setDraftTitle("");
      // Land on the new artifact's detail page so the user can write
      // immediately.
      window.location.href = `/w/${ws.slug}/artifacts/${slug}`;
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Artifacts"
        subtitle={data ? `${items.length} active` : undefined}
        actions={
          <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New artifact
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <SkeletonList rows={4} />
        ) : items.length === 0 ? (
          <EmptyState
            variant="page"
            icon={<FileText />}
            title="No artifacts yet"
            description={
              <span>
                Capture durable outputs — specs, decisions, runbooks,
                reports — that outlive a single issue. Promote a chat
                message, comment, or note into an artifact via the
                source&apos;s menu, or create a new one from scratch.
              </span>
            }
            action={
              <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
                Create artifact
              </Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {items.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/w/${ws.slug}/artifacts/${row.slug}`}
                  className="group flex h-full flex-col gap-2 rounded-lg border border-border bg-card/40 p-3 transition hover:border-ember/40 hover:bg-subtle"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 text-meta uppercase tracking-wide text-muted-foreground">
                      <FileText className="h-3 w-3" />
                      {TYPE_LABEL[row.type]}
                    </div>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${STATUS_TONE[row.status]}`}
                    >
                      {row.status.replace("_", " ").toLowerCase()}
                    </span>
                  </div>
                  <div className="text-sm font-medium leading-snug text-foreground group-hover:text-ember">
                    {row.title}
                  </div>
                  {row.summary ? (
                    <p className="line-clamp-3 text-meta text-muted-foreground">
                      {row.summary}
                    </p>
                  ) : null}
                  {row.sourceType ? (
                    <p className="mt-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Sparkles className="h-3 w-3" /> from {row.sourceType.replace("-", " ")}
                    </p>
                  ) : null}
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
            <h2 className="mb-3 text-sm font-medium">New artifact</h2>
            <input
              autoFocus
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftTitle.trim()) {
                  create.mutate({ title: draftTitle.trim(), body: "" });
                }
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Artifact title"
              className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                variant="ember"
                size="sm"
                onClick={() => create.mutate({ title: draftTitle.trim() || "Untitled", body: "" })}
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
