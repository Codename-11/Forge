"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Bot, CircleDot, Clock, MessageCircle, Tag } from "lucide-react";
import { Spinner, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { WsChip } from "./mission-control-home";

/**
 * Global assigned-work inbox. Rows select a read-only inspector so operators
 * can understand the work before crossing into the owning workspace.
 */
export function GlobalInbox() {
  const work = trpc.global.work.useQuery();
  const rows = work.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const utils = trpc.useUtils();
  const visited = useRef(false);
  const visit = trpc.inbox.visit.useMutation({
    onSuccess: () => void utils.inbox.badge.invalidate(),
  });

  useEffect(() => {
    if (visited.current) return;
    visited.current = true;
    visit.mutate();
  }, [visit]);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-4 sm:px-8 sm:py-6">
      {work.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CircleDot />}
          title="Your inbox is clear"
          description="Active issues assigned to you across all workspaces show up here."
        />
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <section className="overflow-hidden rounded-lg border border-border bg-card/40">
            <header className="flex items-center justify-between border-b border-border/70 px-3.5 py-3">
              <div>
                <h2 className="text-sm font-semibold">Active assignments</h2>
                <p className="text-meta mt-0.5 text-muted-foreground">
                  Select a row to inspect context before opening it.
                </p>
              </div>
              <span className="text-meta text-muted-foreground">{rows.length} open</span>
            </header>
            <div className="divide-y divide-border/60">
              {rows.map((issue) => {
                const active = selected?.id === issue.id;
                return (
                  <button
                    key={issue.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedId(issue.id)}
                    className={cn(
                      "focus-ring grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 text-left hover:bg-subtle",
                      active && "bg-subtle/80",
                    )}
                  >
                    <WsChip ws={issue.workspace} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="text-id shrink-0 tabular-nums text-muted-foreground">
                          {issue.workspace.key}-{issue.number}
                        </span>
                        <span className="truncate text-[0.8125rem] font-medium">{issue.title}</span>
                      </span>
                      <span className="text-meta mt-0.5 block truncate text-muted-foreground">
                        {issue.currentRun?.currentStep
                          ? `${issue.currentRun.agent.name} · ${issue.currentRun.currentStep}`
                          : (issue.project?.name ?? "No project")}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="rounded bg-subtle px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                        {issue.status.name}
                      </span>
                      <span className="text-meta tabular-nums text-muted-foreground/70">
                        {relativeTime(issue.updatedAt)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {selected && (
            <aside className="overflow-hidden rounded-lg border border-border bg-card/50 lg:sticky lg:top-4">
              <header className="border-b border-border/70 px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <WsChip ws={selected.workspace} />
                  <span className="text-id text-muted-foreground">
                    {selected.workspace.key}-{selected.number}
                  </span>
                  <span className="ml-auto rounded bg-subtle px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    {selected.status.name}
                  </span>
                </div>
                <h2 className="mt-3 text-base font-semibold leading-snug">{selected.title}</h2>
                <p className="text-meta mt-1.5 line-clamp-5 whitespace-pre-wrap leading-relaxed text-muted-foreground">
                  {selected.description?.trim() || "No description yet."}
                </p>
              </header>

              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 text-[0.75rem]">
                <dt className="text-muted-foreground">Priority</dt>
                <dd className="capitalize">{selected.priority.toLowerCase()}</dd>
                <dt className="text-muted-foreground">Project</dt>
                <dd className="truncate">{selected.project?.name ?? "No project"}</dd>
                <dt className="text-muted-foreground">Agent</dt>
                <dd className="truncate">
                  {selected.assignedAgent
                    ? `${selected.assignedAgent.name} · @${selected.assignedAgent.profileKey}`
                    : "Unassigned"}
                </dd>
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{relativeTime(selected.updatedAt)}</dd>
                {selected.dueDate && (
                  <>
                    <dt className="text-muted-foreground">Due</dt>
                    <dd>{new Date(selected.dueDate).toLocaleDateString()}</dd>
                  </>
                )}
              </dl>

              {selected.labels.length > 0 && (
                <div className="flex flex-wrap gap-1.5 border-t border-border/70 px-4 py-3">
                  <Tag className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
                  {selected.labels.map((label) => (
                    <span
                      key={label.id}
                      className="rounded border border-border/70 bg-background px-1.5 py-0.5 text-[10px]"
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              )}

              {selected.currentRun && (
                <div className="border-t border-border/70 px-4 py-3">
                  <div className="flex items-center gap-2 text-[0.75rem] font-medium">
                    <Bot className="h-3.5 w-3.5 text-ember" />
                    {selected.currentRun.agent.name}
                    <span className="rounded bg-ember/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-ember">
                      {selected.currentRun.status.toLowerCase()}
                    </span>
                  </div>
                  <p className="text-meta mt-1.5 leading-relaxed text-muted-foreground">
                    {selected.currentRun.currentStep ?? "Run is active without a current step."}
                  </p>
                </div>
              )}

              {selected.latestComment && (
                <div className="border-t border-border/70 px-4 py-3">
                  <div className="flex items-center gap-2 text-[0.75rem] font-medium">
                    <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" /> Latest comment
                    <span className="text-meta ml-auto text-muted-foreground">
                      {relativeTime(selected.latestComment.createdAt)}
                    </span>
                  </div>
                  <p className="text-meta mt-1.5 line-clamp-4 whitespace-pre-wrap leading-relaxed text-muted-foreground">
                    {selected.latestComment.body}
                  </p>
                </div>
              )}

              <div className="grid gap-2 border-t border-border/70 p-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <Link
                  href={`/w/${selected.workspace.slug}/i/${selected.workspace.key}-${selected.number}`}
                  className="focus-ring inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md bg-ember px-3 text-xs font-semibold text-ember-foreground hover:bg-ember/90 sm:min-h-9"
                >
                  Open issue <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
                <Link
                  href={`/w/${selected.workspace.slug}/inbox`}
                  className="focus-ring inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium hover:border-ember/40 sm:min-h-9"
                >
                  Workspace inbox <Clock className="h-3.5 w-3.5" />
                </Link>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
