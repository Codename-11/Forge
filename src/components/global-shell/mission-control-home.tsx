"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  AtSign,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDot,
  ExternalLink,
  Inbox,
  Server,
  Settings2,
  Sparkles,
  Workflow,
} from "lucide-react";
import { EmptyState, Spinner } from "@/components/ui";
import { activityActorName, activityActorOwnerTitle } from "@/lib/activity-actor";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";
import { deriveGlobalOperationsPosture } from "./global-operations-model";
import { WorkspaceBadge } from "./global-shell";

type Workspace = { id: string; slug: string; name: string; key: string };

export function WsChip({ ws, dense }: { ws: Workspace; dense?: boolean }) {
  const color = workspaceColor(ws.key);
  return (
    <span
      className={cn(
        "text-meta inline-flex items-center gap-1",
        dense ? "" : "rounded-md border border-border bg-card/40 px-1.5 py-0.5",
      )}
    >
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] font-mono text-[8px] font-bold"
        style={{
          background: color.bg,
          color: color.fg,
          boxShadow: `inset 0 0 0 1px ${color.ring}`,
        }}
      >
        {ws.key[0]}
      </span>
      <span className="text-foreground/85">{dense ? ws.key : ws.name}</span>
    </span>
  );
}

function StatusPip({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-success" : "bg-danger")}
    />
  );
}

function SectionCard({
  title,
  eyebrow,
  count,
  action,
  className,
  children,
}: {
  title: string;
  eyebrow: string;
  count?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-card/40", className)}
    >
      <header className="flex min-h-14 items-center gap-3 border-b border-border/70 px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
            {count !== undefined && (
              <span className="text-meta shrink-0 tabular-nums text-muted-foreground">{count}</span>
            )}
          </div>
        </div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function RetryState({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-3 px-4 py-6 text-center">
      <CircleAlert className="h-5 w-5 text-danger" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-meta mt-1 text-muted-foreground">
          The rest of Mission Control is still available.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring min-h-10 rounded-md border border-border bg-background px-3 text-xs font-medium hover:border-ember/40 sm:min-h-9"
      >
        Try again
      </button>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="text-meta flex min-h-36 items-center justify-center gap-2 px-4 py-6 text-muted-foreground">
      <Spinner size="sm" /> {label}
    </div>
  );
}

function HeaderLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-[0.6875rem] font-medium text-muted-foreground hover:bg-subtle hover:text-foreground sm:min-h-9"
    >
      {children}
    </Link>
  );
}

function SignalMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone = "neutral",
}: {
  icon: typeof Server;
  label: string;
  value: ReactNode;
  detail: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    neutral: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];

  return (
    <div className="min-w-0 px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={cn("mt-2 text-xl font-semibold tabular-nums leading-none", toneClass)}>
        {value}
      </div>
      <div className="text-meta mt-1.5 truncate text-muted-foreground">{detail}</div>
    </div>
  );
}

