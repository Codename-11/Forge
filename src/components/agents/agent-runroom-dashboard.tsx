"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Gauge,
  GitBranch,
  Inbox,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  Workflow,
  XCircle,
} from "lucide-react";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { Button, EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import type { AppRouter } from "@/server/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Agent = RouterOutputs["agent"]["list"][number];
type Pipeline = RouterOutputs["agent"]["pipeline"];
type PipelineLane = Pipeline["lanes"][number];
type PipelineIssue = PipelineLane["assigned"][number];
type DispatchAgent = RouterOutputs["analytics"]["dispatch"]["summary"]["perAgent"][number];
type RuntimeRow = RouterOutputs["runtime"]["list"][number];
type GlobalRuntime = RouterOutputs["global"]["runtimes"][number];
type FailedRun = RouterOutputs["agentRun"]["list"][number];
type TimelineEvent = RouterOutputs["agent"]["timeline"]["events"][number];

type HeartbeatSeverity = "ok" | "warn" | "critical";
type Tone = "success" | "warning" | "danger" | "muted" | "ember";

const FAILED_RUNS_INPUT = {
  status: ["ABANDONED", "STALLED"] as ("ABANDONED" | "STALLED")[],
  limit: 30,
};

export function AgentRunroomDashboard() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const agentsQuery = trpc.agent.list.useQuery({ includeArchived: false });
  const pipelineQuery = trpc.agent.pipeline.useQuery({});
  const { data: dispatch } = trpc.analytics.dispatch.summary.useQuery({});
  const workspaceQuery = trpc.workspace.current.useQuery();
  const { data: runtimes } = trpc.runtime.list.useQuery({ includeArchived: false });
  const { data: globalRuntimes } = trpc.global.runtimes.useQuery();
  const { data: activeRuns } = trpc.agentRun.activeAll.useQuery({ limit: 50 });
  const { data: failedRuns } = trpc.agentRun.list.useQuery(FAILED_RUNS_INPUT);
  const { data: timeline } = trpc.agent.timeline.useQuery({ limit: 12 });
  const agents = agentsQuery.data;
  const pipeline = pipelineQuery.data;
  const workspace = workspaceQuery.data;

  useRealtime(
    () => {
      void utils.agent.list.invalidate();
      void utils.agent.pipeline.invalidate();
      void utils.agent.timeline.invalidate();
      void utils.analytics.dispatch.summary.invalidate();
      void utils.runtime.list.invalidate();
      void utils.global.runtimes.invalidate();
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.list.invalidate();
    },
    {
      kind: [
        "AGENT_STATUS_CHANGED",
        "AGENT_ASSIGNED",
        "AGENT_UPDATED",
        "AGENT_NOACK",
        "ISSUE_STATUS_CHANGED",
        "ISSUE_QUEUED",
        "ISSUE_CREATED",
        "ISSUE_UPDATED",
        "AGENT_RUN_STARTED",
        "AGENT_RUN_STEP",
        "AGENT_RUN_STALLED",
        "AGENT_RUN_COMPLETED",
        "AGENT_RUN_CLEARED",
      ],
    },
  );

  const blockingError = agentsQuery.error ?? pipelineQuery.error ?? workspaceQuery.error;
  if (blockingError) {
    return (
      <EmptyState
        variant="card"
        icon={<AlertTriangle />}
        title="Agent runroom is unavailable"
        description={blockingError.message}
        action={
          <Button
            variant="outline"
            onClick={() => {
              void agentsQuery.refetch();
              void pipelineQuery.refetch();
              void workspaceQuery.refetch();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        }
      />
    );
  }

  if (!agents || !pipeline || !workspace) {
    return (
      <div className="space-y-4">
        <SkeletonList rows={5} />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <EmptyState
        variant="card"
        icon={<Bot />}
        title="No agents yet."
        description="Add agents in Settings -> Agents to start dispatching work."
      />
    );
  }

  const warnMinutes = workspace.agentHeartbeatWarnMinutes ?? 5;
  const criticalMinutes = workspace.agentHeartbeatCriticalMinutes ?? 30;
  const lanesByAgent = new Map(pipeline.lanes.map((lane) => [lane.agent.id, lane]));
  const dispatchByAgent = new Map((dispatch?.perAgent ?? []).map((row) => [row.agentId, row]));
  const failedWindow = recentFailedRuns(failedRuns ?? []);
  const noAckEvents = (timeline?.events ?? []).filter((event) => event.kind === "AGENT_NOACK");

  const onlineAgents = agents.filter((agent) => agent.status !== "OFFLINE").length;
  const load = pipeline.lanes.reduce((sum, lane) => sum + lane.counts.load, 0);
  const queuedIssues = [
    ...pipeline.pool.ready,
    ...pipeline.pool.blocked,
    ...pipeline.lanes.flatMap((lane) => lane.assigned),
  ];
  const activeCount = activeRuns?.length ?? load;
  const runtimeOnline = (runtimes ?? []).filter(
    (runtime) => runtime.health.kind === "online",
  ).length;
  const missedWakes = noAckEvents.length;
  const healthScore = Math.max(
    0,
    Math.round(
      ((onlineAgents / Math.max(agents.length, 1)) * 0.55 +
        (runtimeOnline / Math.max(runtimes?.length ?? 1, 1)) * 0.25 +
        (missedWakes === 0 ? 0.2 : 0)) *
        100,
    ),
  );

  return (
    <div className="space-y-4">
      <OperatorSummary
        healthScore={healthScore}
        onlineAgents={onlineAgents}
        totalAgents={agents.length}
        queuedIssues={queuedIssues}
        activeRuns={activeCount}
        runtimeOnline={runtimeOnline}
        runtimeTotal={runtimes?.length ?? 0}
        missedWakes={missedWakes}
      />

      <PresenceScan
        agents={agents}
        lanesByAgent={lanesByAgent}
        dispatchByAgent={dispatchByAgent}
        warnMinutes={warnMinutes}
        criticalMinutes={criticalMinutes}
        slug={ws.slug}
        wsKey={ws.key}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(21rem,0.9fr)]">
        <section className="min-w-0 space-y-3">
          <RunroomSectionHeader
            eyebrow="Agent lanes"
            title="Runroom board"
            meta={`${agents.length} agent${agents.length === 1 ? "" : "s"} · ${activeCount} active`}
          />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-4">
            {pipeline.lanes.map((lane) => (
              <AgentLaneCard
                key={lane.agent.id}
                lane={lane}
                agent={agents.find((agent) => agent.id === lane.agent.id) ?? null}
                dispatch={dispatchByAgent.get(lane.agent.id)}
                warnMinutes={warnMinutes}
                criticalMinutes={criticalMinutes}
                slug={ws.slug}
                wsKey={ws.key}
              />
            ))}
          </div>
        </section>

        <aside className="min-w-0 space-y-4">
          <DispatchQueuePanel pipeline={pipeline} slug={ws.slug} wsKey={ws.key} />
          <AttentionQueue
            agents={agents}
            failedRuns={failedWindow}
            noAckEvents={noAckEvents}
            warnMinutes={warnMinutes}
            criticalMinutes={criticalMinutes}
            slug={ws.slug}
          />
        </aside>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <RuntimeTopology
          runtimes={runtimes ?? []}
          globalRuntimes={globalRuntimes ?? []}
          agents={agents}
          slug={ws.slug}
          wsKey={ws.key}
        />
        <ActivityStream events={timeline?.events ?? []} slug={ws.slug} />
      </div>
    </div>
  );
}

function OperatorSummary({
  healthScore,
  onlineAgents,
  totalAgents,
  queuedIssues,
  activeRuns,
  runtimeOnline,
  runtimeTotal,
  missedWakes,
}: {
  healthScore: number;
  onlineAgents: number;
  totalAgents: number;
  queuedIssues: PipelineIssue[];
  activeRuns: number;
  runtimeOnline: number;
  runtimeTotal: number;
  missedWakes: number;
}) {
  const oldestQueued = oldestIssue(queuedIssues);
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-card/40 md:grid-cols-5">
      <SummaryMetric
        icon={<Gauge className="h-3.5 w-3.5" />}
        label="Fleet health"
        value={healthScore}
        suffix="%"
        tone={healthScore >= 80 ? "success" : healthScore >= 55 ? "warning" : "danger"}
        detail={`${onlineAgents}/${totalAgents} reachable`}
      />
      <SummaryMetric
        icon={<Inbox className="h-3.5 w-3.5" />}
        label="Dispatch queue"
        value={queuedIssues.length}
        detail={oldestQueued ? `oldest ${relativeTime(oldestQueued.createdAt)}` : "clear"}
      />
      <SummaryMetric
        icon={<Workflow className="h-3.5 w-3.5" />}
        label="Active runs"
        value={activeRuns}
        detail="across agent lanes"
      />
      <SummaryMetric
        icon={<Server className="h-3.5 w-3.5" />}
        label="Runtime coverage"
        value={`${runtimeOnline}/${runtimeTotal}`}
        tone={runtimeTotal === 0 ? "muted" : runtimeOnline === runtimeTotal ? "success" : "warning"}
        detail={runtimeTotal === 0 ? "none registered" : "healthy runtimes"}
      />
      <SummaryMetric
        icon={<Radio className="h-3.5 w-3.5" />}
        label="Missed wakes"
        value={missedWakes}
        tone={missedWakes > 0 ? "danger" : "success"}
        detail={missedWakes > 0 ? "needs triage" : "none in stream"}
      />
    </div>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
  suffix,
  detail,
  tone = "muted",
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  suffix?: string;
  detail: string;
  tone?: Tone;
}) {
  return (
    <div className="border-b border-border p-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={toneClass(tone)}>{icon}</span>
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className={cn("font-mono text-2xl leading-none", toneClass(tone))}>{value}</span>
        {suffix && <span className="font-mono text-sm text-muted-foreground">{suffix}</span>}
      </div>
      <div className="text-meta mt-1 text-muted-foreground">{detail}</div>
    </div>
  );
}

