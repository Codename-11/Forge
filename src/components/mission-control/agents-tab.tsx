"use client";
import Link from "next/link";
import { Bot, Cloud, ExternalLink, Globe, HardDrive, Server } from "lucide-react";
import type { RuntimeKind } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Agents tab. Roster of workspace agents with status pill, runtime mode
 * badge, last-seen freshness, capabilities, current load (active runs),
 * and a click-through to /agents/{profileKey}.
 */

function relativeTime(input: Date | string | null): string {
  if (!input) return "no heartbeat";
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function AgentsTab({ slug }: { slug: string }) {
  const { data: agents, isLoading } = trpc.agent.list.useQuery({
    includeArchived: false,
  });
  const { data: activeRuns } = trpc.agentRun.activeAll.useQuery({ limit: 50 });

  if (isLoading) {
    return (
      <div className="px-3 py-4 text-meta text-muted-foreground">Loading agents…</div>
    );
  }

  // Count ACTIVE runs per agent for the load chip.
  const loadByAgent = new Map<string, number>();
  for (const run of activeRuns ?? []) {
    loadByAgent.set(run.agentId, (loadByAgent.get(run.agentId) ?? 0) + 1);
  }

  // Sort: PERSISTENT+ONLINE first, PERSISTENT+BUSY, EPHEMERAL (by lastHeartbeatAt desc), then OFFLINE
  const sorted = [...(agents ?? [])].sort((a, b) => {
    const modeRank = (mode: string) => (mode === "PERSISTENT" ? 0 : 1);
    const statusRank = (status: string) => {
      if (status === "ONLINE") return 0;
      if (status === "BUSY") return 1;
      return 2;
    };
    const aMode = a.runtimeMode ?? "PERSISTENT";
    const bMode = b.runtimeMode ?? "PERSISTENT";

    // PERSISTENT ONLINE/BUSY come before EPHEMERAL anything
    if (aMode !== bMode) {
      // If both are non-offline, mode rank first
      const aIsActive = a.status === "ONLINE" || a.status === "BUSY";
      const bIsActive = b.status === "ONLINE" || b.status === "BUSY";
      // Persistent actives beat ephemeral actives
      if (aIsActive && bIsActive) return modeRank(aMode) - modeRank(bMode);
    }

    const aStatusR = statusRank(a.status);
    const bStatusR = statusRank(b.status);
    if (aStatusR !== bStatusR) return aStatusR - bStatusR;

    // Within same status, sort EPHEMERAL by recency
    const at = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
    const bt = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
    if (at !== bt) return bt - at;

    return a.name.localeCompare(b.name);
  });

  return (
    <div className="space-y-1.5 overflow-y-auto px-2 py-2">
      {sorted.length === 0 && (
        <div className="px-1 py-2 text-meta text-muted-foreground">
          No agents in this workspace.
        </div>
      )}
      {sorted.map((a) => {
        const load = loadByAgent.get(a.id) ?? 0;
        const cap = a.maxConcurrent;
        const atCap = cap > 0 && load >= cap;
        const mode = a.runtimeMode ?? "PERSISTENT";
        const modeLabel = mode === "PERSISTENT" ? "persistent" : "session";
        const isOffline = a.status === "OFFLINE";
        return (
          <Link
            key={a.id}
            href={`/w/${slug}/agents/${a.profileKey}`}
            className="flex flex-col gap-0.5 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[0.75rem] hover:border-ember/40"
          >
            <div className="flex items-center gap-2">
              <PresenceDot status={a.status} />
              <Bot className="h-3.5 w-3.5 shrink-0 text-ember" />
              <span className="font-medium text-foreground">{a.name}</span>
              <span className="font-mono text-[0.65625rem] text-muted-foreground">
                @{a.profileKey}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {/* Runtime mode pill */}
                <span
                  className={cn(
                    "rounded border px-1 py-0 text-[0.5625rem] uppercase tracking-wider text-muted-foreground",
                    mode === "PERSISTENT"
                      ? "border-border bg-subtle/40"
                      : "border-amber-500/30 bg-subtle/40",
                  )}
                >
                  {modeLabel}
                </span>
                {a.runtime && (
                  <RuntimeChip
                    slug={slug}
                    runtimeId={a.runtime.id}
                    name={a.runtime.name}
                    kind={a.runtime.kind}
                  />
                )}
                {a.role !== "WORKER" && (
                  <span className="rounded-md border border-border bg-subtle px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                    {a.role}
                  </span>
                )}
                <span
                  className={cn(
                    "font-mono text-[0.65625rem]",
                    atCap ? "text-amber-600" : "text-muted-foreground",
                  )}
                  title={
                    cap > 0
                      ? `${load} active / ${cap} max`
                      : `${load} active (no cap)`
                  }
                >
                  {cap > 0 ? `${load}/${cap}` : `${load}`}
                </span>
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
              </span>
            </div>
            {/* Last-seen freshness when offline */}
            {isOffline && (
              <div className="pl-7 text-meta text-muted-foreground">
                {a.lastHeartbeatAt
                  ? `seen ${relativeTime(a.lastHeartbeatAt)}`
                  : "no heartbeat"}
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}

function RuntimeChip({
  slug,
  runtimeId,
  name,
  kind,
}: {
  slug: string;
  runtimeId: string;
  name: string;
  kind: RuntimeKind;
}) {
  const Icon =
    kind === "LOCAL_DAEMON"
      ? HardDrive
      : kind === "REMOTE_HTTP"
        ? Globe
        : kind === "CLOUD"
          ? Cloud
          : Server;
  return (
    <Link
      href={`/w/${slug}/settings/runtimes/${runtimeId}`}
      onClick={(e) => e.stopPropagation()}
      title={`Runtime · ${kindLabel(kind)} · ${name}`}
      className="inline-flex max-w-[10rem] items-center gap-1 rounded border border-border bg-subtle/40 px-1 py-0 text-[0.5625rem] text-muted-foreground hover:border-ember/40 hover:text-foreground"
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate font-mono">{name}</span>
    </Link>
  );
}

function kindLabel(kind: RuntimeKind): string {
  switch (kind) {
    case "LOCAL_DAEMON":
      return "local daemon";
    case "REMOTE_HTTP":
      return "remote webhook";
    case "CLOUD":
      return "cloud";
    default:
      return String(kind);
  }
}

function PresenceDot({ status }: { status: string }) {
  const colorClass =
    status === "ONLINE"
      ? "bg-emerald-500"
      : status === "BUSY"
        ? "bg-ember"
        : "bg-muted-foreground/40";
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", colorClass)}
      title={status}
    />
  );
}
