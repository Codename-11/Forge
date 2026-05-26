"use client";

import Link from "next/link";
import {
  CircleDot,
  AtSign,
  Workflow,
  Command,
  ChevronRight,
  Server,
  Bot,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Spinner, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { relativeTime, cn } from "@/lib/utils";
import { workspaceChipColor } from "./global-shell";

/**
 * Mission Control — the cross-workspace home rendered inside the global
 * ("concourse") shell at `/`. Read-only aggregations from `global.*`
 * routers, each row stamped with a workspace chip so the user can see
 * which tenant it belongs to before clicking in. Ports the Mission
 * Control screen from the design handoff (`screens-global.jsx`).
 */

type Workspace = { id: string; slug: string; name: string; key: string };

function WsChip({ ws, dense }: { ws: Workspace; dense?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-meta",
        dense ? "" : "rounded-md border border-border bg-card/40 px-1.5 py-0.5",
      )}
    >
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] text-[8px] font-bold text-white"
        style={{ background: workspaceChipColor(ws.key) }}
      >
        {ws.key[0]}
      </span>
      <span className="text-foreground/85">{dense ? ws.key : ws.name}</span>
    </span>
  );
}

function StatusPip({ status }: { status?: string | null }) {
  const c =
    status === "ONLINE"
      ? "hsl(var(--success))"
      : status === "BUSY"
        ? "hsl(var(--ember))"
        : status === "IDLE"
          ? "hsl(var(--warning))"
          : "hsl(var(--muted-foreground))";
  return (
    <span
      aria-hidden
      style={{ width: 6, height: 6, borderRadius: 9999, background: c, display: "inline-block" }}
    />
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  sub,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  sub?: string;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground">
          <Icon size={11} />
          {label}
        </span>
      </div>
      <div className="text-[1.5rem] font-semibold leading-none tracking-tight tabular-nums">
        {loading ? <Spinner size="sm" /> : value}
      </div>
      {sub && <div className="text-meta text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionCard({
  title,
  count,
  action,
  className,
  children,
}: {
  title: string;
  count?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3", className)}>
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {count !== undefined && (
          <span className="text-meta tabular-nums text-muted-foreground">{count}</span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </header>
      {children}
    </section>
  );
}

export function MissionControlHome() {
  const summary = trpc.global.summary.useQuery();
  const work = trpc.global.work.useQuery();
  const workspaces = trpc.global.workspaces.useQuery();
  const agents = trpc.global.agents.useQuery();
  const runtimes = trpc.global.runtimes.useQuery();
  const activity = trpc.global.activity.useQuery();

  const s = summary.data;
  const agentsList = agents.data ?? [];
  const onlineAgents = agentsList.filter((a) => a.online).length;
  const runtimesList = runtimes.data ?? [];
  const runtimesOnline = runtimesList.filter((r) => r.online).length;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      {/* Top metric row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          icon={CircleDot}
          label="Assigned to me"
          value={work.data?.length ?? 0}
          sub={`across ${s?.workspaceCount ?? 0} workspaces`}
          loading={work.isLoading}
        />
        <MetricTile
          icon={AtSign}
          label="Open issues"
          value={s?.openIssues ?? 0}
          sub="across all workspaces"
          loading={summary.isLoading}
        />
        <MetricTile
          icon={Workflow}
          label="Agent runs · live"
          value={s?.activeRuns ?? 0}
          sub={`${onlineAgents} agents online`}
          loading={summary.isLoading}
        />
        <MetricTile
          icon={Command}
          label="Runtimes online"
          value={s ? `${s.runtimesOnline} / ${s.runtimeCount}` : "—"}
          sub="hosts you've registered"
          loading={summary.isLoading}
        />
      </div>

      {/* 12-col grid */}
      <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-12">
        {/* My work across workspaces */}
        <SectionCard
          title="My work"
          count={work.data ? `${work.data.length} assigned to me` : undefined}
          className="lg:col-span-8"
        >
          {work.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : (work.data?.length ?? 0) === 0 ? (
            <EmptyState
              variant="card"
              icon={<CircleDot />}
              title="Nothing assigned to you"
              description="Issues assigned to you across your workspaces show up here."
            />
          ) : (
            <div className="flex flex-col">
              {work.data!.map((issue) => (
                <Link
                  key={issue.id}
                  href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
                  className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-subtle"
                >
                  <WsChip ws={issue.workspace} />
                  <span
                    className="text-id tabular-nums text-muted-foreground"
                    style={{ minWidth: 56 }}
                  >
                    {issue.workspace.key}-{issue.number}
                  </span>
                  <span className="flex-1 truncate text-sm">{issue.title}</span>
                  {issue.status && (
                    <span className="inline-flex h-4 items-center rounded bg-subtle px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                      {issue.status.name}
                    </span>
                  )}
                  <span
                    className="text-meta tabular-nums text-muted-foreground/70"
                    style={{ minWidth: 50, textAlign: "right" }}
                  >
                    {relativeTime(issue.updatedAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Workspaces card */}
        <SectionCard
          title="Workspaces"
          count={workspaces.data?.length}
          action={
            <Link href="/settings/workspaces" className="text-meta text-muted-foreground hover:text-foreground">
              manage
            </Link>
          }
          className="lg:col-span-4"
        >
          {workspaces.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : (workspaces.data?.length ?? 0) === 0 ? (
            <EmptyState variant="card" title="No workspaces yet" />
          ) : (
            <div className="flex flex-col gap-1.5">
              {workspaces.data!.map((w) => (
                <Link
                  key={w.id}
                  href={`/w/${w.slug}`}
                  className="group flex items-center gap-2 rounded-md border border-transparent p-2 transition-colors hover:border-border hover:bg-subtle"
                >
                  <span
                    aria-hidden
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[12px] font-bold text-white"
                    style={{ background: workspaceChipColor(w.key) }}
                  >
                    {w.key[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[0.8125rem] font-semibold">{w.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{w.key}</span>
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {w.openIssues} open · {w.activeRuns} live · {w.members} members
                    </span>
                  </span>
                  <ChevronRight
                    size={11}
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        {/* My agents */}
        <SectionCard
          title="My agents"
          count={agents.data ? `${agentsList.length} · ${onlineAgents} online` : undefined}
          action={
            <Link href="/settings/agents" className="text-meta text-muted-foreground hover:text-foreground">
              configure
            </Link>
          }
          className="lg:col-span-5"
        >
          {agents.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : agentsList.length === 0 ? (
            <EmptyState
              variant="card"
              icon={<Bot />}
              title="No agent profiles"
              description="Define an agent profile and bind it to a workspace."
            />
          ) : (
            <div className="flex flex-col">
              {agentsList.map((a) => (
                <Link
                  key={a.id}
                  href={`/settings/agents/${a.id}`}
                  className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-subtle"
                >
                  <span className="text-base">{a.avatar ?? "🤖"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[0.8125rem] font-medium">{a.name}</span>
                      <StatusPip status={a.online ? "ONLINE" : "OFFLINE"} />
                      <span className="font-mono text-[10px] text-muted-foreground">@{a.profileKey}</span>
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {a.bindings.length === 0 ? (
                        <span className="italic">no bindings</span>
                      ) : (
                        a.bindings.map((b) => b.workspace.name).join(" · ")
                      )}
                    </span>
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/70">
                    {a.provider.toLowerCase()}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Runtimes */}
        <SectionCard
          title="Runtimes"
          count={runtimes.data ? `${runtimesOnline} / ${runtimesList.length} online` : undefined}
          className="lg:col-span-4"
        >
          {runtimes.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : runtimesList.length === 0 ? (
            <EmptyState
              variant="card"
              icon={<Server />}
              title="No runtimes"
              description="Run `forge daemon start` on a host to register one."
            />
          ) : (
            <div className="flex flex-col gap-1">
              {runtimesList.map((r) => {
                const Ico =
                  r.kind === "CLOUD" ? Sparkles : r.kind === "REMOTE_HTTP" ? Server : Bot;
                return (
                  <Link
                    key={r.id}
                    href="/settings/runtimes"
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-subtle"
                  >
                    <Ico size={12} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[0.8125rem] font-medium">{r.name}</span>
                        <StatusPip status={r.online ? "ONLINE" : "OFFLINE"} />
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {r.kind.toLowerCase().replace("_", " ")}
                        {r.heartbeatAt ? ` · ${relativeTime(r.heartbeatAt)}` : ""}
                      </span>
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </SectionCard>

        {/* Activity feed */}
        <SectionCard title="Activity" count="live" className="lg:col-span-3">
          {activity.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : (activity.data?.length ?? 0) === 0 ? (
            <EmptyState variant="card" title="No activity yet" />
          ) : (
            <div className="flex flex-col gap-1.5">
              {activity.data!.slice(0, 8).map((e) => (
                <div key={e.id} className="flex items-start gap-1.5 text-meta">
                  <WsChip ws={e.workspace} dense />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground/90">{e.kind.split(".")[1] || e.kind}</span>
                    {(e.actor?.name || e.actorAgent?.name) && (
                      <span className="ml-1 truncate text-muted-foreground">
                        {e.actorAgent?.name ?? e.actor?.name}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground/70">
                    {relativeTime(e.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
