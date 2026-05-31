"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { RelationKind } from "@prisma/client";
import { List, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  RelationKind.BLOCKS,
  RelationKind.BLOCKED_BY,
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
  DONE: "bg-success",
  CANCELED: "bg-danger/60",
};

export function IssueRelationsPanel({ issueId }: { issueId: string }) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.relation.listForIssue.useQuery({ issueId });
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");

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
    <section className="mt-8 rounded-lg border border-border bg-card/40">
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Relations
        </h2>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">
          {totalCount}
        </span>
        {/* List / Graph view toggle — the graph maps the issue's place in
            its blocks + sub-issue dependency path; the list stays the
            editing surface. */}
        <div className="ml-auto flex items-center rounded-md border border-border p-0.5">
          {(
            [
              { id: "list" as const, label: "List", Icon: List },
              { id: "graph" as const, label: "Graph", Icon: Workflow },
            ]
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              title={`${label} view`}
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium transition-colors",
                view === id
                  ? "bg-ember/15 text-ember"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>
        {view === "list" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[0.6875rem]"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "Cancel" : "Add relation"}
          </Button>
        )}
      </header>

      {view === "graph" ? (
        <div className="p-3">
          <IssueRelationsGraph issueId={issueId} />
        </div>
      ) : (
        <>
      {adding && (
        <AddRelationForm
          issueId={issueId}
          onDone={() => setAdding(false)}
        />
      )}

      <div className="divide-y divide-border">
        {isLoading && (
          <div className="px-3 py-3 text-meta text-muted-foreground">Loading…</div>
        )}
        {!isLoading &&
          ORDER.map((kind) => {
            const rows = data?.[kind] ?? [];
            if (rows.length === 0) return null;
            return (
              <div key={kind} className="px-3 py-2">
                <div className="mb-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                  {LABELS[kind]}
                </div>
                <ul className="space-y-1">
                  {rows.map((r) => (
                    <li key={r.relationId} className="group flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-block h-2 w-2 shrink-0 rounded-full",
                          STATUS_DOT[r.target.statusCategory] ?? "bg-muted",
                        )}
                        title={r.target.statusCategory}
                      />
                      <Link
                        href={`/w/${ws.slug}/issues/${r.target.id}`}
                        className="flex min-w-0 flex-1 items-center gap-2 hover:text-ember"
                      >
                        <span className="text-id text-muted-foreground">
                          {formatIssueId(ws.key, r.target.number)}
                        </span>
                        <span className="truncate text-xs">{r.target.title}</span>
                      </Link>
                      <button
                        type="button"
                        onClick={() =>
                          remove.mutate({ relationId: r.relationId })
                        }
                        aria-label="Remove relation"
                        title="Remove"
                        className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                      >
                        <span className="text-xs">×</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        {!isLoading && totalCount === 0 && !adding && (
          <div className="px-3 py-4 text-center text-meta text-muted-foreground">
            No relations. Use{" "}
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
        </>
      )}
    </section>
  );
}

function AddRelationForm({
  issueId,
  onDone,
}: {
  issueId: string;
  onDone: () => void;
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<Kind>(RelationKind.BLOCKS);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<
    | { id: string; number: number; title: string }
    | null
  >(null);

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
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className="focus-ring h-7 rounded-md border border-input bg-background px-1.5 text-[0.6875rem]"
          >
            {ORDER.map((k) => (
              <option key={k} value={k}>
                {LABELS[k]}
              </option>
            ))}
          </select>
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
          <Button
            type="submit"
            size="sm"
            variant="ember"
            disabled={!selected || add.isPending}
          >
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        {!selected && debounced && (
          <ul className="max-h-52 overflow-y-auto rounded-md border border-border bg-card/40">
            {search.isLoading && (
              <li className="px-2 py-1.5 text-meta text-muted-foreground">
                Searching…
              </li>
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
              <li className="px-2 py-2 text-meta text-muted-foreground">
                No matches.
              </li>
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
