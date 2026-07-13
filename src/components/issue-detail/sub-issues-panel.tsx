"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkItemKindGlyph } from "@/components/ui/work-item-kind-glyph";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Sub-issues panel for the issue detail page — the issue's children
 * (`Issue.parentId`) with a done/total rollup bar and inline create-child.
 * This is the human-facing face of the parent/child tree that Epics use as
 * their scope, and the same tree the relations DAG draws.
 *
 * New children inherit the parent's project so they land in the right place;
 * the parent's kind decides the child's default kind (Epic → Issue, Issue →
 * Sub-task). Self-contained: refetches `issue.children` after a create.
 */
export function SubIssuesPanel({
  parentId,
  parentProjectId,
  parentKind,
}: {
  parentId: string;
  parentProjectId: string | null;
  parentKind: string;
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.issue.children.useQuery({ parentId });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  // Epics scope Issues; Issues scope Sub-tasks. (Sub-tasks scope Sub-tasks.)
  const childKind = parentKind === "EPIC" ? "ISSUE" : "TASK";
  const childNoun = parentKind === "EPIC" ? "issue" : "sub-task";

  const create = trpc.issue.create.useMutation({
    onSuccess: () => {
      setTitle("");
      setAdding(false);
      utils.issue.children.invalidate({ parentId });
      utils.issue.byId.invalidate({ id: parentId });
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    create.mutate({
      title: t,
      parentId,
      kind: childKind,
      ...(parentProjectId ? { projectId: parentProjectId } : {}),
    });
  };

  const total = data?.total ?? 0;
  const done = data?.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Hide entirely when there are no children and nothing is being added —
  // keeps the common (childless) issue clean. The DAG/relations still exist.
  if (!isLoading && total === 0 && !adding) {
    return (
      <section className="flex flex-wrap items-center gap-2">
        <span className="text-meta flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
          <WorkItemKindGlyph kind={childKind} size={12} />
          Sub-issues
        </span>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="focus-ring text-meta inline-flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-[9px] w-[9px]" /> Add {childNoun}
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Sub-issues
        </h2>
        {total > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-subtle">
              <span className="block h-full rounded-full bg-ember" style={{ width: `${pct}%` }} />
            </span>
            <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
              {done}/{total}
            </span>
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-[0.6875rem]"
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "Cancel" : `Add ${childNoun}`}
        </Button>
      </header>

      {adding && (
        <div className="border-b border-border bg-background/60 px-3 py-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex items-center gap-2"
          >
            <WorkItemKindGlyph kind={childKind} size={13} className="shrink-0" />
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`New ${childNoun} title…`}
              className="h-7 text-xs"
            />
            <Button
              type="submit"
              size="sm"
              variant="ember"
              disabled={!title.trim() || create.isPending}
            >
              {create.isPending ? "Adding…" : "Add"}
            </Button>
          </form>
        </div>
      )}

      <ul className="divide-y divide-border">
        {isLoading && <li className="text-meta px-3 py-3 text-muted-foreground">Loading…</li>}
        {data?.items.map((c) => (
          <li key={c.id} className="group flex items-center gap-2 px-3 py-1.5">
            <StatusDot status={c.status} />
            {c.kind !== "ISSUE" && (
              <WorkItemKindGlyph kind={c.kind} size={11} className="shrink-0" />
            )}
            <Link
              href={`/w/${ws.slug}/issues/${c.id}`}
              className="flex min-w-0 flex-1 items-center gap-2 hover:text-ember"
            >
              <span className="text-id text-muted-foreground">
                {formatIssueId(ws.key, c.number)}
              </span>
              <span
                className={cn(
                  "truncate text-xs",
                  (c.status.category === "DONE" || c.status.category === "CANCELED") &&
                    "text-muted-foreground line-through",
                )}
              >
                {c.title}
              </span>
            </Link>
            <span className="text-meta shrink-0 text-muted-foreground">{c.status.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Parent breadcrumb — "↑ part of EPIC-12" shown above an issue that has a
 * parent. Closes the child→parent direction the way the goals/plans strips
 * close issue→goal/plan.
 */
export function ParentIssueBacklink({
  parent,
}: {
  parent: {
    id: string;
    number: number;
    title: string;
    deletedAt: Date | string | null;
  } | null;
}) {
  const ws = useWorkspace();
  if (!parent) return null;
  return (
    <Link
      href={`/w/${ws.slug}/issues/${parent.id}${parent.deletedAt ? "?archived=1" : ""}`}
      className="text-meta inline-flex items-center gap-1.5 self-start rounded-md border border-border bg-card/40 px-2 py-1 text-muted-foreground transition hover:border-ember/40 hover:text-ember"
      title={parent.title}
    >
      <span aria-hidden>↑</span>
      <span className="uppercase tracking-wide">part of</span>
      <span className="text-id">{formatIssueId(ws.key, parent.number)}</span>
      <span className="max-w-[18rem] truncate">{parent.title}</span>
      {parent.deletedAt ? (
        <span className="rounded border border-border px-1 text-[0.625rem] uppercase">
          archived
        </span>
      ) : null}
    </Link>
  );
}
