"use client";
import { useState } from "react";
import Link from "next/link";
import { notFound, useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { AgentStatus } from "@prisma/client";
import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronLeft,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Globe,
  HardDrive,
  History,
  Inbox,
  Loader2,
  Radio,
  Server,
  Settings2,
  ShieldAlert,
  UserCheck,
  Users,
  Workflow,
  XCircle,
  Zap,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Section, SkeletonList } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import AgentTimeline from "@/components/agents/agent-timeline";
import { AgentContextCard } from "@/components/agents/agent-context-card";
import { TransportChip } from "@/components/agents/transport-chip";
import { RoleChip } from "@/components/crews/role-chip";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { runtimeDisplayIdentity } from "@/lib/transport-display";
import type { AppRouter } from "@/server/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/**
 * Per-agent detail page. URL is `/w/:slug/agents/:profileKey` so the
 * link is human-readable (e.g. `/w/AXI/agents/victor`).
 *
 * Composes five tRPC calls:
 *   1. agent.byProfileKey       — identity + capabilities + maxConcurrent
 *   2. agent.uptime             — windowed status math + transitions ribbon
 *   3. agent.webhookHealth      — dispatch shim delivery counts
 *   4. agent.timeline           — chronological feed filtered to this agent
 *   5. agent.pipeline           — pluck this agent's lane for "currently working"
 *   6. analytics.dispatch.summary — assignments / TTFA / throughput card
 *
 * Each query refetches on the relevant realtime kind so the page stays
 * live without a manual refresh.
 */