function PresenceScan({
  agents,
  lanesByAgent,
  dispatchByAgent,
  warnMinutes,
  criticalMinutes,
  slug,
  wsKey,
}: {
  agents: Agent[];
  lanesByAgent: Map<string, PipelineLane>;
  dispatchByAgent: Map<string, DispatchAgent>;
  warnMinutes: number;
  criticalMinutes: number;
  slug: string;
  wsKey: string;
}) {
  return (
    <section className="space-y-2">
      <RunroomSectionHeader eyebrow="Agent presence" title="Fleet scan" />
      <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {agents.map((agent) => {
          const lane = lanesByAgent.get(agent.id);
          const dispatch = dispatchByAgent.get(agent.id);
          const load = lane?.counts.load ?? agent._count.assignedIssues;
          const max = agent.maxConcurrent;
          const severity = heartbeatSeverity({
            lastHeartbeatAt: agent.lastHeartbeatAt,
            runtimeMode: agent.runtimeMode,
            warnMinutes,
            criticalMinutes,
          });
          const runtimeLabel = agent.runtime?.name ?? "unbound";
          return (
            <Link
              key={agent.id}
              href={`/w/${slug}/agents/${agent.profileKey}`}
              className={cn(
                "focus-ring w-[min(84vw,260px)] shrink-0 snap-start rounded-lg border bg-card/40 p-3 hover:bg-subtle/70",
                severity === "critical"
                  ? "border-danger/40 bg-danger/5"
                  : severity === "warn"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <AgentPresenceDot
                  status={agent.status}
                  size="md"
                  lastHeartbeatAt={agent.lastHeartbeatAt}
                />
                <span className="truncate font-mono text-[0.75rem]">@{agent.profileKey}</span>
                <StatusChip status={agent.status} severity={severity} className="ml-auto" />
              </div>
              <div className="text-meta mt-2 flex items-center gap-1.5 text-muted-foreground">
                <span className="truncate">{runtimeLabel}</span>
                <WorkspaceChip label={wsKey} />
              </div>
              <div className="text-meta mt-3 grid grid-cols-3 gap-2">
                <MiniMetric label="load" value={max === 0 ? `${load}` : `${load}/${max}`} />
                <MiniMetric
                  label="TTFA"
                  value={formatDuration(dispatch?.meanTimeToFirstAction, { compact: true })}
                />
                <MiniMetric
                  label="heartbeat"
                  value={agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "never"}
                  tone={
                    severity === "critical" ? "danger" : severity === "warn" ? "warning" : "muted"
                  }
                />
              </div>
              <LoadMeter load={load} max={max} className="mt-2" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function AgentLaneCard({
  lane,
  agent,
  dispatch,
  warnMinutes,
  criticalMinutes,
  slug,
  wsKey,
}: {
  lane: PipelineLane;
  agent: Agent | null;
  dispatch?: DispatchAgent;
  warnMinutes: number;
  criticalMinutes: number;
  slug: string;
  wsKey: string;
}) {
  const severity = heartbeatSeverity({
    lastHeartbeatAt: lane.agent.lastHeartbeatAt,
    runtimeMode: agent?.runtimeMode ?? "PERSISTENT",
    warnMinutes,
    criticalMinutes,
  });
  const load = lane.counts.load;
  const max = lane.agent.maxConcurrent;
  const runtimeName = agent?.runtime?.name ?? "unbound";
  const isDown = lane.agent.status === "OFFLINE" || severity === "critical";
  const heldWork = [...lane.assigned, ...lane.inFlight].slice(0, 2);

  return (
    <article
      className={cn(
        "min-w-0 rounded-lg border bg-card/40 p-3",
        isDown
          ? "border-danger/40 bg-danger/5"
          : severity === "warn"
            ? "border-warning/40 bg-warning/5"
            : "border-border",
      )}
    >
      <header className="flex min-w-0 items-start gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-background">
          <AgentPresenceDot
            status={lane.agent.status}
            size="md"
            lastHeartbeatAt={lane.agent.lastHeartbeatAt}
          />
        </div>
        <div className="min-w-0 flex-1">
          <Link
            href={`/w/${slug}/agents/${lane.agent.profileKey}`}
            className="focus-ring flex min-w-0 items-center gap-1.5 rounded-sm hover:text-ember"
          >
            <span className="truncate font-mono text-[0.8125rem]">@{lane.agent.profileKey}</span>
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Link>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
            <span className="text-meta truncate rounded-sm border border-border bg-background px-1.5 py-0.5 text-muted-foreground">
              {runtimeName}
            </span>
            <WorkspaceChip label={wsKey} />
          </div>
        </div>
        <StatusChip status={lane.agent.status} severity={severity} />
      </header>

      <div className="mt-3 flex items-center gap-2">
        <LoadMeter load={load} max={max} className="flex-1" />
        <span className="text-meta font-mono text-muted-foreground">
          {max === 0 ? `${load}` : `${load}/${max}`}
        </span>
      </div>

      <div className="mt-3 space-y-3">
        <IssueBucket
          label="In-progress issues"
          issues={lane.inFlight}
          slug={slug}
          wsKey={wsKey}
          limit={2}
        />
        <IssueBucket
          label={isDown ? "Held work" : "Waiting"}
          issues={heldWork.length > 0 && isDown ? heldWork : lane.assigned}
          slug={slug}
          wsKey={wsKey}
          limit={3}
          tone={isDown ? "danger" : "muted"}
        />
        <IssueBucket
          label="Done (7d)"
          issues={lane.recentlyDone}
          slug={slug}
          wsKey={wsKey}
          limit={2}
          muted
        />
      </div>

      <div className="mt-3 border-t border-border/70 pt-2">
        <div className="text-meta flex items-center justify-between gap-2 text-muted-foreground">
          <span>Throughput</span>
          <span className="font-mono">
            {dispatch?.throughputLast7d ?? lane.counts.recentlyDone}/7d
          </span>
        </div>
        <div className="mt-1 flex h-5 items-end gap-0.5" aria-hidden>
          {Array.from({ length: 24 }).map((_, i) => {
            const throughput = dispatch?.throughputLast7d ?? lane.counts.recentlyDone;
            const active = i < Math.min(24, Math.max(1, throughput));
            const h = 20 + ((i * 7 + throughput * 5) % 70);
            return (
              <span
                key={i}
                className={cn(
                  "w-1 rounded-sm",
                  isDown ? "bg-danger/50" : "bg-success/50",
                  !active && "bg-muted",
                )}
                style={{ height: active ? `${h}%` : "18%" }}
              />
            );
          })}
        </div>
      </div>
    </article>
  );
}

function DispatchQueuePanel({
  pipeline,
  slug,
  wsKey,
}: {
  pipeline: Pipeline;
  slug: string;
  wsKey: string;
}) {
  const rows = [...pipeline.pool.ready, ...pipeline.pool.blocked].slice(0, 6);
  return (
    <section className="rounded-lg border border-border bg-card/40">
      <RunroomPanelHeader
        icon={<Inbox className="h-3.5 w-3.5" />}
        title="Dispatch queue"
        meta={`${pipeline.pool.ready.length} ready · ${pipeline.pool.blocked.length} blocked`}
      />
      {rows.length === 0 ? (
        <div className="text-meta px-3 pb-3 text-muted-foreground">No unassigned queued work.</div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((issue) => (
            <li key={issue.id}>
              <Link
                href={`/w/${slug}/issues/${issue.id}`}
                className="focus-ring flex min-w-0 items-center gap-2 px-3 py-2 text-[0.75rem] hover:bg-subtle/60"
              >
                <span className="text-id text-muted-foreground">
                  {formatIssueId(wsKey, issue.number)}
                </span>
                {!issue.unblocked && (
                  <span className="rounded-sm bg-danger/10 px-1 text-[0.625rem] font-semibold uppercase tracking-wider text-danger">
                    blocked
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                {issue.project && (
                  <span className="text-meta font-mono text-muted-foreground">
                    {issue.project.key}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AttentionQueue({
  agents,
  failedRuns,
  noAckEvents,
  warnMinutes,
  criticalMinutes,
  slug,
}: {
  agents: Agent[];
  failedRuns: FailedRun[];
  noAckEvents: TimelineEvent[];
  warnMinutes: number;
  criticalMinutes: number;
  slug: string;
}) {
  const agentAlerts = agents
    .map((agent) => ({
      agent,
      severity: heartbeatSeverity({
        lastHeartbeatAt: agent.lastHeartbeatAt,
        runtimeMode: agent.runtimeMode,
        warnMinutes,
        criticalMinutes,
      }),
    }))
    .filter((row) => row.agent.status === "OFFLINE" || row.severity !== "ok");

  const items = [
    ...agentAlerts.map((row) => ({
      id: `agent:${row.agent.id}`,
      tone:
        row.severity === "critical" || row.agent.status === "OFFLINE"
          ? ("danger" as const)
          : ("warning" as const),
      title: row.agent.status === "OFFLINE" ? "No heartbeat" : "Heartbeat lagging",
      detail: `@${row.agent.profileKey}`,
      time: row.agent.lastHeartbeatAt ? relativeTime(row.agent.lastHeartbeatAt) : "never",
      href: `/w/${slug}/agents/${row.agent.profileKey}?health=heartbeat`,
      action: "Open agent",
    })),
    ...failedRuns.slice(0, 4).map((run) => ({
      id: `run:${run.id}`,
      tone: run.status === "STALLED" ? ("warning" as const) : ("danger" as const),
      title: run.status === "STALLED" ? "Stalled run" : "Run abandoned",
      detail: run.issue
        ? `${run.issue.workspace.key}-${run.issue.number} · @${run.agent.profileKey}`
        : `@${run.agent.profileKey}`,
      time: relativeTime(run.lastEventAt),
      href: run.issue
        ? `/w/${slug}/issues/${run.issue.id}`
        : `/w/${slug}/agents/${run.agent.profileKey}`,
      action: run.status === "STALLED" ? "Inspect run" : "Review",
    })),
    ...noAckEvents.slice(0, 3).map((event) => ({
      id: `noack:${event.id}`,
      tone: "warning" as const,
      title: "No ack",
      detail: event.agent?.profileKey ? `@${event.agent.profileKey}` : "agent dispatch",
      time: relativeTime(event.createdAt),
      href: event.agent?.profileKey
        ? `/w/${slug}/agents/${event.agent.profileKey}?health=noack`
        : `/w/${slug}/settings/deliveries`,
      action: "Trace",
    })),
  ].slice(0, 8);

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <RunroomPanelHeader
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        title="Attention queue"
        meta={`${items.length} signal${items.length === 1 ? "" : "s"}`}
      />
      {items.length === 0 ? (
        <div className="text-meta px-3 pb-3 text-muted-foreground">
          No runtime or dispatch incidents.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className="focus-ring flex min-w-0 items-center gap-2 px-3 py-2 text-[0.75rem] hover:bg-subtle/60"
              >
                <AlertTone tone={item.tone} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block font-medium", toneClass(item.tone))}>
                    {item.title}
                  </span>
                  <span className="text-meta block truncate text-muted-foreground">
                    {item.detail}
                  </span>
                </span>
                <span className="text-meta text-muted-foreground">{item.time}</span>
                <span className="rounded-md border border-border bg-background px-2 py-1 text-[0.6875rem] text-muted-foreground">
                  {item.action}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RuntimeTopology({
  runtimes,
  globalRuntimes,
  agents,
  slug,
  wsKey,
}: {
  runtimes: RuntimeRow[];
  globalRuntimes: GlobalRuntime[];
  agents: Agent[];
  slug: string;
  wsKey: string;
}) {
  const globalById = new Map(globalRuntimes.map((runtime) => [runtime.id, runtime]));
  return (
    <section className="rounded-lg border border-border bg-card/40">
      <RunroomPanelHeader
        icon={<GitBranch className="h-3.5 w-3.5" />}
        title="Runtime topology"
        meta={`${runtimes.length} runtime${runtimes.length === 1 ? "" : "s"}`}
      />
      {runtimes.length === 0 ? (
        <div className="text-meta px-3 pb-3 text-muted-foreground">
          No runtime registered for this workspace.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {runtimes.map((runtime) => {
            const global = globalById.get(runtime.id);
            const boundAgents = agents.filter((agent) => agent.runtime?.id === runtime.id);
            const tone = runtime.health.kind === "online" ? "success" : runtime.health.tone;
            return (
              <li key={runtime.id} className="px-3 py-3">
                <div className="flex min-w-0 items-start gap-3">
                  <StatusIcon tone={tone} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Link
                        href={`/w/${slug}/settings/runtimes/${runtime.id}`}
                        className="focus-ring truncate font-medium hover:text-ember"
                      >
                        {runtime.name}
                      </Link>
                      <span className={cn("text-meta", toneClass(tone))}>
                        {runtime.health.label}
                      </span>
                      <span className="text-meta font-mono text-muted-foreground">
                        {runtime.adapterKey}
                      </span>
                    </div>
                    <div className="text-meta mt-1 truncate text-muted-foreground">
                      {runtime.endpoint ?? runtime.health.reason}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {(global?.workspacesInUse ?? [{ key: wsKey }]).map((workspace) => (
                        <WorkspaceChip key={workspace.key} label={workspace.key} />
                      ))}
                      {boundAgents.length === 0 ? (
                        <span className="text-meta text-muted-foreground">no bound agents</span>
                      ) : (
                        boundAgents.map((agent) => (
                          <span
                            key={agent.id}
                            className="text-meta inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5"
                          >
                            <AgentPresenceDot
                              status={agent.status}
                              size="sm"
                              lastHeartbeatAt={agent.lastHeartbeatAt}
                            />
                            <span className="font-mono">@{agent.profileKey}</span>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <Link
                    href={`/w/${slug}/settings/runtimes/${runtime.id}`}
                    className="focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
                    title="Open runtime settings"
                    aria-label={`Open settings for ${runtime.name}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ActivityStream({ events, slug }: { events: TimelineEvent[]; slug: string }) {
  return (
    <section className="rounded-lg border border-border bg-card/40">
      <RunroomPanelHeader
        icon={<Activity className="h-3.5 w-3.5" />}
        title="Activity stream"
        meta="live"
      />
      {events.length === 0 ? (
        <div className="text-meta px-3 pb-3 text-muted-foreground">No agent activity yet.</div>
      ) : (
        <ul className="divide-y divide-border">
          {events.slice(0, 9).map((event) => {
            const issue = event.issue;
            const href = issue
              ? `/w/${slug}/issues/${issue.id}`
              : event.agent
                ? `/w/${slug}/agents/${event.agent.profileKey}`
                : `/w/${slug}/activity`;
            const tone =
              event.kind === "AGENT_NOACK" || event.kind === "ISSUE_STALLED"
                ? "warning"
                : event.kind === "ISSUE_SLA_BREACH"
                  ? "danger"
                  : "muted";
            return (
              <li key={event.id}>
                <Link
                  href={href}
                  className="focus-ring flex min-w-0 items-center gap-2 px-3 py-2 text-[0.75rem] hover:bg-subtle/60"
                >
                  <EventIcon kind={event.kind} tone={tone} />
                  <span className="min-w-0 flex-1">
                    <span className="text-meta block truncate font-mono text-muted-foreground">
                      {event.kind}
                    </span>
                    <span className="block truncate">
                      {issue
                        ? `${issue.workspace.key}-${issue.number} · ${issue.title}`
                        : event.agent
                          ? `@${event.agent.profileKey}`
                          : event.subjectType}
                    </span>
                  </span>
                  <span className="text-meta text-muted-foreground">
                    {relativeTime(event.createdAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function IssueBucket({
  label,
  issues,
  slug,
  wsKey,
  limit,
  muted = false,
  tone = "muted",
}: {
  label: string;
  issues: PipelineIssue[];
  slug: string;
  wsKey: string;
  limit: number;
  muted?: boolean;
  tone?: Tone;
}) {
  const visible = issues.slice(0, limit);
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{issues.length}</span>
      </div>
      {visible.length === 0 ? (
        <div className="text-meta rounded-md border border-dashed border-border px-2 py-1.5 text-muted-foreground">
          -
        </div>
      ) : (
        <ul className="space-y-1">
          {visible.map((issue) => (
            <li key={issue.id}>
              <Link
                href={`/w/${slug}/issues/${issue.id}`}
                className={cn(
                  "focus-ring flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[0.75rem] hover:bg-subtle",
                  muted ? "bg-background/30 text-muted-foreground" : "bg-background/60",
                )}
              >
                <span className={cn("text-id", toneClass(tone))}>
                  {formatIssueId(wsKey, issue.number)}
                </span>
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                {!issue.unblocked && (
                  <span className="rounded-sm bg-danger/10 px-1 text-[0.625rem] font-semibold uppercase tracking-wider text-danger">
                    blocked
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunroomSectionHeader({
  eyebrow,
  title,
  meta,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
}) {
  return (
    <div className="flex min-w-0 items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          {eyebrow}
        </div>
        <h2 className="truncate text-sm font-semibold">{title}</h2>
      </div>
      {meta && <div className="text-meta text-muted-foreground">{meta}</div>}
    </div>
  );
}

function RunroomPanelHeader({
  icon,
  title,
  meta,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-border px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
      {meta && <span className="text-meta text-muted-foreground">{meta}</span>}
    </header>
  );
}

function MiniMetric({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
}) {
  return (
    <div>
      <div className="uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate font-mono", toneClass(tone))}>{value}</div>
    </div>
  );
}

function LoadMeter({ load, max, className }: { load: number; max: number; className?: string }) {
  const unlimited = max === 0;
  const pct = unlimited ? 0 : Math.min(100, (load / Math.max(max, 1)) * 100);
  const overloaded = !unlimited && load >= max;
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-subtle", className)}>
      <div
        className={cn("h-full rounded-full", overloaded ? "bg-warning" : "bg-success")}
        style={{ width: unlimited ? "40%" : `${pct}%` }}
      />
    </div>
  );
}

function StatusChip({
  status,
  severity,
  className,
}: {
  status: Agent["status"];
  severity: HeartbeatSeverity;
  className?: string;
}) {
  const tone: Tone =
    status === "OFFLINE" || severity === "critical"
      ? "danger"
      : severity === "warn" || status === "BUSY"
        ? "warning"
        : "success";
  const label =
    status === "OFFLINE" || severity === "critical"
      ? "offline"
      : severity === "warn"
        ? "lagging"
        : status.toLowerCase();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider",
        chipClass(tone),
        className,
      )}
    >
      {label}
    </span>
  );
}

function WorkspaceChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">
      {label}
    </span>
  );
}

function AlertTone({ tone }: { tone: "warning" | "danger" }) {
  return (
    <span
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-md border",
        tone === "danger"
          ? "border-danger/30 bg-danger/10 text-danger"
          : "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
    </span>
  );
}

function StatusIcon({ tone }: { tone: Tone | string }) {
  const normalized: Tone =
    tone === "danger" || tone === "warning" || tone === "success" ? tone : "muted";
  const Icon =
    normalized === "danger" ? XCircle : normalized === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <span
      className={cn(
        "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border",
        chipClass(normalized),
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function EventIcon({ kind, tone }: { kind: TimelineEvent["kind"]; tone: Tone }) {
  const Icon =
    kind === "AGENT_ASSIGNED"
      ? Workflow
      : kind === "AGENT_STATUS_CHANGED"
        ? Radio
        : kind === "ISSUE_QUEUED"
          ? Inbox
          : kind === "AGENT_NOACK" || kind === "ISSUE_STALLED"
            ? AlertTriangle
            : Clock3;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", toneClass(tone))} />;
}

function heartbeatSeverity(args: {
  lastHeartbeatAt: Date | string | null;
  runtimeMode: "PERSISTENT" | "EPHEMERAL";
  warnMinutes: number;
  criticalMinutes: number;
}): HeartbeatSeverity {
  if (args.runtimeMode !== "PERSISTENT") return "ok";
  if (!args.lastHeartbeatAt) return args.warnMinutes > 0 ? "warn" : "ok";
  const ageMs = Date.now() - new Date(args.lastHeartbeatAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "ok";
  const ageMin = ageMs / 60_000;
  if (args.criticalMinutes > 0 && ageMin >= args.criticalMinutes) return "critical";
  if (args.warnMinutes > 0 && ageMin >= args.warnMinutes) return "warn";
  return "ok";
}

function recentFailedRuns(runs: FailedRun[]): FailedRun[] {
  const cutoff = Date.now() - 24 * 3_600_000;
  return runs.filter((run) => {
    const t = run.finishedAt ?? run.lastEventAt;
    return new Date(t).getTime() >= cutoff;
  });
}

function oldestIssue(issues: PipelineIssue[]): PipelineIssue | null {
  if (issues.length === 0) return null;
  return issues.reduce((oldest, issue) => {
    return new Date(issue.createdAt).getTime() < new Date(oldest.createdAt).getTime()
      ? issue
      : oldest;
  }, issues[0]);
}

function formatDuration(
  ms: number | null | undefined,
  options: { compact?: boolean } = {},
): string {
  if (ms == null) return "-";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return options.compact ? `${h.toFixed(1)}h` : `${h.toFixed(1)} hours`;
  const d = h / 24;
  return options.compact ? `${d.toFixed(1)}d` : `${d.toFixed(1)} days`;
}

function toneClass(tone: Tone | string): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "danger":
      return "text-danger";
    case "ember":
      return "text-ember";
    default:
      return "text-muted-foreground";
  }
}

function chipClass(tone: Tone): string {
  switch (tone) {
    case "success":
      return "border-success/30 bg-success/10 text-success";
    case "warning":
      return "border-warning/30 bg-warning/10 text-warning";
    case "danger":
      return "border-danger/30 bg-danger/10 text-danger";
    case "ember":
      return "border-ember/30 bg-ember/10 text-ember";
    default:
      return "border-border bg-subtle/60 text-muted-foreground";
  }
}
