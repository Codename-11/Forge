"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, ChevronUp, GripHorizontal, ChevronDown, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Compact "agent presence + heartbeat" view, sits between the pill and
 * the full panel. Shows every workspace agent with a presence dot,
 * heartbeat freshness, and current run load.
 *
 * Roster ordering: ONLINE first (by recency of heartbeat), then BUSY,
 * then OFFLINE. Archived agents are excluded.
 *
 * Pure presentation — caller owns the drag header + pin/close + sizing.
 * This component just renders the body.
 */

function relativeTime(input: Date | string | null): string {
  if (!input) return "never";
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function GlanceView({
  slug,
  onExpand,
  onCollapse,
  onPointerDownDrag,
  isDragging,
  hasStalled,
  stalledCount,
}: {
  slug: string;
  onExpand: () => void;
  onCollapse: () => void;
  onPointerDownDrag: (e: React.PointerEvent) => void;
  isDragging: boolean;
  hasStalled: boolean;
  stalledCount: number;
}) {
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const { data: activeRuns } = trpc.agentRun.activeAll.useQuery(
    { limit: 50 },
    { staleTime: 3_000 },
  );
  const { data: queue } = trpc.issue.queue.useQuery(
    { includeClaimed: false, limit: 30 },
    { staleTime: 5_000 },
  );

  // Tick once a minute so "Last seen Ns ago" stays honest without
  // hammering React. Heartbeat freshness is the whole point of this view.
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(iv);
  }, []);

  const loadByAgent = new Map<string, number>();
  for (const r of activeRuns ?? []) {
    loadByAgent.set(r.agentId, (loadByAgent.get(r.agentId) ?? 0) + 1);
  }

  const sorted = [...(agents ?? [])].sort((a, b) => {
    const order = { ONLINE: 0, BUSY: 1, OFFLINE: 2 } as const;
    const ao = order[a.status as keyof typeof order] ?? 3;
    const bo = order[b.status as keyof typeof order] ?? 3;
    if (ao !== bo) return ao - bo;
    // Tiebreak by most-recent heartbeat (a fresh ONLINE outranks a
    // stale ONLINE so the eye lands on real activity first).
    const at = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
    const bt = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });

  const onlineCount = (agents ?? []).filter((a) => a.status === "ONLINE").length;
  const busyCount = (agents ?? []).filter((a) => a.status === "BUSY").length;
  const queueCount = (queue ?? []).filter((q) => !q.assignedAgent).length;
  const activeCount = activeRuns?.length ?? 0;

  return (
    <>
      <header
        onPointerDown={onPointerDownDrag}
        className={cn(
          "flex items-center gap-2 rounded-t-lg border-b border-border/70 bg-card/80 px-3 py-2",
          isDragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Agents
        </span>
        <span className="text-meta text-muted-foreground">
          {onlineCount} online{busyCount > 0 ? ` · ${busyCount} busy` : ""}
        </span>
        <span className="ml-auto flex items-center gap-1" data-no-drag>
          <button
            type="button"
            onClick={onExpand}
            title="Open full panel"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse to pill (Esc)"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </span>
      </header>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2" data-no-drag>
        {sorted.length === 0 && (
          <div className="px-1 py-2 text-meta text-muted-foreground">
            No agents yet.
          </div>
        )}
        {sorted.map((a) => {
          const load = loadByAgent.get(a.id) ?? 0;
          const cap = a.maxConcurrent;
          const atCap = cap > 0 && load >= cap;
          const isOnline = a.status === "ONLINE";
          const isBusy = a.status === "BUSY";
          const heartbeatLabel =
            isOnline || isBusy
              ? `seen ${relativeTime(a.lastHeartbeatAt)}`
              : a.lastHeartbeatAt
                ? `offline · last ${relativeTime(a.lastHeartbeatAt)}`
                : "never seen";
          return (
            <Link
              key={a.id}
              href={`/w/${slug}/agents/${a.profileKey}`}
              className="group flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[0.75rem] hover:border-ember/40"
            >
              <PresenceDot status={a.status} />
              <Bot className="h-3.5 w-3.5 shrink-0 text-ember" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate font-medium text-foreground">{a.name}</span>
                  <span className="font-mono text-[0.65625rem] text-muted-foreground">
                    @{a.profileKey}
                  </span>
                  {/* Mode badge: "p" = persistent, "s" = session */}
                  <span
                    className={cn(
                      "rounded border px-1 py-0 font-mono text-[0.5625rem] text-muted-foreground",
                      (a.runtimeMode ?? "PERSISTENT") === "PERSISTENT"
                        ? "border-border bg-subtle/40"
                        : "border-amber-500/30 bg-subtle/40",
                    )}
                    title={(a.runtimeMode ?? "PERSISTENT") === "PERSISTENT" ? "persistent" : "session"}
                  >
                    {(a.runtimeMode ?? "PERSISTENT") === "PERSISTENT" ? "p" : "s"}
                  </span>
                  {a.role !== "WORKER" && (
                    <span className="rounded-md border border-border bg-subtle px-1 py-0 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                      {a.role.toLowerCase()}
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-1.5 text-meta text-muted-foreground">
                  <span className="truncate">{heartbeatLabel}</span>
                  {load > 0 && (
                    <>
                      <span>·</span>
                      <span
                        className={cn(
                          "font-mono",
                          atCap ? "text-amber-600" : "text-foreground/70",
                        )}
                      >
                        {cap > 0 ? `${load}/${cap}` : `${load}`} active
                      </span>
                    </>
                  )}
                </div>
              </div>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          );
        })}
      </div>

      <footer
        className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 text-meta"
        data-no-drag
      >
        <span className="text-muted-foreground">
          {activeCount} active
          {queueCount > 0 && ` · ${queueCount} queued`}
          {hasStalled && (
            <span className="ml-1.5 text-warning">
              · {stalledCount} stalled
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onExpand}
          className="rounded-md border border-border bg-card px-2 py-0.5 text-[0.6875rem] text-foreground/80 hover:border-ember/40 hover:text-foreground"
        >
          Open panel ›
        </button>
      </footer>
    </>
  );
}

/**
 * Presence dot. ONLINE pings ember, BUSY pulses ember softly without
 * the radial ping (so a busy agent reads as "occupied, not idle"),
 * OFFLINE is a flat dim disc.
 */
function PresenceDot({ status }: { status: string }) {
  if (status === "ONLINE") {
    return (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-50" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
    );
  }
  if (status === "BUSY") {
    return (
      <span
        className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-ember"
        title="BUSY"
      />
    );
  }
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
      title="OFFLINE"
    />
  );
}
