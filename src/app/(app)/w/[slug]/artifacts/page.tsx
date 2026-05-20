"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Archive,
  Copy,
  FileText,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { ArtifactStatus, ArtifactType } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
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
  NOTE: "Note",
};

const STATUS_TONE: Record<ArtifactStatus, string> = {
  DRAFT: "bg-subtle text-muted-foreground",
  IN_REVIEW: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  ACCEPTED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  ARCHIVED: "bg-muted/40 text-muted-foreground line-through",
};

type ArtifactRow = {
  id: string;
  title: string;
  slug: string;
  type: ArtifactType;
  status: ArtifactStatus;
  summary: string | null;
  sourceType: string | null;
};

type Tab = "active" | "archived";

/**
 * Artifacts index page. Active tab lists non-archived artifacts;
 * Archived tab surfaces soft-deleted artifacts with Restore + hard
 * Delete actions. Each card has a "..." menu for Duplicate / Archive
 * on Active and Restore / Delete on Archived.
 */
export default function ArtifactsPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<Tab>("active");
  const { data, isLoading } = trpc.artifact.list.useQuery(
    tab === "archived"
      ? { archivedOnly: true }
      : { includeArchived: false },
  );
  const [creating, setCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ArtifactRow | null>(null);

  const items = useMemo(() => data?.items ?? [], [data]);

  const invalidateLists = () => {
    void utils.artifact.list.invalidate();
  };

  const create = trpc.artifact.create.useMutation({
    onSuccess: ({ slug }) => {
      toast.success("Artifact created");
      invalidateLists();
      setCreating(false);
      setDraftTitle("");
      // Land on the new artifact's detail page so the user can write
      // immediately.
      window.location.href = `/w/${ws.slug}/artifacts/${slug}`;
    },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.artifact.archive.useMutation({
    onSuccess: () => {
      toast.success("Artifact archived");
      invalidateLists();
    },
    onError: (e) => toast.error(e.message),
  });
  const restore = trpc.artifact.restore.useMutation({
    onSuccess: () => {
      toast.success("Artifact restored");
      invalidateLists();
    },
    onError: (e) => toast.error(e.message),
  });
  const duplicate = trpc.artifact.duplicate.useMutation({
    onSuccess: ({ slug }) => {
      toast.success("Artifact duplicated");
      invalidateLists();
      window.location.href = `/w/${ws.slug}/artifacts/${slug}`;
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteM = trpc.artifact.delete.useMutation({
    onSuccess: () => {
      toast.success("Artifact deleted");
      invalidateLists();
      setDeleteTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Artifacts"
        subtitle={
          data
            ? `${items.length} ${tab === "archived" ? "archived" : "active"}`
            : undefined
        }
        actions={
          <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New artifact
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
        ) : items.length === 0 ? (
          tab === "archived" ? (
            <EmptyState
              variant="page"
              icon={<Archive />}
              title="No archived artifacts"
              description={
                <span>
                  Archived artifacts show up here. Restore to bring one
                  back, or hard-delete with a type-to-confirm gate.
                </span>
              }
            />
          ) : (
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
          )
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {items.map((row) => (
              <li key={row.id} className="relative">
                <Link
                  href={`/w/${ws.slug}/artifacts/${row.slug}`}
                  className={cn(
                    "group flex h-full flex-col gap-2 rounded-lg border border-border bg-card/40 p-3 transition hover:border-ember/40 hover:bg-subtle",
                    tab === "archived" && "opacity-70",
                  )}
                >
                  <div className="flex items-start justify-between gap-2 pr-7">
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
                <RowMenu
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

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete artifact?"
        description={
          deleteTarget ? (
            <>
              This permanently removes the artifact and every version of
              its body. Type the artifact&apos;s title to confirm.
            </>
          ) : null
        }
        variant="destructive"
        typeToConfirm={deleteTarget?.title}
        primaryLabel="Delete artifact"
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
}: {
  tab: Tab;
  busy: boolean;
  onDuplicate: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
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
        aria-label="Artifact actions"
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
          className="absolute right-0 top-full z-30 mt-1 w-40 rounded-md border border-border bg-card py-1 shadow-md"
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