export function MissionControlHome() {
  const summary = trpc.global.summary.useQuery();
  const work = trpc.global.work.useQuery();
  const workspaces = trpc.global.workspaces.useQuery();
  const agents = trpc.global.agents.useQuery();
  const runtimes = trpc.global.runtimes.useQuery();
  const activity = trpc.global.activity.useQuery();

  const snapshot = summary.data;
  const agentsList = agents.data ?? [];
  const onlineAgents = agentsList.filter((agent) => agent.online).length;
  const runtimesList = runtimes.data ?? [];
  const runtimesOnline = runtimesList.filter((runtime) => runtime.online).length;
  const assignedWork = work.data ?? [];
  const workspaceList = [...(workspaces.data ?? [])].sort(
    (a, b) => b.activeRuns - a.activeRuns || b.openIssues - a.openIssues,
  );

  const posture = snapshot
    ? deriveGlobalOperationsPosture({
        activeRuns: snapshot.activeRuns,
        agentsOnline: snapshot.agentsOnline,
        runtimeCount: snapshot.runtimeCount,
        runtimesOnline: snapshot.runtimesOnline,
      })
    : null;

  const postureClasses = posture
    ? {
        success: "border-success/30 bg-success/5 text-success",
        warning: "border-warning/30 bg-warning/5 text-warning",
        danger: "border-danger/30 bg-danger/5 text-danger",
        neutral: "border-border bg-background/40 text-muted-foreground",
      }[posture.tone]
    : "border-border bg-background/40 text-muted-foreground";

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-3 px-4 py-4 sm:px-8 sm:py-6">
      <section
        aria-labelledby="global-operations-heading"
        className="overflow-hidden rounded-lg border border-border bg-card/50"
      >
        <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-3.5 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Operator posture
            </div>
            <h2
              id="global-operations-heading"
              className="mt-0.5 text-base font-semibold tracking-tight"
            >
              Runtime and dispatch health
            </h2>
          </div>
          {posture && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 sm:ml-auto",
                postureClasses,
              )}
            >
              {posture.tone === "success" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : posture.tone === "neutral" ? (
                <CircleDot className="h-3.5 w-3.5" />
              ) : (
                <CircleAlert className="h-3.5 w-3.5" />
              )}
              <span className="text-xs font-semibold">{posture.label}</span>
            </div>
          )}
        </div>

        {summary.isLoading ? (
          <LoadingState label="Checking operations…" />
        ) : summary.isError || !snapshot || !posture ? (
          <RetryState
            title="Operations summary is unavailable"
            onRetry={() => void summary.refetch()}
          />
        ) : (
          <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="grid grid-cols-2 divide-x divide-y divide-border/70 sm:grid-cols-4 sm:divide-y-0 lg:border-r lg:border-border/70">
              <SignalMetric
                icon={Server}
                label="Runtimes"
                value={`${snapshot.runtimesOnline} / ${snapshot.runtimeCount}`}
                detail={snapshot.runtimeCount === 0 ? "none registered" : "available now"}
                tone={
                  snapshot.runtimeCount === 0
                    ? "warning"
                    : snapshot.runtimesOnline < snapshot.runtimeCount
                      ? "danger"
                      : "success"
                }
              />
              <SignalMetric
                icon={Bot}
                label="Agent capacity"
                value={snapshot.agentsOnline}
                detail="online across workspaces"
                tone={snapshot.agentsOnline > 0 ? "success" : "neutral"}
              />
              <SignalMetric
                icon={Workflow}
                label="Live runs"
                value={snapshot.activeRuns}
                detail="executing now"
                tone={snapshot.activeRuns > 0 ? "success" : "neutral"}
              />
              <SignalMetric
                icon={AtSign}
                label="Open queue"
                value={snapshot.openIssues}
                detail={`across ${snapshot.workspaceCount} ${snapshot.workspaceCount === 1 ? "workspace" : "workspaces"}`}
                tone={snapshot.openIssues > 0 ? "warning" : "success"}
              />
            </div>
            <div className="flex flex-col justify-center gap-3 border-t border-border/70 px-4 py-3.5 lg:border-t-0">
              <div>
                <div className="text-sm font-semibold">{posture.label}</div>
                <p className="text-meta mt-1 leading-relaxed text-muted-foreground">
                  {posture.summary}
                </p>
              </div>
              <Link
                href={posture.actionHref}
                className="focus-ring inline-flex min-h-10 w-fit items-center gap-1.5 rounded-md bg-ember px-3 text-xs font-semibold text-ember-foreground hover:bg-ember/90 sm:min-h-9"
              >
                {posture.actionLabel} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <SectionCard
          eyebrow="Queue"
          title="Workspaces needing attention"
          count={snapshot ? `${snapshot.openIssues} open` : undefined}
          action={<HeaderLink href="/settings/workspaces">Manage</HeaderLink>}
          className="lg:col-span-8"
        >
          {workspaces.isLoading ? (
            <LoadingState label="Loading workspace queues…" />
          ) : workspaces.isError ? (
            <RetryState
              title="Workspace queues are unavailable"
              onRetry={() => void workspaces.refetch()}
            />
          ) : workspaceList.length === 0 ? (
            <EmptyState
              variant="card"
              icon={<Sparkles />}
              title="No workspaces yet"
              description="Create a workspace to start routing work through Mission Control."
            />
          ) : (
            <div className="divide-y divide-border/70">
              {workspaceList.map((workspace) => (
                <div
                  key={workspace.id}
                  className="grid gap-3 px-3.5 py-3 hover:bg-subtle/60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <WorkspaceBadge ws={workspace} size={30} />
                    <div className="min-w-0">
                      <Link
                        href={`/w/${workspace.slug}`}
                        className="focus-ring inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-md text-[0.8125rem] font-semibold hover:text-ember sm:min-h-0"
                      >
                        <span className="truncate">{workspace.name}</span>
                        <span className="font-mono text-[10px] font-normal text-muted-foreground">
                          {workspace.key}
                        </span>
                      </Link>
                      <div className="text-meta flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                        <span>{workspace.agents} agents</span>
                        <span aria-hidden>·</span>
                        <span>{workspace.members} members</span>
                        {workspace.lastActiveAt && (
                          <>
                            <span aria-hidden>·</span>
                            <span>active {relativeTime(workspace.lastActiveAt)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <div className="flex items-center gap-4 text-right">
                      <div>
                        <div className="text-sm font-semibold tabular-nums">
                          {workspace.openIssues}
                        </div>
                        <div className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                          Open
                        </div>
                      </div>
                      <div>
                        <div
                          className={cn(
                            "text-sm font-semibold tabular-nums",
                            workspace.activeRuns > 0 && "text-success",
                          )}
                        >
                          {workspace.activeRuns}
                        </div>
                        <div className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                          Live
                        </div>
                      </div>
                    </div>
                    <Link
                      href={`/w/${workspace.slug}/issues`}
                      aria-label={`Open ${workspace.name} issue queue`}
                      className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background hover:border-ember/40 hover:text-ember sm:h-9 sm:w-9"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          eyebrow="Attention"
          title="Assigned to you"
          count={work.data ? assignedWork.length : undefined}
          action={<HeaderLink href="/inbox">Open inbox</HeaderLink>}
          className="lg:col-span-4"
        >
          {work.isLoading ? (
            <LoadingState label="Checking assignments…" />
          ) : work.isError ? (
            <RetryState title="Assignments are unavailable" onRetry={() => void work.refetch()} />
          ) : assignedWork.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center px-5 py-7 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-success/30 bg-success/5 text-success">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              <p className="mt-3 text-sm font-medium">No assigned attention</p>
              <p className="text-meta mt-1 max-w-56 leading-relaxed text-muted-foreground">
                You are clear. Open workspace queues remain visible at left.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/70">
              {assignedWork.slice(0, 6).map((issue) => (
                <Link
                  key={issue.id}
                  href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
                  className="focus-ring group flex min-h-12 items-center gap-2 px-3.5 py-2 hover:bg-subtle"
                >
                  <WsChip ws={issue.workspace} dense />
                  <span className="text-id shrink-0 tabular-nums text-muted-foreground">
                    {issue.workspace.key}-{issue.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[0.75rem]">{issue.title}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          eyebrow="Coverage"
          title="Agent presence"
          count={agents.data ? `${onlineAgents} online · ${agentsList.length} total` : undefined}
          action={<HeaderLink href="/settings/agents">Configure</HeaderLink>}
          className="lg:col-span-5"
        >
          {agents.isLoading ? (
            <LoadingState label="Loading agent coverage…" />
          ) : agents.isError ? (
            <RetryState
              title="Agent coverage is unavailable"
              onRetry={() => void agents.refetch()}
            />
          ) : agentsList.length === 0 ? (
            <EmptyState
              variant="card"
              icon={<Bot />}
              title="No agent profiles"
              description="Define an agent profile and bind it to a workspace."
            />
          ) : (
            <div className="divide-y divide-border/70">
              {agentsList.slice(0, 6).map((agent) => (
                <Link
                  key={agent.id}
                  href={`/settings/agents/${agent.id}`}
                  className="focus-ring flex min-h-12 items-center gap-2.5 px-3.5 py-2 hover:bg-subtle"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold">
                    {agent.avatar ?? agent.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <StatusPip online={agent.online} />
                      <span className="truncate text-[0.8125rem] font-medium">{agent.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        @{agent.profileKey}
                      </span>
                    </span>
                    <span className="text-meta block truncate text-muted-foreground">
                      {agent.bindings.length === 0
                        ? "No workspace bindings"
                        : agent.bindings.map((binding) => binding.workspace.name).join(" · ")}
                    </span>
                  </span>
                  <span className="text-meta shrink-0 text-muted-foreground">
                    {agent.online ? "Online" : "Offline"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          eyebrow="Execution"
          title="Runtime coverage"
          count={runtimes.data ? `${runtimesOnline} / ${runtimesList.length} online` : undefined}
          action={
            <HeaderLink href="/settings/runtimes">
              <Settings2 className="h-3.5 w-3.5" /> Settings
            </HeaderLink>
          }
          className="lg:col-span-4"
        >
          {runtimes.isLoading ? (
            <LoadingState label="Checking runtimes…" />
          ) : runtimes.isError ? (
            <RetryState
              title="Runtime coverage is unavailable"
              onRetry={() => void runtimes.refetch()}
            />
          ) : runtimesList.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center px-5 py-7 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-warning/30 bg-warning/5 text-warning">
                <Server className="h-4 w-4" />
              </span>
              <p className="mt-3 text-sm font-medium">No runtimes registered</p>
              <p className="text-meta mt-1 max-w-64 leading-relaxed text-muted-foreground">
                Register a host before agents can execute queued work.
              </p>
              <Link
                href="/settings/runtimes"
                className="focus-ring mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium hover:border-ember/40 sm:min-h-9"
              >
                Register runtime <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border/70">
              {runtimesList.slice(0, 5).map((runtime) => (
                <Link
                  key={runtime.id}
                  href="/settings/runtimes"
                  className="focus-ring flex min-h-12 items-center gap-2.5 px-3.5 py-2 hover:bg-subtle"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                    {runtime.kind === "CLOUD" ? (
                      <Sparkles className="h-3.5 w-3.5" />
                    ) : (
                      <Server className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <StatusPip online={runtime.online} />
                      <span className="truncate text-[0.8125rem] font-medium">{runtime.name}</span>
                    </span>
                    <span className="text-meta block truncate text-muted-foreground">
                      {runtime.kind.toLowerCase().replace("_", " ")}
                      {runtime.heartbeatAt ? ` · ${relativeTime(runtime.heartbeatAt)}` : ""}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          eyebrow="Recent"
          title="Activity"
          count={activity.data ? "live" : undefined}
          action={
            <HeaderLink href="/activity">
              View all <ExternalLink className="h-3 w-3" />
            </HeaderLink>
          }
          className="lg:col-span-3"
        >
          {activity.isLoading ? (
            <LoadingState label="Loading activity…" />
          ) : activity.isError ? (
            <RetryState title="Activity is unavailable" onRetry={() => void activity.refetch()} />
          ) : (activity.data?.length ?? 0) === 0 ? (
            <EmptyState
              variant="card"
              icon={<Activity />}
              title="No activity yet"
              description="Agent and operator events will appear here."
            />
          ) : (
            <div className="divide-y divide-border/70">
              {activity.data!.slice(0, 8).map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/30 px-3.5 py-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 text-[0.75rem] text-muted-foreground">
          <Inbox className="h-3.5 w-3.5" /> Mission Control is read-only across workspaces.
        </div>
        <div className="flex flex-wrap gap-1 sm:ml-auto">
          <HeaderLink href="/inbox">Open inbox</HeaderLink>
          <HeaderLink href="/activity">View activity</HeaderLink>
        </div>
      </div>
    </div>
  );
}

function ActivityRow({
  event,
}: {
  event: {
    kind: string;
    createdAt: Date | string;
    actor: { name: string | null } | null;
    actorAgent: { name: string | null; profileKey?: string | null } | null;
    workspace: Workspace;
  };
}) {
  const actor = activityActorName(event);
  const ownerTitle = activityActorOwnerTitle(event);

  return (
    <div className="text-meta flex min-h-11 items-start gap-2 px-3.5 py-2">
      <WsChip ws={event.workspace} dense />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground/90">
          {event.kind.split(".")[1] || event.kind}
        </span>
        <span className="block truncate text-muted-foreground" title={ownerTitle}>
          {actor}
        </span>
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground/70">
        {relativeTime(event.createdAt)}
      </span>
    </div>
  );
}