export default function AgentDetailPage() {
  const ws = useWorkspace();
  const params = useParams<{ profileKey: string }>();
  const searchParams = useSearchParams();
  const profileKey = params?.profileKey ?? "";
  const healthFocus = parseHealthFocus(searchParams.get("health"));

  const utils = trpc.useUtils();
  useRealtime(
    () => {
      utils.agent.byProfileKey.invalidate();
      utils.agent.uptime.invalidate();
      utils.agent.webhookHealth.invalidate();
      utils.agent.unifiedTimeline.invalidate();
      utils.agent.pipeline.invalidate();
      utils.agent.stalled.invalidate();
      utils.agent.crewsAndWork.invalidate();
      utils.analytics.dispatch.summary.invalidate();
    },
    {
      kind: [
        "AGENT_STATUS_CHANGED",
        "AGENT_ASSIGNED",
        "AGENT_UPDATED",
        "ISSUE_STATUS_CHANGED",
        "ISSUE_QUEUED",
        "COMMENT_CREATED",
        "AGENT_RUN_STARTED",
        "AGENT_RUN_STEP",
        "AGENT_RUN_BLOCKED",
        "AGENT_RUN_COMPLETED",
        "AGENT_RUN_STALLED",
        "AGENT_RUN_KICKED",
        "AGENT_RUN_CONTROL_REQUESTED",
      ],
    },
  );

  const { data: agent, isLoading } = trpc.agent.byProfileKey.useQuery(
    { profileKey },
    { enabled: !!profileKey },
  );

  if (!isLoading && !agent) notFound();

  return (
    <>
      <Topbar
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              href={`/w/${ws.slug}/agents`}
              className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground sm:min-h-0 sm:min-w-0 sm:justify-start sm:hover:bg-transparent"
              title="Back to Agents"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <span className="min-w-0 truncate">{agent?.name ?? profileKey}</span>
            {agent && (
              <span className="text-meta font-mono text-muted-foreground">@{agent.profileKey}</span>
            )}
            {agent &&
              (agent.availability === "on-demand" ? (
                <span
                  className="inline-flex items-center gap-1 text-[0.6875rem] text-sky-600 dark:text-sky-400"
                  title="Reached on demand — connects when work is sent. Not heartbeat-tracked."
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                  on-demand
                </span>
              ) : (
                <AgentPresenceDot
                  status={agent.status}
                  size="md"
                  pulse
                  lastHeartbeatAt={agent.lastHeartbeatAt}
                />
              ))}
          </span>
        }
        subtitle={agent?.description ?? "Agent detail."}
        actions={
          agent && (
            <Link href={`/w/${ws.slug}/settings/agents`}>
              <Button variant="ghost" size="sm" className="min-h-9">
                <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            </Link>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
          {!agent ? (
            <SkeletonList rows={6} />
          ) : (
            <>
              <IdentityStrip agent={agent} />
              {healthFocus && <HealthFocusBanner agent={agent} focus={healthFocus} />}
              <AgentIncidentBanner agent={agent} slug={ws.slug} wsKey={ws.key} />
              <HealthChain agent={agent} />
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(20rem,0.8fr)]">
                <div className="min-w-0 space-y-4">
                  <HeldWorkSection agent={agent} slug={ws.slug} wsKey={ws.key} />
                  <CurrentlyWorkingSection agentId={agent.id} />
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <AgentContextCard agentId={agent.id} agentName={agent.name} />
                    <CrewsAndWorkSection agentId={agent.id} slug={ws.slug} />
                  </div>
                  <Section
                    title={
                      <span className="flex items-center gap-2">
                        <History className="h-3.5 w-3.5 text-muted-foreground" />
                        Recent events
                      </span>
                    }
                  >
                    <AgentTimeline profileKey={agent.profileKey} />
                  </Section>
                </div>
                <aside className="min-w-0 space-y-4">
                  <StatsRow agentId={agent.id} />
                  <UptimeSection agentId={agent.id} />
                  <ConnectionCard agent={agent} />
                  {/* Webhook trail only matters for webhook-dispatched agents.
                      Hide it for an on-demand managed-runtime agent (Codex app
                      server etc.) with no webhook, where it's always "N/A". */}
                  {(agent.webhookUrl || healthFocus === "webhook" || healthFocus === "noack") && (
                    <WebhookHealthCard agentId={agent.id} focus={healthFocus} />
                  )}
                  <DispatchEligibilityCard agent={agent} focus={healthFocus} />
                  <PromptConfigCard agent={agent} />
                </aside>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

type AgentRow = NonNullable<RouterOutputs["agent"]["byProfileKey"]>;
type AgentHealthFocus = "noack" | "webhook" | "heartbeat";
type DeliveryStatus = "PENDING" | "SUCCESS" | "FAILED" | "DEAD_LETTER";

const PROVIDER_LABELS: Record<string, string> = {
  HERMES: "Hermes",
  CLAUDE: "Claude",
  CODEX: "Codex",
  CUSTOM: "Custom",
};

function parseHealthFocus(value: string | null): AgentHealthFocus | null {
  if (value === "noack" || value === "webhook" || value === "heartbeat") {
    return value;
  }
  return null;
}

function HealthFocusBanner({ agent, focus }: { agent: AgentRow; focus: AgentHealthFocus }) {
  const ws = useWorkspace();
  const copy =
    focus === "noack"
      ? {
          title: "Missed ack investigation",
          reason:
            "Forge expected a comment or status transition after dispatch, but the ack window expired.",
          fix: "Check heartbeat freshness and failed webhook deliveries below, then retry the delivery or reassign the issue if the runner is unavailable.",
        }
      : focus === "webhook"
        ? {
            title: "Webhook delivery health",
            reason:
              "Agent dispatches travel through durable webhook deliveries before the runner receives work.",
            fix: "Open a failed or dead-letter delivery, inspect the response, fix the endpoint or secret, then retry.",
          }
        : {
            title: "Heartbeat freshness",
            reason:
              "Heartbeat and successful dispatch deliveries are the signals Forge uses to trust this agent is reachable.",
            fix: "Restart the runner or verify it can receive webhooks and call the heartbeat endpoint.",
          };
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-[0.75rem]">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        <span className="font-semibold text-foreground">{copy.title}</span>
        <span className="text-meta font-mono text-muted-foreground">@{agent.profileKey}</span>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <HealthCallout label="Reason" value={copy.reason} />
        <HealthCallout label="Recommended fix" value={copy.fix} className="md:col-span-2" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          href={`/w/${ws.slug}/settings/deliveries?status=DEAD_LETTER&agentId=${encodeURIComponent(agent.id)}`}
          className="focus-ring inline-flex items-center gap-1 rounded-sm text-foreground hover:text-ember"
        >
          Open dead letters
          <ExternalLink className="h-3 w-3" />
        </Link>
        <Link
          href={`/w/${ws.slug}/settings/deliveries?status=FAILED&agentId=${encodeURIComponent(agent.id)}`}
          className="focus-ring inline-flex items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground"
        >
          Open failed deliveries
          <ExternalLink className="h-3 w-3" />
        </Link>
        <span className="text-muted-foreground">
          Place to check: webhook health and dispatch eligibility below.
        </span>
      </div>
    </div>
  );
}

function HealthCallout({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-border bg-card/40 p-2", className)}>
      <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-muted-foreground">{value}</div>
    </div>
  );
}

function IdentityStrip({ agent }: { agent: AgentRow }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card/40 p-4 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-border bg-background text-lg">
        {agent.avatar ?? <Bot className="h-5 w-5 text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold">{agent.name}</span>
          <span className="text-meta font-mono text-muted-foreground">@{agent.profileKey}</span>
          <Badge>{PROVIDER_LABELS[agent.provider] ?? agent.provider}</Badge>
          <Badge>{agent.runtimeMode === "PERSISTENT" ? "persistent" : "single-session"}</Badge>
        </div>
        {agent.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.map((c) => (
              <Badge key={c} className="bg-subtle text-foreground">
                {c}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className="text-meta flex min-w-0 flex-wrap items-center gap-3 text-muted-foreground sm:gap-4">
        <span>
          max concurrent{" "}
          <span className="font-mono text-foreground">
            {agent.maxConcurrent === 0 ? "∞" : agent.maxConcurrent}
          </span>
        </span>
        {agent.webhookUrl ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="rounded-sm bg-success/10 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-success">
              push
            </span>
            <span className="truncate font-mono">{truncateUrl(agent.webhookUrl)}</span>
          </span>
        ) : (
          <span className="rounded-sm bg-subtle px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            pull-only
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AgentIncidentBanner({
  agent,
  slug,
  wsKey,
}: {
  agent: AgentRow;
  slug: string;
  wsKey: string;
}) {
  const utils = trpc.useUtils();
  const { data: stalled } = trpc.agent.stalled.useQuery({ agentId: agent.id });
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const verify = trpc.agent.verifyConnection.useMutation({
    onSuccess: (r) => {
      if (r.probe.attempted && r.probe.reachable === false) {
        toast.error(`Runtime unreachable: ${r.probe.detail}`);
      } else if (r.ready) {
        toast.success(`Connection ready · ${r.transportLabel}`);
      } else {
        toast.message("Not ready — check runtime and dispatch settings.");
      }
      void utils.agent.byProfileKey.invalidate({ profileKey: agent.profileKey });
    },
    onError: (e) => toast.error(e.message),
  });

  const lane = pipeline?.lanes.find((l) => l.agent.id === agent.id);
  const heldIssueIds = new Set<string>();
  for (const run of stalled?.stalledRuns ?? []) heldIssueIds.add(run.issueId);
  for (const issue of stalled?.stalledIssues ?? []) heldIssueIds.add(issue.id);
  if (agent.status === "OFFLINE") {
    for (const issue of [...(lane?.inFlight ?? []), ...(lane?.assigned ?? [])]) {
      heldIssueIds.add(issue.id);
    }
  }
  const heldCount = heldIssueIds.size;
  const offline = agent.status === "OFFLINE";
  const runtimeDisabled = Boolean(agent.runtime?.disabledAt);
  const transportBlocked = agent.transport.ready === false;
  const incident = offline || runtimeDisabled || transportBlocked || heldCount > 0;
  const primaryIssue = lane?.inFlight[0] ?? lane?.assigned[0] ?? null;

  return (
    <section
      className={cn(
        "rounded-lg border p-4",
        incident ? "border-danger/30 bg-danger/5" : "border-success/30 bg-success/5",
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {incident ? (
              <AlertTriangle className="h-4 w-4 text-danger" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-success" />
            )}
            <h2 className="text-sm font-semibold">
              {incident
                ? `${agent.name} needs operator attention`
                : `${agent.name} is ready for dispatch`}
            </h2>
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider",
                incident ? "bg-danger/10 text-danger" : "bg-success/10 text-success",
              )}
            >
              {incident ? "attention" : "ready"}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-[0.75rem] text-muted-foreground">
            {incident
              ? [
                  offline ? "Agent presence is offline." : null,
                  runtimeDisabled ? "Attached runtime is disabled." : null,
                  transportBlocked ? "No ready transport is available." : null,
                  heldCount > 0
                    ? `Holding ${heldCount} assignment${heldCount === 1 ? "" : "s"}.`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" ")
              : "Heartbeat, transport, capacity, and dispatch posture are clear based on the current workspace data."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={incident ? "default" : "outline"}
              className="h-8"
              disabled={verify.isPending}
              onClick={() => verify.mutate({ id: agent.id })}
            >
              {verify.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Radio className="mr-1.5 h-3.5 w-3.5" />
              )}
              Verify connection
            </Button>
            {primaryIssue && (
              <Link href={`/w/${slug}/issues/${primaryIssue.id}`}>
                <Button type="button" size="sm" variant="outline" className="h-8">
                  <Inbox className="mr-1.5 h-3.5 w-3.5" />
                  Open {formatIssueId(wsKey, primaryIssue.number)}
                </Button>
              </Link>
            )}
            {agent.runtime && (
              <Link href={`/w/${slug}/settings/runtimes/${agent.runtime.id}`}>
                <Button type="button" size="sm" variant="outline" className="h-8">
                  <Server className="mr-1.5 h-3.5 w-3.5" />
                  Open runtime
                </Button>
              </Link>
            )}
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-3 text-[0.75rem] sm:grid-cols-4 lg:w-[28rem]">
          <IncidentMetric label="status" value={agent.status.toLowerCase()} danger={offline} />
          <IncidentMetric label="held" value={heldCount} danger={heldCount > 0 && incident} />
          <IncidentMetric
            label="heartbeat"
            value={agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "never"}
            danger={offline || !agent.lastHeartbeatAt}
          />
          <IncidentMetric
            label="transport"
            value={agent.transport.label}
            danger={transportBlocked}
          />
        </div>
      </div>
    </section>
  );
}

function IncidentMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-background/50 p-2">
      <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 truncate font-mono", danger ? "text-danger" : "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

function HealthChain({ agent }: { agent: AgentRow }) {
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const { data: webhook } = trpc.agent.webhookHealth.useQuery({
    id: agent.id,
    windowDays: 7,
  });
  const lane = pipeline?.lanes.find((l) => l.agent.id === agent.id);
  const load = lane?.counts.load ?? 0;
  const cap = agent.maxConcurrent;
  const atCap = cap > 0 && load >= cap;
  const onDemand = agent.availability === "on-demand";
  const heartbeatOk = onDemand || (agent.status !== "OFFLINE" && Boolean(agent.lastHeartbeatAt));
  const runtimeOk = agent.runtime ? !agent.runtime.disabledAt : agent.transport.mode !== "runs";
  const webhookOk =
    agent.transport.mode !== "dispatch" ||
    Boolean(agent.webhookUrl) ||
    Boolean(webhook && webhook.totals.deadLetter === 0 && webhook.totals.failed === 0);
  const dispatchOk = heartbeatOk && runtimeOk && agent.transport.ready && !atCap;
  const deadLetters = webhook?.totals.deadLetter ?? 0;

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <div className="grid grid-cols-2 divide-x-0 divide-y divide-border sm:grid-cols-3 lg:grid-cols-6 lg:divide-x lg:divide-y-0">
        <HealthStep
          label="Heartbeat"
          value={heartbeatOk ? (onDemand ? "on-demand" : "healthy") : "missing"}
          ok={heartbeatOk}
          warn={!heartbeatOk && agent.status !== "OFFLINE"}
        />
        <HealthStep
          label="Runtime"
          value={
            agent.runtime
              ? agent.runtime.disabledAt
                ? "disabled"
                : agent.runtime.name
              : "not attached"
          }
          ok={runtimeOk}
          warn={!agent.runtime && agent.transport.mode !== "runs"}
        />
        <HealthStep
          label="Transport"
          value={agent.transport.label}
          ok={agent.transport.ready && webhookOk}
          warn={!webhookOk}
        />
        <HealthStep label="Dispatch" value={dispatchOk ? "eligible" : "blocked"} ok={dispatchOk} />
        <HealthStep
          label="Load"
          value={cap === 0 ? `${load}/∞` : `${load}/${cap}`}
          ok={!atCap}
          warn={atCap}
        />
        <HealthStep label="Dead letters" value={deadLetters} ok={deadLetters === 0} />
      </div>
    </section>
  );
}

function HealthStep({
  label,
  value,
  ok,
  warn = false,
}: {
  label: string;
  value: React.ReactNode;
  ok: boolean;
  warn?: boolean;
}) {
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : XCircle;
  return (
    <div className="flex min-w-0 items-center gap-2 p-3">
      <span
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-full border",
          ok
            ? "border-success/30 bg-success/10 text-success"
            : warn
              ? "border-warning/30 bg-warning/10 text-warning"
              : "border-danger/30 bg-danger/10 text-danger",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="block truncate text-[0.75rem]">{value}</span>
      </span>
    </div>
  );
}

function HeldWorkSection({ agent, slug, wsKey }: { agent: AgentRow; slug: string; wsKey: string }) {
  const { data, isLoading } = trpc.agent.stalled.useQuery({ agentId: agent.id });
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const lane = pipeline?.lanes.find((l) => l.agent.id === agent.id);
  const heldByPresence =
    agent.status === "OFFLINE" ? [...(lane?.inFlight ?? []), ...(lane?.assigned ?? [])] : [];

  if (isLoading || !data) return <SectionShell title="Held work" />;

  const { stalledRuns, stalledIssues, stalledThresholdDays } = data;
  const runIssueIds = new Set(stalledRuns.map((r) => r.issueId));
  const quietAssigned = heldByPresence.filter(
    (issue) =>
      !runIssueIds.has(issue.id) && !stalledIssues.some((stalled) => stalled.id === issue.id),
  );
  const total = stalledRuns.length + stalledIssues.length + quietAssigned.length;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert
            className={cn("h-3.5 w-3.5", total > 0 ? "text-warning" : "text-muted-foreground")}
          />
          Held work
          <span className="font-mono text-[0.6875rem] text-muted-foreground">{total}</span>
        </span>
      }
      hint="Assignments that are stalled, quiet, or held behind this agent's current presence."
    >
      {total === 0 ? (
        <div className="text-meta rounded-lg border border-border bg-card/40 p-3 text-muted-foreground">
          No held work. Current assignments are moving or waiting normally.
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
          {stalledRuns.length > 0 && (
            <HeldBucket label="Stalled runs" count={stalledRuns.length}>
              {stalledRuns.map((r) => (
                <StalledRunRow key={r.id} run={r} slug={slug} wsKey={wsKey} />
              ))}
            </HeldBucket>
          )}
          {stalledIssues.length > 0 && (
            <HeldBucket
              label={`Stalled issues${stalledThresholdDays > 0 ? ` (${stalledThresholdDays}d+)` : ""}`}
              count={stalledIssues.length}
            >
              {stalledIssues.map((issue) => (
                <li key={issue.id}>
                  <Link
                    href={`/w/${slug}/issues/${issue.id}`}
                    className="focus-ring flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[0.75rem] hover:bg-subtle"
                  >
                    <span className="text-id text-muted-foreground">
                      {formatIssueId(wsKey, issue.number)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                    {issue.project && (
                      <span className="text-meta font-mono text-muted-foreground">
                        {issue.project.key}
                      </span>
                    )}
                    <span className="text-meta text-warning">{relativeTime(issue.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </HeldBucket>
          )}
          {quietAssigned.length > 0 && (
            <HeldBucket label="Held by presence" count={quietAssigned.length}>
              {quietAssigned.slice(0, 8).map((issue) => (
                <li key={issue.id}>
                  <Link
                    href={`/w/${slug}/issues/${issue.id}`}
                    className="focus-ring flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[0.75rem] hover:bg-subtle"
                  >
                    <span className="text-id text-muted-foreground">
                      {formatIssueId(wsKey, issue.number)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                    <span className="rounded-sm bg-danger/10 px-1 text-[0.625rem] font-semibold uppercase tracking-wider text-danger">
                      offline
                    </span>
                  </Link>
                </li>
              ))}
            </HeldBucket>
          )}
        </div>
      )}
    </Section>
  );
}

function HeldBucket({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{count}</span>
      </div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatsRow({ agentId }: { agentId: string }) {
  const { data: dispatch } = trpc.analytics.dispatch.summary.useQuery({
    agentId,
  });
  const { data: uptime } = trpc.agent.uptime.useQuery({
    id: agentId,
    windowDays: 7,
  });
  const me = dispatch?.perAgent.find((p) => p.agentId === agentId);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Uptime (7d)" value={uptime ? `${uptime.uptimePct}%` : "—"} />
      <Stat label="Assignments (30d)" value={me?.assignments ?? "—"} />
      <Stat label="Mean TTFA" value={formatDuration(me?.meanTimeToFirstAction)} />
      <Stat label="Throughput (7d)" value={me?.throughputLast7d ?? "—"} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-lg">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const STATUS_FILL: Record<AgentStatus, string> = {
  ONLINE: "var(--success)",
  BUSY: "var(--warning)",
  OFFLINE: "var(--muted-foreground)",
};

function UptimeSection({ agentId }: { agentId: string }) {
  const { data } = trpc.agent.uptime.useQuery({
    id: agentId,
    windowDays: 7,
  });
  if (!data) {
    return <SectionShell title="Status (last 7d)" />;
  }

  // Build segments for the ribbon: walk transitions chronologically and
  // compute (start_pct, width_pct, status) for each segment.
  const start = new Date(data.windowStart).getTime();
  const end = new Date(data.windowEnd).getTime();
  const span = Math.max(end - start, 1);

  type Segment = { from: number; to: number; status: AgentStatus };
  const segments: Segment[] = [];
  let cursor = start;
  let cursorStatus: AgentStatus =
    (data.transitions[0]?.status as AgentStatus | null) ?? data.currentStatus;

  // Walk: each transition closes the prior segment and opens a new one.
  for (const t of data.transitions) {
    const at = new Date(t.at).getTime();
    if (at > cursor) segments.push({ from: cursor, to: at, status: cursorStatus });
    cursorStatus = (t.status as AgentStatus | null) ?? cursorStatus;
    cursor = at;
  }
  if (end > cursor) segments.push({ from: cursor, to: end, status: cursorStatus });

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          Status (last 7d)
        </span>
      }
      hint={`Currently ${data.currentStatus.toLowerCase()} since ${relativeTime(
        data.currentSince,
      )}`}
    >
      <div className="space-y-2 rounded-lg border border-border bg-card p-3">
        <div className="relative flex h-3 w-full overflow-hidden rounded-md bg-subtle">
          {segments.map((seg, i) => (
            <span
              key={i}
              className="block h-full"
              style={{
                width: `${((seg.to - seg.from) / span) * 100}%`,
                background: STATUS_FILL[seg.status],
              }}
              title={`${seg.status} · ${relativeTime(new Date(seg.from))} → ${relativeTime(new Date(seg.to))}`}
            />
          ))}
        </div>
        <div className="text-meta flex flex-wrap items-center gap-3 text-muted-foreground">
          <LegendDot color={STATUS_FILL.ONLINE} label="Online" />
          <LegendDot color={STATUS_FILL.BUSY} label="Busy" />
          <LegendDot color={STATUS_FILL.OFFLINE} label="Offline" />
          <span className="ml-auto">
            online {formatDuration(data.onlineMs)} · busy {formatDuration(data.busyMs)} · offline{" "}
            {formatDuration(data.offlineMs)}
          </span>
        </div>
      </div>
    </Section>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------

type StalledRunRowProps = {
  run: NonNullable<RouterOutputs["agent"]["stalled"]>["stalledRuns"][number];
  slug: string;
  wsKey: string;
};

function StalledRunRow({ run, slug, wsKey }: StalledRunRowProps) {
  const utils = trpc.useUtils();
  // Optimistic 30s "kicked just now" hint — clears either when the
  // realtime layer refreshes or the timer expires, whichever first.
  const [kickedAt, setKickedAt] = useState<number | null>(null);
  const kickM = trpc.agentRun.kick.useMutation({
    onSuccess: (res) => {
      if (res.kicked) {
        toast.success("Run kicked. Watching for the agent to ack…");
        setKickedAt(Date.now());
        setTimeout(() => setKickedAt(null), 30_000);
      } else {
        toast.message("Run already moving — kick skipped.");
      }
      void utils.agent.stalled.invalidate();
      void utils.agentRun.activeAll.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const recentlyKicked = kickedAt !== null && Date.now() - kickedAt < 30_000;

  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[0.75rem]">
      <Link
        href={`/w/${slug}/issues/${run.issue.id}`}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2 hover:bg-subtle"
        title={
          run.currentStep
            ? `Last step: ${run.currentStep}`
            : `No status comment yet. Last event ${relativeTime(run.lastEventAt)}.`
        }
      >
        <span className="text-id text-muted-foreground">
          {formatIssueId(wsKey, run.issue.number)}
        </span>
        <span className="flex-1 truncate">{run.issue.title}</span>
        {run.issue.project && (
          <span className="text-meta font-mono text-muted-foreground">{run.issue.project.key}</span>
        )}
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: run.issue.status.color }}
          title={run.issue.status.name}
        />
        <span className="text-meta text-warning">quiet {relativeTime(run.lastEventAt)}</span>
      </Link>
      {recentlyKicked ? (
        <span
          className="rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-[0.6875rem] font-medium text-success"
          title="Kick delivered — waiting for the agent to ack."
        >
          kicked
        </span>
      ) : (
        <button
          type="button"
          onClick={() => kickM.mutate({ runId: run.id })}
          disabled={kickM.isPending}
          title="Re-dispatch to wake the agent. Doesn't change assignment."
          className="focus-ring inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[0.6875rem] text-foreground/80 hover:border-ember/40 hover:text-foreground disabled:opacity-50"
        >
          <Zap className="h-3 w-3" />
          Kick
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

function CurrentlyWorkingSection({ agentId }: { agentId: string }) {
  const ws = useWorkspace();
  const { data } = trpc.agent.pipeline.useQuery({});
  const lane = data?.lanes.find((l) => l.agent.id === agentId);

  if (!data) return <SectionShell title="Currently working on" />;
  if (!lane) {
    return (
      <Section
        title={
          <span className="flex items-center gap-2">
            <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
            Now
          </span>
        }
      >
        <EmptyState
          variant="card"
          icon={<Workflow />}
          title="Nothing in flight."
          description="No issues currently assigned to this agent."
        />
      </Section>
    );
  }

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
          Now
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {lane.counts.load} active · {lane.counts.recentlyDone} done (7d)
          </span>
        </span>
      }
    >
      <div className="space-y-3">
        <Bucket label="In flight" issues={lane.inFlight} slug={ws.slug} wsKey={ws.key} />
        <Bucket label="Assigned" issues={lane.assigned} slug={ws.slug} wsKey={ws.key} />
        <Bucket
          label="Recently done (7d)"
          issues={lane.recentlyDone}
          slug={ws.slug}
          wsKey={ws.key}
          muted
        />
      </div>
    </Section>
  );
}

type LaneIssue = {
  id: string;
  number: number;
  title: string;
  status: { name: string; category: string; color: string };
  project: { id: string; key: string; color: string | null } | null;
  unblocked: boolean;
  _count: { comments: number };
};

function Bucket({
  label,
  issues,
  slug,
  wsKey,
  muted = false,
}: {
  label: string;
  issues: LaneIssue[];
  slug: string;
  wsKey: string;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{issues.length}</span>
      </div>
      {issues.length === 0 ? (
        <div className="text-meta rounded-md border border-dashed border-border px-2 py-1.5 text-muted-foreground">
          —
        </div>
      ) : (
        <ul className="space-y-1">
          {issues.map((i) => (
            <li key={i.id}>
              <Link
                href={`/w/${slug}/issues/${i.id}`}
                className={cn(
                  "focus-ring flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[0.75rem] hover:bg-subtle",
                  muted ? "bg-card/40" : "bg-card",
                )}
              >
                <span className="text-id text-muted-foreground">
                  {formatIssueId(wsKey, i.number)}
                </span>
                {!i.unblocked && (
                  <span className="rounded-sm bg-danger/10 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-danger">
                    blocked
                  </span>
                )}
                <span className="flex-1 truncate">{i.title}</span>
                {i.project && (
                  <span className="text-meta font-mono text-muted-foreground">{i.project.key}</span>
                )}
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: i.status.color }}
                  title={i.status.name}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function WebhookHealthCard({
  agentId,
  focus,
}: {
  agentId: string;
  focus: AgentHealthFocus | null;
}) {
  const ws = useWorkspace();
  const { data } = trpc.agent.webhookHealth.useQuery({
    id: agentId,
    windowDays: 7,
  });

  if (!data) return <SectionShell title="Webhook health" small />;

  const { totals } = data;
  const total = totals.success + totals.failed + totals.deadLetter + totals.pending || 0;
  const hasDeliveryConcern = totals.failed > 0 || totals.deadLetter > 0;
  const deadLetterHref = deliveryInspectorHref(ws.slug, {
    status: "DEAD_LETTER",
    agentId,
  });
  const failedHref = deliveryInspectorHref(ws.slug, {
    status: "FAILED",
    agentId,
  });

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-muted-foreground" />
          Webhook health (7d)
        </span>
      }
    >
      <Card
        id="dispatch-health"
        className={cn(
          "scroll-mt-20 space-y-2 p-3",
          (focus === "noack" || focus === "webhook") && "border-warning/40 bg-warning/5",
        )}
      >
        {data.configuredWebhookUrl ? (
          <div className="text-meta truncate font-mono text-muted-foreground">
            {data.configuredWebhookUrl}
          </div>
        ) : (
          <div className="text-meta text-muted-foreground">No webhook URL configured.</div>
        )}
        {total === 0 ? (
          <div className="text-meta text-muted-foreground">No deliveries in window.</div>
        ) : (
          <div className="grid grid-cols-4 gap-2 text-[0.75rem]">
            <Pill tone="ok" label="ok" value={totals.success} />
            <Pill tone="warn" label="pend" value={totals.pending} />
            <Pill tone="warn" label="fail" value={totals.failed} />
            <Pill tone="danger" label="dlq" value={totals.deadLetter} />
          </div>
        )}
        {(focus === "noack" ||
          focus === "webhook" ||
          hasDeliveryConcern ||
          !data.configuredWebhookUrl) && (
          <div className="text-meta space-y-1 rounded-md border border-border bg-background/40 p-2 text-muted-foreground">
            <div className="font-medium text-foreground">
              {hasDeliveryConcern
                ? "Delivery failures are blocking dispatch."
                : data.configuredWebhookUrl
                  ? "This is the dispatch trail to inspect."
                  : "No push endpoint is configured."}
            </div>
            <div>
              Reason: assignments and mentions reach this agent through the synthetic dispatch
              webhook; failed or dead-letter rows mean the runner may not have received the work.
            </div>
            <div>
              Recommended fix: inspect the latest failed row, repair the endpoint or secret, then
              retry the dead-letter delivery.
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href={deadLetterHref}
                className="focus-ring inline-flex items-center gap-1 text-foreground hover:text-ember"
              >
                Dead letters
                <ExternalLink className="h-3 w-3" />
              </Link>
              <Link
                href={failedHref}
                className="focus-ring inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                Failed deliveries
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        )}
        {data.recent.length > 0 && (
          <ul className="divide-y divide-border pt-1">
            {data.recent.slice(0, 6).map((r) => {
              const href = deliveryInspectorHref(ws.slug, {
                status: r.status,
                deliveryId: r.id,
                agentId,
              });
              return (
                <li key={r.id}>
                  <Link
                    href={href}
                    className="focus-ring text-meta flex items-center gap-2 rounded-sm py-1 hover:bg-subtle/60"
                    title="Open delivery details"
                  >
                    <DeliveryStatusDot status={r.status} />
                    <span className="font-mono text-muted-foreground">{r.event.kind}</span>
                    <span className="ml-auto text-right text-muted-foreground">
                      {r.responseStatus ? `${r.responseStatus} · ` : ""}
                      {relativeTime(r.deliveredAt ?? r.scheduledAt)}
                    </span>
                    <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Section>
  );
}

function Pill({
  tone,
  label,
  value,
}: {
  tone: "ok" | "warn" | "danger";
  label: string;
  value: number;
}) {
  const cls =
    tone === "ok"
      ? "bg-success/10 text-success"
      : tone === "warn"
        ? "bg-warning/10 text-warning"
        : "bg-danger/10 text-danger";
  return (
    <div className={cn("rounded-md px-2 py-1 text-center", cls)}>
      <div className="font-mono text-sm">{value}</div>
      <div className="text-[0.6875rem] uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}

function DeliveryStatusDot({ status }: { status: DeliveryStatus }) {
  const color =
    status === "SUCCESS"
      ? "bg-success"
      : status === "PENDING"
        ? "bg-warning"
        : status === "FAILED"
          ? "bg-warning"
          : "bg-danger";
  return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", color)} title={status} />;
}

// ---------------------------------------------------------------------------

/**
 * "Crews & live work" — the cross-link out of the agent detail page into
 * the orchestration side. Two stacked lists: the crews this agent sits on
 * (chips → `/crews/<id>`, role via RoleChip) and the execution steps it's
 * actively running right now (→ the step's goal, or its plan as a
 * fallback). Quiet single-line empty state when there's nothing on
 * either side.
 */
function CrewsAndWorkSection({ agentId, slug }: { agentId: string; slug: string }) {
  const { data } = trpc.agent.crewsAndWork.useQuery({ id: agentId });

  if (!data) return <SectionShell title="Crews & live work" small />;

  const { crews, activeSteps } = data;
  const isEmpty = crews.length === 0 && activeSteps.length === 0;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          Crews &amp; live steps
        </span>
      }
    >
      <Card className="space-y-3 p-3 text-[0.75rem]">
        {isEmpty ? (
          <div className="text-meta text-muted-foreground">Not on any crew yet.</div>
        ) : (
          <>
            <div className="space-y-1.5">
              <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                Crews
              </div>
              {crews.length === 0 ? (
                <div className="text-meta text-muted-foreground">Not on any crew.</div>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {crews.map((c) => (
                    <li key={c.crewId}>
                      <Link
                        href={`/w/${slug}/crews/${c.crewId}`}
                        className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 hover:bg-subtle"
                      >
                        <span className="truncate font-medium text-foreground">{c.crewName}</span>
                        <RoleChip role={c.role} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                Working on now
              </div>
              {activeSteps.length === 0 ? (
                <div className="text-meta text-muted-foreground">Nothing in flight.</div>
              ) : (
                <ul className="space-y-1">
                  {activeSteps.map((s) => (
                    <li key={s.stepId}>
                      <Link
                        href={
                          s.plan.goalId
                            ? `/w/${slug}/goals/${s.plan.goalId}`
                            : `/w/${slug}/plans/${s.plan.id}`
                        }
                        className="focus-ring flex items-center gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 hover:bg-subtle"
                        title={s.plan.title}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember motion-safe:animate-pulse" />
                        <span className="flex-1 truncate">{s.title}</span>
                        <span className="text-meta uppercase tracking-wider text-muted-foreground">
                          {s.status.toLowerCase()}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </Card>
    </Section>
  );
}

function ConnectionCard({ agent }: { agent: AgentRow }) {
  const ws = useWorkspace();
  const runtime = agent.runtime;
  const transport = agent.transport;
  const [verifyResult, setVerifyResult] = useState<{
    ready: boolean;
    transportLabel: string;
    probe: { attempted: boolean; reachable: boolean | null; detail: string };
  } | null>(null);
  const verify = trpc.agent.verifyConnection.useMutation({
    onSuccess: (r) => {
      setVerifyResult(r);
      if (r.probe.attempted && r.probe.reachable === false) {
        toast.error(`Runtime unreachable: ${r.probe.detail}`);
      } else if (r.ready) {
        toast.success(`Chat ready · ${r.transportLabel}`);
      } else {
        toast.message("Not chat-ready — see details.");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const KindIcon =
    runtime?.kind === "LOCAL_DAEMON"
      ? HardDrive
      : runtime?.kind === "REMOTE_HTTP"
        ? Globe
        : runtime?.kind === "CLOUD"
          ? Cloud
          : Server;
  const runtimeIdentity = runtimeDisplayIdentity({
    adapterKey: runtime?.adapterKey,
    kind: runtime?.kind,
  });
  const disabled = Boolean(runtime?.disabledAt);

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Server className="h-3.5 w-3.5 text-muted-foreground" />
          Connections &amp; execution
        </span>
      }
      hint="Concrete endpoints acting as this profile; identity stays stable across clients."
    >
      <Card className="space-y-3 p-3 text-[0.75rem]">
        {/* Resolved chat path is useful even before a durable endpoint has
            registered (legacy clients appear below as unidentified). */}
        <div className="flex flex-wrap items-center gap-2">
          {transport && <TransportChip mode={transport.mode} label={transport.label} showNone />}
          {disabled && (
            <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
              runtime disabled
            </span>
          )}
        </div>

        {agent.connections.length > 0 ? (
          <>
            <ul className="space-y-2" aria-label="Registered execution connections">
              {agent.connections.map((connection) => (
                <AgentConnectionRow key={connection.id} connection={connection} />
              ))}
            </ul>
            {agent._count.connections > agent.connections.length && (
              <div className="text-meta text-muted-foreground">
                Showing the 25 most recently seen of {agent._count.connections} registered
                connections. Older revoked and disconnected records remain in the audit trail.
              </div>
            )}
          </>
        ) : runtime ? (
          <Link
            href={`/w/${ws.slug}/settings/runtimes/${runtime.id}`}
            className="focus-ring flex items-start gap-2 rounded-md border border-border bg-background/40 p-2 hover:text-ember"
          >
            <KindIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">{runtime.name}</span>
              <span className="text-meta block text-muted-foreground">
                {runtimeIdentity.runtimeLabel} · {runtimeIdentity.transportLabel}
              </span>
            </span>
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Link>
        ) : (
          <div className="rounded-md border border-dashed border-border/70 bg-background/30 p-2">
            <div className="font-medium text-foreground">No registered client instances</div>
            <div className="text-meta mt-0.5 text-muted-foreground">
              {transport?.mode === "completions"
                ? "Chat is available on demand; the first execution will register its endpoint."
                : transport?.mode === "dispatch"
                  ? "Legacy dispatch is configured, but this endpoint has not registered durable provenance yet."
                  : "Attach a runtime or connect an MCP client to register an execution endpoint."}
            </div>
          </div>
        )}

        {/* Runtime heartbeat only matters for heartbeat-tracked runtimes. */}
        {runtime && agent.availability === "heartbeat" && (
          <ReadinessRow label="Runtime heartbeat">
            {runtime.heartbeatAt ? `${relativeTime(runtime.heartbeatAt)} ago` : "—"}
          </ReadinessRow>
        )}
        <ReadinessRow label="Transport">{agent.transport.label}</ReadinessRow>
        <ReadinessRow label="Dispatch ready">
          <span className={agent.transport.ready ? "text-success" : "text-danger"}>
            {agent.transport.ready ? "Yes" : "No"}
          </span>
        </ReadinessRow>

        {/* Verify connection — readiness + (runs) endpoint probe. */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[0.6875rem]"
            disabled={verify.isPending}
            onClick={() => verify.mutate({ id: agent.id })}
          >
            {verify.isPending ? "Verifying…" : "Verify connection"}
          </Button>
          {verifyResult && (
            <span
              className={cn(
                "text-[0.6875rem]",
                verifyResult.ready ? "text-success" : "text-amber-700 dark:text-amber-300",
              )}
              title={verifyResult.probe.detail || undefined}
            >
              {verifyResult.ready ? "ready" : "not ready"}
              {verifyResult.probe.attempted
                ? ` · ${verifyResult.probe.reachable ? "reachable" : "unreachable"}`
                : ""}
            </span>
          )}
        </div>
      </Card>
    </Section>
  );
}

type AgentConnectionRowData = AgentRow["connections"][number];

const CONNECTION_KIND_LABEL: Record<AgentConnectionRowData["kind"], string> = {
  MANAGED_RUNTIME: "Runtime",
  MCP_CLIENT: "MCP",
  WEBHOOK: "Webhook",
  ON_DEMAND: "On-demand",
};

function AgentConnectionRow({ connection }: { connection: AgentConnectionRowData }) {
  const name =
    connection.displayName ??
    connection.clientName ??
    connection.runtime?.name ??
    CONNECTION_KIND_LABEL[connection.kind];
  const kind = CONNECTION_KIND_LABEL[connection.kind];
  const confirmedActive = connection.status === "ACTIVE" && connection.confidence === "CONFIRMED";
  const unconfirmedQuiet = connection.status === "QUIET" && connection.confidence === "UNCONFIRMED";
  const statusLabel = unconfirmedQuiet
    ? "Quiet · status unconfirmed"
    : connection.status === "ACTIVE"
      ? connection.confidence === "CONFIRMED"
        ? "Confirmed active"
        : "Activity inferred"
      : connection.status.toLowerCase();
  const statusTone =
    connection.status === "REVOKED" || connection.status === "DISCONNECTED"
      ? "text-danger"
      : unconfirmedQuiet
        ? "text-warning"
        : confirmedActive
          ? "text-success"
          : "text-muted-foreground";
  const lastSignal = connection.lastSeenAt ?? connection.connectedAt ?? connection.firstSeenAt;

  return (
    <li className="rounded-md border border-border bg-background/40 p-2">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
            confirmedActive
              ? "bg-success motion-safe:animate-pulse"
              : unconfirmedQuiet
                ? "bg-warning"
                : "bg-muted-foreground/50",
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-foreground">{name}</span>
            <span className="rounded border border-border/70 bg-subtle/60 px-1 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {kind}
            </span>
            {connection.clientVersion && (
              <span className="text-meta font-mono text-muted-foreground">
                v{connection.clientVersion}
              </span>
            )}
          </div>
          <div className={cn("text-meta mt-0.5", statusTone)}>{statusLabel}</div>
          <div className="text-meta mt-0.5 text-muted-foreground">
            {connection.livenessModel.toLowerCase().replaceAll("_", " ")} · seen{" "}
            {relativeTime(lastSignal)} · {connection._count.runs} live run
            {connection._count.runs === 1 ? "" : "s"} · {connection._count.ownedSessions}{" "}
            {connection._count.ownedSessions === 1 ? "delivery" : "deliveries"}
          </div>
        </div>
      </div>
      {connection.kind === "MCP_CLIENT" && connection.confidence !== "CONFIRMED" && (
        <div className="text-meta mt-2 border-t border-border/60 pt-2 text-muted-foreground">
          MCP activity proves recent access, not that the client process is still running.
        </div>
      )}
    </li>
  );
}

function ReadinessRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-meta flex items-baseline justify-between gap-3 text-muted-foreground">
      <span>{label}</span>
      <span className="min-w-0 truncate text-right text-foreground/80">{children}</span>
    </div>
  );
}

function PromptConfigCard({ agent }: { agent: AgentRow }) {
  const template = agent.templateMarkdown ?? "";
  const effectiveSystemPrompt =
    `You are ${agent.name}. You're chatting with the operator inside Forge, a project ` +
    `management workspace. Be concise and direct. ` +
    (agent.capabilities.length > 0
      ? `Your capabilities: ${agent.capabilities.join(", ")}.\n\n`
      : "") +
    (template ? `${template}\n` : "");

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          Prompt &amp; config
        </span>
      }
    >
      <Card className="space-y-3 p-3 text-[0.75rem]">
        <ReadinessRow label="Provider">{agent.provider}</ReadinessRow>
        <ReadinessRow label="Engine">
          <span title={`resolved from ${agent.resolvedEngine.source}`}>
            {agent.resolvedEngine.engine === "RUNS" ? "Runs" : "Streaming"}
            <span className="ml-1 text-muted-foreground">· {agent.resolvedEngine.source}</span>
          </span>
        </ReadinessRow>
        <ReadinessRow label="Runtime mode">
          {agent.runtimeMode.toLowerCase().replace("_", " ")}
        </ReadinessRow>
        <div>
          <div className="text-meta text-muted-foreground">Template markdown</div>
          {template ? (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-2 font-mono text-[0.6875rem] leading-relaxed">
              {template}
            </pre>
          ) : (
            <div className="text-meta mt-1 rounded-md border border-dashed border-border/70 bg-background/40 p-2 text-muted-foreground">
              No binding-level template configured.
            </div>
          )}
        </div>
        <div>
          <div className="text-meta text-muted-foreground">Effective chat system prompt</div>
          <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground/85">
            {effectiveSystemPrompt}
          </pre>
        </div>
      </Card>
    </Section>
  );
}

function DispatchEligibilityCard({
  agent,
  focus,
}: {
  agent: AgentRow;
  focus: AgentHealthFocus | null;
}) {
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const lane = pipeline?.lanes.find((l) => l.agent.id === agent.id);
  const load = lane?.counts.load ?? 0;
  const cap = agent.maxConcurrent;
  const atCap = cap > 0 && load >= cap;
  const onDemand = agent.availability === "on-demand";
  const heartbeatOk = onDemand || (agent.status !== "OFFLINE" && Boolean(agent.lastHeartbeatAt));
  const runtimeOk = !agent.runtime?.disabledAt;
  const webhookOk = agent.transport.ready;
  const eligible = heartbeatOk && runtimeOk && webhookOk && !atCap;
  // On-demand agents (managed app server, completions, dispatch) aren't
  // heartbeat-tracked, so don't nag about a stale/absent heartbeat.
  const shouldExplainHeartbeat =
    !onDemand &&
    (focus === "heartbeat" ||
      focus === "noack" ||
      agent.status === "OFFLINE" ||
      !agent.lastHeartbeatAt);

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
          Dispatch eligibility
        </span>
      }
    >
      <Card
        className={cn(
          "space-y-2 p-3 text-[0.75rem]",
          shouldExplainHeartbeat && "border-warning/30 bg-warning/5",
        )}
      >
        <ChecklistRow
          ok={heartbeatOk}
          label="Heartbeat reachable"
          value={
            onDemand
              ? "on-demand"
              : agent.lastHeartbeatAt
                ? `${relativeTime(agent.lastHeartbeatAt)} ago`
                : "never"
          }
        />
        <ChecklistRow
          ok={runtimeOk}
          label="Runtime available"
          value={agent.runtime?.disabledAt ? "disabled" : (agent.runtime?.name ?? "not required")}
        />
        <ChecklistRow ok={webhookOk} label="Transport ready" value={agent.transport.label} />
        <ChecklistRow
          ok={!atCap}
          label="Load under cap"
          value={`${load}/${cap === 0 ? "∞" : cap}`}
        />
        <Row label="Capabilities">
          <span className="flex flex-wrap justify-end gap-1">
            {agent.capabilities.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              agent.capabilities.map((c) => (
                <Badge key={c} className="bg-subtle text-foreground">
                  {c}
                </Badge>
              ))
            )}
          </span>
        </Row>
        <Row label="Last dispatched">
          <span className="text-muted-foreground">
            {agent.lastDispatchedAt ? relativeTime(agent.lastDispatchedAt) : "never"}
          </span>
        </Row>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <span className="font-medium">Eligible</span>
          <span className={cn("font-mono", eligible ? "text-success" : "text-danger")}>
            {eligible ? "Yes" : "No"}
          </span>
        </div>
        {shouldExplainHeartbeat && (
          <div className="text-meta rounded-md border border-border bg-background/40 p-2 text-muted-foreground">
            <div className="font-medium text-foreground">Heartbeat context</div>
            <div>
              Reason: Forge uses successful webhook delivery and explicit heartbeat calls as
              reachability signals for dispatch.
            </div>
            <div>
              Recommended fix: confirm the runner is online, can receive dispatch webhooks, and is
              calling the heartbeat endpoint.
            </div>
          </div>
        )}
      </Card>
    </Section>
  );
}

function ChecklistRow({
  ok,
  label,
  value,
}: {
  ok: boolean;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
      )}
      <span className="min-w-0 flex-1 text-muted-foreground">{label}</span>
      <span className="min-w-0 max-w-[55%] truncate text-right">{value}</span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionShell({ title, small = false }: { title: string; small?: boolean }) {
  return (
    <Section title={title}>
      <div className="rounded-lg border border-border bg-card p-3">
        <SkeletonList rows={small ? 2 : 4} />
      </div>
    </Section>
  );
}

function truncateUrl(url: string, max = 48): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function deliveryInspectorHref(
  slug: string,
  input: {
    status: DeliveryStatus;
    deliveryId?: string;
    agentId?: string;
  },
): string {
  const params = new URLSearchParams({ status: input.status });
  if (input.deliveryId) params.set("deliveryId", input.deliveryId);
  if (input.agentId) params.set("agentId", input.agentId);
  return `/w/${slug}/settings/deliveries?${params.toString()}`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = h / 24;
  return `${d.toFixed(1)}d`;
}
