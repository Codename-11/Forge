"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity as ActivityIcon, ArrowUpRight, CircleDot } from "lucide-react";
import { Spinner, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { WsChip } from "./mission-control-home";

/**
 * Cross-workspace activity with a compact stream and a persistent inspector.
 * The server owns event interpretation so this page, Mission Control, and
 * future notification surfaces all use the same human-readable copy + links.
 */
export function GlobalActivity() {
  const activity = trpc.global.activity.useQuery();
  const rows = activity.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-4 sm:px-8 sm:py-6">
      {activity.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon />}
          title="No activity yet"
          description="Runs, comments, and decisions across your workspaces appear here as they happen."
        />
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="overflow-hidden rounded-lg border border-border bg-card/40">
            <header className="flex items-center justify-between border-b border-border/70 px-3.5 py-3">
              <div>
                <h2 className="text-sm font-semibold">Recent changes</h2>
                <p className="text-meta mt-0.5 text-muted-foreground">
                  Repeated watchdog updates are grouped by subject.
                </p>
              </div>
              <span className="text-meta text-muted-foreground">{rows.length} events</span>
            </header>
            <div className="divide-y divide-border/60">
              {rows.map((event) => {
                const active = selected?.id === event.id;
                return (
                  <button
                    key={event.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedId(event.id)}
                    className={cn(
                      "focus-ring grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3.5 py-3 text-left hover:bg-subtle",
                      active && "bg-subtle/80",
                    )}
                  >
                    <WsChip ws={event.workspace} dense />
                    <span className="min-w-0">
                      <span className="block truncate text-[0.8125rem] font-medium">
                        {event.title}
                      </span>
                      {event.detail && (
                        <span className="text-meta mt-0.5 block truncate text-muted-foreground">
                          {event.detail}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {event.occurrences > 1 && (
                        <span className="rounded bg-background px-1 font-mono text-[10px] text-muted-foreground">
                          ×{event.occurrences}
                        </span>
                      )}
                      <span className="text-meta shrink-0 tabular-nums text-muted-foreground/70">
                        {relativeTime(event.createdAt)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {selected && (
            <aside className="rounded-lg border border-border bg-card/50 lg:sticky lg:top-4">
              <header className="border-b border-border/70 px-4 py-3">
                <div className="flex items-center gap-2">
                  <WsChip ws={selected.workspace} />
                  <span className="rounded bg-subtle px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    {selected.category}
                  </span>
                </div>
                <h2 className="mt-3 text-base font-semibold leading-snug">{selected.title}</h2>
                {selected.detail && (
                  <p className="text-meta mt-1.5 leading-relaxed text-muted-foreground">
                    {selected.detail}
                  </p>
                )}
              </header>
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 text-[0.75rem]">
                <dt className="text-muted-foreground">Actor</dt>
                <dd className="truncate">{selected.actor.label}</dd>
                <dt className="text-muted-foreground">Subject</dt>
                <dd className="truncate">{selected.subject.label}</dd>
                <dt className="text-muted-foreground">Event</dt>
                <dd className="truncate">{selected.kind.replaceAll("_", " ").toLowerCase()}</dd>
                <dt className="text-muted-foreground">When</dt>
                <dd>{relativeTime(selected.createdAt)}</dd>
                {selected.occurrences > 1 && (
                  <>
                    <dt className="text-muted-foreground">Grouped</dt>
                    <dd>{selected.occurrences} related updates</dd>
                  </>
                )}
              </dl>
              <div className="border-t border-border/70 p-3">
                <Link
                  href={selected.href}
                  className="focus-ring inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-md bg-ember px-3 text-xs font-semibold text-ember-foreground hover:bg-ember/90 sm:min-h-9"
                >
                  Open source <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
                <p className="text-meta mt-2 flex items-center gap-1.5 text-muted-foreground">
                  <CircleDot className="h-3 w-3" /> Mission Control remains read-only.
                </p>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
