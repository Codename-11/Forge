"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { RelationKind } from "@prisma/client";
import { ChevronDown, ChevronUp, Link2, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { IssueRelationsGraph } from "./issue-relations-graph";

/**
 * Relations panel for the issue detail page. Groups outgoing relations by
 * kind (BLOCKS, BLOCKED_BY, DUPLICATES, RELATES_TO), exposes an add-form
 * with inline issue search, and lets users remove relations with one click.
 *
 * Reciprocal kinds (BLOCKS ⇄ BLOCKED_BY) are managed server-side — we only
 * render outgoing edges, which is what `relation.listForIssue` returns.
 */

type Kind = (typeof ORDER)[number];

const ORDER = [
  RelationKind.BLOCKED_BY,
  RelationKind.BLOCKS,
  RelationKind.DUPLICATES,
  RelationKind.RELATES_TO,
] as const;

const LABELS: Record<Kind, string> = {
  [RelationKind.BLOCKS]: "Blocks",
  [RelationKind.BLOCKED_BY]: "Blocked by",
  [RelationKind.DUPLICATES]: "Duplicates",
  [RelationKind.RELATES_TO]: "Related to",
};

const STATUS_DOT: Record<string, string> = {
  BACKLOG: "bg-muted",
  TODO: "bg-subtle",
  IN_PROGRESS: "bg-ember",
  IN_REVIEW: "bg-warning",
  BLOCKED: "bg-danger",
  DONE: "bg-success",
  CANCELED: "bg-danger/60",
};

const STATUS_LABEL: Record<string, string> = {
  BACKLOG: "Backlog",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  BLOCKED: "Blocked",
  DONE: "Done",
  CANCELED: "Canceled",
};

export function IssueRelationsPanel({
  issueId,
  parentIssue,
  subtaskCount,
}: {
  issueId: string;
  parentIssue?: { id: string; number: number; title: string } | null;
  subtaskCount?: number;
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const listQuery = trpc.relation.listForIssue.useQuery({ issueId });
  const { data, isLoading } = listQuery;
  const [adding, setAdding] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Kind[]>([]);

  const remove = trpc.relation.remove.useMutation({
    onSuccess: () => {
      utils.relation.listForIssue.invalidate({ issueId });
      utils.issue.byId.invalidate({ id: issueId });
    },
    onError: (e) => toast.error(e.message),
  });

  const totalCount = useMemo(() => {
    if (!data) return 0;
    return ORDER.reduce((acc, k) => acc + (data[k]?.length ?? 0), 0);
  }, [data]);

  return (
    <section
      id="issue-relations"
      tabIndex={-1}
      aria-label="Related work"
      className="focus-ring min-w-0 scroll-mt-20 rounded-lg border border-border bg-card/40"
    >
      <header className="flex min-h-9 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Related work
        </h2>
        <span className="font-mono text-[0.6875rem] text-muted-foreground" title="Issue relations">
          {totalCount}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-[0.6875rem]"
          aria-expanded={adding}
          aria-controls={`add-relation-${issueId}`}
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? "Cancel" : "Add relation"}
        </Button>
      </header>

      {adding && (
        <div id={`add-relation-${issueId}`}>
          <AddRelationForm issueId={issueId} onDone={() => setAdding(false)} />
        </div>
      )}

      <div className="divide-y divide-border">
        {parentIssue && (
          <div className="px-3 py-2">
            <div className="mb-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
              Parent
            </div>
            <Link
              href={`/w/${ws.slug}/issues/${parentIssue.id}`}
              className="focus-ring block rounded py-1 hover:text-ember"
            >
              <span className="text-id text-muted-foreground">
                {formatIssueId(ws.key, parentIssue.number)}
              </span>
              <span className="mt-0.5 block break-words text-xs">{parentIssue.title}</span>
            </Link>
          </div>
        )}
        <a
          href="#issue-subtasks"
          className="focus-ring text-meta flex items-center justify-between gap-2 rounded px-3 py-2 hover:bg-subtle"
        >
          <span>Subtasks</span>
          <span className="text-muted-foreground">
            {subtaskCount === undefined ? "View or add" : `${subtaskCount} · View or add`}
          </span>
        </a>
        {isLoading && <div className="text-meta px-3 py-3 text-muted-foreground">Loading…</div>}
        {listQuery.isError && (
          <div role="status" className="text-meta space-y-1 px-3 py-3 text-muted-foreground">
            <p>Related work could not be loaded.</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void listQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        )}
        {!isLoading &&
          !listQuery.isError &&
          ORDER.map((kind) => {
            const rows = data?.[kind] ?? [];
            if (rows.length === 0) return null;
            const expanded = expandedGroups.includes(kind);
            const visibleRows = expanded ? rows : rows.slice(0, 3);
            return (
              <div key={kind} className="px-3 py-2">
                <div
                  className={cn(
                    "mb-1 text-[0.6875rem] uppercase tracking-wider",
                    kind === RelationKind.BLOCKED_BY ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {LABELS[kind]} <span className="ml-1 tabular-nums">{rows.length}</span>
                </div>
                <ul id={`relations-${issueId}-${kind}`} className="space-y-1">
                  {visibleRows.map((r) => (
                    <li key={r.relationId} className="group flex items-start gap-1">
                      <Link
                        href={`/w/${ws.slug}/issues/${r.target.id}`}
                        className="focus-ring block min-w-0 flex-1 rounded px-1 py-1 hover:bg-subtle"
                      >
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-id text-muted-foreground">
                            {formatIssueId(ws.key, r.target.number)}
                          </span>
                          <span className="text-meta inline-flex items-center gap-1 text-muted-foreground">
                            <span
                              aria-hidden
                              className={cn(
                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                STATUS_DOT[r.target.statusCategory] ?? "bg-muted",
                              )}
                            />
                            {STATUS_LABEL[r.target.statusCategory] ?? r.target.statusCategory}
                          </span>
                        </span>
                        <span
                          className="mt-0.5 line-clamp-2 block break-words text-xs"
                          title={r.target.title}
                        >
                          {r.target.title}
                        </span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => remove.mutate({ relationId: r.relationId })}
                        disabled={remove.isPending}
                        aria-label={`Remove ${LABELS[kind].toLowerCase()} relation: ${formatIssueId(ws.key, r.target.number)} ${r.target.title}`}
                        title="Remove relation"
                        className="focus-ring mt-1 grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-subtle hover:text-danger disabled:opacity-40"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
                {rows.length > 3 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1 w-full text-muted-foreground"
                    aria-expanded={expanded}
                    aria-controls={`relations-${issueId}-${kind}`}
                    onClick={() =>
                      setExpandedGroups((current) =>
                        expanded ? current.filter((value) => value !== kind) : [...current, kind],
                      )
                    }
                  >
                    {expanded ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    {expanded
                      ? `Show fewer ${LABELS[kind].toLowerCase()} links`
                      : `View all ${LABELS[kind].toLowerCase()} (${rows.length})`}
                  </Button>
                )}
              </div>
            );
          })}
        {!isLoading && !listQuery.isError && totalCount === 0 && !adding && (
          <div className="text-meta px-3 py-3 text-muted-foreground">
            No linked issues. Use{" "}
            <button
              type="button"
              className="text-ember hover:underline"
              onClick={() => setAdding(true)}
            >
              Add relation
            </button>{" "}
            to link blockers, duplicates, or related work.
          </div>
        )}
      </div>
      <div className="border-t border-border p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          aria-expanded={graphOpen}
          aria-controls={`relation-graph-${issueId}`}
          onClick={() => setGraphOpen((value) => !value)}
        >
          <Workflow className="h-3.5 w-3.5" />
          {graphOpen ? "Hide dependency map" : "Explore dependency map"}
          {graphOpen ? (
            <ChevronUp className="ml-auto h-3 w-3" />
          ) : (
            <ChevronDown className="ml-auto h-3 w-3" />
          )}
        </Button>
        {graphOpen && (
          <div id={`relation-graph-${issueId}`} className="mt-2 overflow-x-auto">
            <IssueRelationsGraph issueId={issueId} />
          </div>
        )}
      </div>
    </section>
  );
}

function AddRelationForm({ issueId, onDone }: { issueId: string; onDone: () => void }) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<Kind>(RelationKind.BLOCKS);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ id: string; number: number; title: string } | null>(
    null,
  );

  const debounced = useDebounced(query, 200);
  const search = trpc.issue.list.useQuery(
    { query: debounced || undefined, includeDone: true, limit: 10 },
    { enabled: debounced.length > 0 },
  );

  const add = trpc.relation.add.useMutation({
    onSuccess: () => {
      utils.relation.listForIssue.invalidate({ issueId });
      utils.issue.byId.invalidate({ id: issueId });
      setQuery("");
      setSelected(null);
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="border-b border-border bg-background/60 px-3 py-2.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!selected) return;
          add.mutate({
            fromIssueId: issueId,
            toIssueId: selected.id,
            kind,
          });
        }}
        className="space-y-2"
      >
        <div className="flex items-center gap-2">
          <Combobox
            value={kind}
            onChange={(v) => setKind((v as Kind) ?? RelationKind.BLOCKS)}
            options={ORDER.map((k) => ({ value: k, label: LABELS[k] }))}
            ariaLabel="Relation type"
            className="h-7 shrink-0 text-[0.6875rem]"
            popoverClassName="min-w-[9rem]"
          />
          {selected ? (
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setQuery("");
              }}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-card/60 px-2 py-1 text-left text-xs hover:border-ember/40"
              title="Change target"
            >
              <span className="text-id text-muted-foreground">
                {formatIssueId(ws.key, selected.number)}
              </span>
              <span className="truncate">{selected.title}</span>
            </button>
          ) : (
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by key or title…"
              className="h-7 min-w-0 flex-1 text-xs"
              autoFocus
            />
          )}
          <Button type="submit" size="sm" variant="ember" disabled={!selected || add.isPending}>
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        {!selected && debounced && (
          <ul className="max-h-52 overflow-y-auto rounded-md border border-border bg-card/40">
            {search.isLoading && (
              <li className="text-meta px-2 py-1.5 text-muted-foreground">Searching…</li>
            )}
            {search.data?.items
              ?.filter((i) => i.id !== issueId)
              .map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setSelected({
                        id: i.id,
                        number: i.number,
                        title: i.title,
                      })
                    }
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-subtle"
                  >
                    <span className="text-id text-muted-foreground">
                      {formatIssueId(ws.key, i.number)}
                    </span>
                    <span className="truncate">{i.title}</span>
                  </button>
                </li>
              ))}
            {!search.isLoading && (search.data?.items.length ?? 0) === 0 && (
              <li className="text-meta px-2 py-2 text-muted-foreground">No matches.</li>
            )}
          </ul>
        )}
      </form>
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [state, setState] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setState(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return state;
}
