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
  Cloud,
  ExternalLink,
  Globe,
  HardDrive,
  History,
  Server,
  Settings2,
  UserCheck,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Section, SkeletonList } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import AgentTimeline from "@/components/agents/agent-timeline";
import { AgentContextCard } from "@/components/agents/agent-context-card";
import { RoleChip } from "@/components/crews/role-chip";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
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
          <span className="flex items-center gap-2">
            <Link
              href={`/w/${ws.slug}/agents`}
              className="text-muted-foreground hover:text-foreground"
              title="Back to Agents"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <span>{agent?.name ?? profileKey}</span>
            {agent && (
              <span className="font-mono text-meta text-muted-foreground">
                @{agent.profileKey}
              </span>
            )}
            {agent && (
              <AgentPresenceDot
                status={agent.status}
                size="md"
                pulse
                lastHeartbeatAt={agent.lastHeartbeatAt}
              />
            )}
          </span>
        }
        subtitle={agent?.description ?? "Agent detail."}
        actions={
          agent && (
            <Link href={`/w/${ws.slug}/settings/agents`}>
              <Button variant="ghost" size="sm">
                <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            </Link>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 p-6">
          {!agent ? (
            <SkeletonList rows={6} />
          ) : (
            <>
              <IdentityStrip agent={agent} />
              {healthFocus && (
                <HealthFocusBanner agent={agent} focus={healthFocus} />
              )}
              <StatsRow agentId={agent.id} />
              <UptimeSection agentId={agent.id} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2 space-y-4">
                  <StalledSection agentId={agent.id} slug={ws.slug} wsKey={ws.key} />
                  <CurrentlyWorkingSection agentId={agent.id} />
                </div>
                <div className="space-y-4">
                  <AgentContextCard agentId={agent.id} />
                  <CrewsAndWorkSection agentId={agent.id} slug={ws.slug} />
                  <RuntimeCard agent={agent} />
                  <WebhookHealthCard agentId={agent.id} focus={healthFocus} />
                  <DispatchEligibilityCard agent={agent} focus={healthFocus} />
                </div>
              </div>
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    Recent activity
                  </span>
                }
              >
                <AgentTimeline profileKey={agent.profileKey} />
              </Section>
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

function HealthFocusBanner({
  agent,
  focus,
}: {
  agent: AgentRow;
  focus: AgentHealthFocus;
}) {
  const ws = useWorkspace();
  const copy =
    focus === "noack"
      ? {
          title: "Missed ack investigation",
          reason:
            "Forge expected a comment or status transition after dispatch, but the ack window expired.",
          fix:
            "Check heartbeat freshness and failed webhook deliveries below, then retry the delivery or reassign the issue if the runner is unavailable.",
        }
      : focus === "webhook"
        ? {
            title: "Webhook delivery health",
            reason:
              "Agent dispatches travel through durable webhook deliveries before the runner receives work.",
            fix:
              "Open a failed or dead-letter delivery, inspect the response, fix the endpoint or secret, then retry.",
          }
        : {
            title: "Heartbeat freshness",
            reason:
              "Heartbeat and successful dispatch deliveries are the signals Forge uses to trust this agent is reachable.",
            fix:
              "Restart the runner or verify it can receive webhooks and call the heartbeat endpoint.",
          };
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-[0.75rem]">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        <span className="font-semibold text-foreground">{copy.title}</span>
        <span className="font-mono text-meta text-muted-foreground">
          @{agent.profileKey}
        </span>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <HealthCallout label="Reason" value={copy.reason} />
        <HealthCallout
          label="Recommended fix"
          value={copy.fix}
          className="md:col-span-2"
        />
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
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card p-4">
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-subtle text-lg">
        {agent.avatar ?? <Bot className="h-5 w-5 text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{agent.name}</span>
          <span className="font-mono text-meta text-muted-foreground">
            @{agent.profileKey}
          </span>
          <Badge>{PROVIDER_LABELS[agent.provider] ?? agent.provider}</Badge>
          <Badge>
            {agent.runtimeMode === "PERSISTENT" ? "persistent" : "single-session"}
          </Badge>
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
      <div className="flex items-center gap-4 text-meta text-muted-foreground">
        <span>
          max concurrent{" "}
          <span className="font-mono text-foreground">
            {agent.maxConcurrent === 0 ? "∞" : agent.maxConcurrent}
          </span>
        </span>
        {agent.webhookUrl ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="rounded-sm bg-success/10 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-success">
              push
            </span>
            <span className="font-mono">{truncateUrl(agent.webhookUrl)}</span>
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
      <Stat
        label="Uptime (7d)"
        value={uptime ? `${uptime.uptimePct}%` : "—"}
      />
      <Stat label="Assignments (30d)" value={me?.assignments ?? "—"} />
      <Stat
        label="Mean TTFA"
        value={formatDuration(me?.meanTimeToFirstAction)}
      />
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
    if (at > cursor)
      segments.push({ from: cursor, to: at, status: cursorStatus });
    cursorStatus = (t.status as AgentStatus | null) ?? cursorStatus;
    cursor = at;
  }
  if (end > cursor)
    segments.push({ from: cursor, to: end, status: cursorStatus });

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
        <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
          <LegendDot color={STATUS_FILL.ONLINE} label="Online" />
          <LegendDot color={STATUS_FILL.BUSY} label="Busy" />
          <LegendDot color={STATUS_FILL.OFFLINE} label="Offline" />
          <span className="ml-auto">
            online {formatDuration(data.onlineMs)} · busy{" "}
            {formatDuration(data.busyMs)} · offline{" "}
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
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------

/**
 * Per-agent Stalled bucket. Two flavours surfaced together:
 *
 *  - **Stalled runs (5m+)** — `AgentRun` rows still ACTIVE but quiet
 *    past the shared `STALE_RUN_MS` threshold. Each row carries a
 *    `Kick` button that re-fires the dispatch webhook for the issue
 *    via `agentRun.kick` — assignment isn't changed; the agent is
 *    just nudged.
 *  - **Stalled issues (Nd+)** — issues currently assigned to this
 *    agent past `Workspace.stalledThresholdDays`. No kick affordance:
 *    long stalls usually mean a design / dependency wait, not a runtime
 *    glitch.
 *
 * If an issue appears in both buckets we tag the issue row with "(also
 * stalled run)" so the operator doesn't read the same incident twice
 * without context. The stalled-run row stays primary because it has
 * the kick affordance.
 *
 * Hidden entirely when both lists are empty — no clutter on healthy
 * agents.
 */
function StalledSection({
  agentId,
  slug,
  wsKey,
}: {
  agentId: string;
  slug: string;
  wsKey: string;
}) {
  const { data, isLoading } = trpc.agent.stalled.useQuery({ agentId });

  if (isLoading || !data) return null;
  const { stalledRuns, stalledIssues, stalledThresholdDays } = data;
  if (stalledRuns.length === 0 && stalledIssues.length === 0) return null;

  // Build the set of issue ids that already appear as a stalled run so
  // the issue list can flag overlap rather than duplicate the line.
  const runIssueIds = new Set(stalledRuns.map((r) => r.issueId));

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          Stalled
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {stalledRuns.length + stalledIssues.length} total
          </span>
        </span>
      }
    >
      <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
        {stalledRuns.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-2 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
              <span>Stalled runs (5m+)</span>
              <span className="font-mono">{stalledRuns.length}</span>
            </div>
            <ul className="space-y-1">
              {stalledRuns.map((r) => (
                <StalledRunRow
                  key={r.id}
                  run={r}
                  slug={slug}
                  wsKey={wsKey}
                />
              ))}
            </ul>
          </div>
        )}
        {stalledIssues.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-2 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
              <span>
                Stalled issues
                {stalledThresholdDays > 0
                  ? ` (${stalledThresholdDays}d+)`
                  : ""}
              </span>
              <span className="font-mono">{stalledIssues.length}</span>
            </div>
            <ul className="space-y-1">
              {stalledIssues.map((i) => {
                const alsoRun = runIssueIds.has(i.id);
                return (
                  <li key={i.id}>
                    <Link
                      href={`/w/${slug}/issues/${i.id}`}
                      className="focus-ring flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[0.75rem] hover:bg-subtle"
                      title={
                        alsoRun
                          ? "Also has a stalled run — see the run row above for the Kick action."
                          : `Quiet since ${relativeTime(i.updatedAt)}`
                      }
                    >
                      <span className="text-id text-muted-foreground">
                        {formatIssueId(wsKey, i.number)}
                      </span>
                      <span className="flex-1 truncate">{i.title}</span>
                      {alsoRun && (
                        <span className="rounded-sm bg-warning/15 px-1 text-[0.625rem] font-medium uppercase tracking-wider text-warning">
                          also stalled run
                        </span>
                      )}
                      {i.project && (
                        <span className="font-mono text-meta text-muted-foreground">
                          {i.project.key}
                        </span>
                      )}
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: i.status.color }}
                        title={i.status.name}
                      />
                      <span className="text-meta text-warning">
                        {relativeTime(i.updatedAt)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

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

  const recentlyKicked =
    kickedAt !== null && Date.now() - kickedAt < 30_000;

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
          <span className="font-mono text-meta text-muted-foreground">
            {run.issue.project.key}
          </span>
        )}
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: run.issue.status.color }}
          title={run.issue.status.name}
        />
        <span className="text-meta text-warning">
          quiet {relativeTime(run.lastEventAt)}
        </span>
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
            Currently working on
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
          Currently working on
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {lane.counts.load} active · {lane.counts.recentlyDone} done (7d)
          </span>
        </span>
      }
    >
      <div className="space-y-3">
        <Bucket
          label="In flight"
          issues={lane.inFlight}
          slug={ws.slug}
          wsKey={ws.key}
        />
        <Bucket
          label="Assigned"
          issues={lane.assigned}
          slug={ws.slug}
          wsKey={ws.key}
        />
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
        <div className="rounded-md border border-dashed border-border px-2 py-1.5 text-meta text-muted-foreground">
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
                  <span className="font-mono text-meta text-muted-foreground">
                    {i.project.key}
                  </span>
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
  const total =
    totals.success + totals.failed + totals.deadLetter + totals.pending || 0;
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
          "space-y-2 p-3 scroll-mt-20",
          (focus === "noack" || focus === "webhook") &&
            "border-warning/40 bg-warning/5",
        )}
      >
        {data.configuredWebhookUrl ? (
          <div className="truncate font-mono text-meta text-muted-foreground">
            {data.configuredWebhookUrl}
          </div>
        ) : (
          <div className="text-meta text-muted-foreground">
            No webhook URL configured.
          </div>
        )}
        {total === 0 ? (
          <div className="text-meta text-muted-foreground">
            No deliveries in window.
          </div>
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
          <div className="space-y-1 rounded-md border border-border bg-background/40 p-2 text-meta text-muted-foreground">
            <div className="font-medium text-foreground">
              {hasDeliveryConcern
                ? "Delivery failures are blocking dispatch."
                : data.configuredWebhookUrl
                  ? "This is the dispatch trail to inspect."
                  : "No push endpoint is configured."}
            </div>
            <div>
              Reason: assignments and mentions reach this agent through the
              synthetic dispatch webhook; failed or dead-letter rows mean the
              runner may not have received the work.
            </div>
            <div>
              Recommended fix: inspect the latest failed row, repair the
              endpoint or secret, then retry the dead-letter delivery.
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
                    className="focus-ring flex items-center gap-2 rounded-sm py-1 text-meta hover:bg-subtle/60"
                    title="Open delivery details"
                  >
                    <DeliveryStatusDot status={r.status} />
                    <span className="font-mono text-muted-foreground">
                      {r.event.kind}
                    </span>
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
      <div className="text-[0.6875rem] uppercase tracking-wider opacity-80">
        {label}
      </div>
    </div>
  );
}

function DeliveryStatusDot({
  status,
}: {
  status: DeliveryStatus;
}) {
  const color =
    status === "SUCCESS"
      ? "bg-success"
      : status === "PENDING"
        ? "bg-warning"
        : status === "FAILED"
          ? "bg-warning"
          : "bg-danger";
  return (
    <span
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", color)}
      title={status}
    />
  );
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
function CrewsAndWorkSection({
  agentId,
  slug,
}: {
  agentId: string;
  slug: string;
}) {
  const { data } = trpc.agent.crewsAndWork.useQuery({ id: agentId });

  if (!data) return <SectionShell title="Crews & live work" small />;

  const { crews, activeSteps } = data;
  const isEmpty = crews.length === 0 && activeSteps.length === 0;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          Crews &amp; live work
        </span>
      }
    >
      <Card className="space-y-3 p-3 text-[0.75rem]">
        {isEmpty ? (
          <div className="text-meta text-muted-foreground">
            Not on any crew yet.
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                Crews
              </div>
              {crews.length === 0 ? (
                <div className="text-meta text-muted-foreground">
                  Not on any crew.
                </div>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {crews.map((c) => (
                    <li key={c.crewId}>
                      <Link
                        href={`/w/${slug}/crews/${c.crewId}`}
                        className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 hover:bg-subtle"
                      >
                        <span className="truncate font-medium text-foreground">
                          {c.crewName}
                        </span>
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
                <div className="text-meta text-muted-foreground">
                  Nothing in flight.
                </div>
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

function RuntimeCard({ agent }: { agent: AgentRow }) {
  const ws = useWorkspace();
  const runtime = agent.runtime;
  if (!runtime) return null;

  const KindIcon =
    runtime.kind === "LOCAL_DAEMON"
      ? HardDrive
      : runtime.kind === "REMOTE_HTTP"
        ? Globe
        : runtime.kind === "CLOUD"
          ? Cloud
          : Server;
  const kindLabel =
    runtime.kind === "LOCAL_DAEMON"
      ? "local daemon"
      : runtime.kind === "REMOTE_HTTP"
        ? "remote webhook"
        : "cloud";

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Server className="h-3.5 w-3.5 text-muted-foreground" />
          Runtime
        </span>
      }
    >
      <Card className="space-y-2 p-3 text-[0.75rem]">
        <Link
          href={`/w/${ws.slug}/settings/runtimes/${runtime.id}`}
          className="focus-ring flex items-start gap-2 rounded-md hover:text-ember"
        >
          <KindIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">
              {runtime.name}
            </span>
            <span className="block text-meta text-muted-foreground">
              {kindLabel}
            </span>
          </span>
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Link>
        <div className="flex items-baseline justify-between gap-3 text-meta text-muted-foreground">
          <span>Heartbeat</span>
          <span className="text-right text-foreground/80">
            {runtime.heartbeatAt
              ? `${relativeTime(runtime.heartbeatAt)} ago`
              : "—"}
          </span>
        </div>
        {runtime.providersAvailable.length > 0 && (
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-meta text-muted-foreground">
            <span>Providers</span>
            <span className="flex flex-wrap justify-end gap-1">
              {runtime.providersAvailable.map((p) => (
                <span
                  key={p}
                  className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                >
                  {p}
                </span>
              ))}
            </span>
          </div>
        )}
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
  const shouldExplainHeartbeat =
    focus === "heartbeat" ||
    focus === "noack" ||
    agent.status === "OFFLINE" ||
    !agent.lastHeartbeatAt;

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
        <Row label="Status">
          <span className="inline-flex items-center gap-1.5">
            <AgentPresenceDot status={agent.status} size="sm" />
            <span className="capitalize">{agent.status.toLowerCase()}</span>
          </span>
        </Row>
        <Row label="Load">
          <span
            className={cn(
              "font-mono",
              atCap ? "text-warning" : "text-foreground",
            )}
          >
            {load}/{cap === 0 ? "∞" : cap}
          </span>
        </Row>
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
        <Row label="Last heartbeat">
          <span className="text-muted-foreground">
            {agent.lastHeartbeatAt
              ? relativeTime(agent.lastHeartbeatAt)
              : "never"}
          </span>
        </Row>
        <Row label="Last dispatched">
          <span className="text-muted-foreground">
            {agent.lastDispatchedAt
              ? relativeTime(agent.lastDispatchedAt)
              : "never"}
          </span>
        </Row>
        {shouldExplainHeartbeat && (
          <div className="rounded-md border border-border bg-background/40 p-2 text-meta text-muted-foreground">
            <div className="font-medium text-foreground">
              Heartbeat context
            </div>
            <div>
              Reason: Forge uses successful webhook delivery and explicit
              heartbeat calls as reachability signals for dispatch.
            </div>
            <div>
              Recommended fix: confirm the runner is online, can receive
              dispatch webhooks, and is calling the heartbeat endpoint.
            </div>
          </div>
        )}
      </Card>
    </Section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionShell({
  title,
  small = false,
}: {
  title: string;
  small?: boolean;
}) {
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
