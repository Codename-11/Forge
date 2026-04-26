"use client";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import type { AgentStatus } from "@prisma/client";
import {
  Activity,
  ArrowRightLeft,
  Bot,
  ChevronLeft,
  History,
  Inbox,
  MessageCircle,
  Settings2,
  UserCheck,
  Workflow,
  Zap,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Section, SkeletonList } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
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
  const profileKey = params?.profileKey ?? "";

  const utils = trpc.useUtils();
  useRealtime(
    () => {
      utils.agent.byProfileKey.invalidate();
      utils.agent.uptime.invalidate();
      utils.agent.webhookHealth.invalidate();
      utils.agent.timeline.invalidate();
      utils.agent.pipeline.invalidate();
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
              <StatsRow agentId={agent.id} />
              <UptimeSection agentId={agent.id} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2 space-y-4">
                  <CurrentlyWorkingSection agentId={agent.id} />
                </div>
                <div className="space-y-4">
                  <WebhookHealthCard agentId={agent.id} />
                  <DispatchEligibilityCard agent={agent} />
                </div>
              </div>
              <ActivitySection agentId={agent.id} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

type AgentRow = NonNullable<RouterOutputs["agent"]["byProfileKey"]>;

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
            <span className="rounded-sm bg-success/10 px-1 text-[10px] font-semibold uppercase tracking-wider text-success">
              push
            </span>
            <span className="font-mono">{truncateUrl(agent.webhookUrl)}</span>
          </span>
        ) : (
          <span className="rounded-sm bg-subtle px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
          <span className="font-mono text-[10px] text-muted-foreground">
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
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
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
                  "focus-ring flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px] hover:bg-subtle",
                  muted ? "bg-card/40" : "bg-card",
                )}
              >
                <span className="text-id text-muted-foreground">
                  {formatIssueId(wsKey, i.number)}
                </span>
                {!i.unblocked && (
                  <span className="rounded-sm bg-danger/10 px-1 text-[9px] font-semibold uppercase tracking-wider text-danger">
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

function WebhookHealthCard({ agentId }: { agentId: string }) {
  const { data } = trpc.agent.webhookHealth.useQuery({
    id: agentId,
    windowDays: 7,
  });

  if (!data) return <SectionShell title="Webhook health" small />;

  const { totals } = data;
  const total =
    totals.success + totals.failed + totals.deadLetter + totals.pending || 0;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-muted-foreground" />
          Webhook health (7d)
        </span>
      }
    >
      <Card className="space-y-2 p-3">
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
          <div className="grid grid-cols-4 gap-2 text-[12px]">
            <Pill tone="ok" label="ok" value={totals.success} />
            <Pill tone="warn" label="pend" value={totals.pending} />
            <Pill tone="warn" label="fail" value={totals.failed} />
            <Pill tone="danger" label="dlq" value={totals.deadLetter} />
          </div>
        )}
        {data.recent.length > 0 && (
          <ul className="divide-y divide-border pt-1">
            {data.recent.slice(0, 6).map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 py-1 text-meta"
              >
                <DeliveryStatusDot status={r.status} />
                <span className="font-mono text-muted-foreground">
                  {r.event.kind}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {r.responseStatus ? `${r.responseStatus} · ` : ""}
                  {relativeTime(r.deliveredAt ?? r.scheduledAt)}
                </span>
              </li>
            ))}
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
      <div className="text-[10px] uppercase tracking-wider opacity-80">
        {label}
      </div>
    </div>
  );
}

function DeliveryStatusDot({
  status,
}: {
  status: "PENDING" | "SUCCESS" | "FAILED" | "DEAD_LETTER";
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

function DispatchEligibilityCard({ agent }: { agent: AgentRow }) {
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const lane = pipeline?.lanes.find((l) => l.agent.id === agent.id);
  const load = lane?.counts.load ?? 0;
  const cap = agent.maxConcurrent;
  const atCap = cap > 0 && load >= cap;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
          Dispatch eligibility
        </span>
      }
    >
      <Card className="space-y-2 p-3 text-[12px]">
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

function ActivitySection({ agentId }: { agentId: string }) {
  const ws = useWorkspace();
  const { data } = trpc.agent.timeline.useQuery({ agentId, limit: 30 });

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          Recent activity
        </span>
      }
    >
      {!data ? (
        <SkeletonList rows={4} />
      ) : data.events.length === 0 ? (
        <EmptyState
          variant="card"
          icon={<History />}
          title="No agent activity yet."
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {data.events.map((e) => (
            <li
              key={e.id}
              className="flex items-start gap-2 px-3 py-2 text-[12px]"
            >
              <span className="mt-0.5 shrink-0">
                <KindIcon kind={e.kind} />
              </span>
              <div className="min-w-0 flex-1">
                <EventSummary
                  evt={e}
                  slug={ws.slug}
                  fallbackKey={ws.key}
                />
              </div>
              <span className="shrink-0 text-meta text-muted-foreground">
                {relativeTime(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

type TimelineEvent = RouterOutputs["agent"]["timeline"]["events"][number];

function EventSummary({
  evt,
  slug,
  fallbackKey,
}: {
  evt: TimelineEvent;
  slug: string;
  fallbackKey: string;
}) {
  const actor = evt.actor?.name ?? "system";
  const issue = evt.issue;
  const issueLink = issue ? (
    <Link
      href={`/w/${slug}/issues/${issue.id}`}
      className="font-mono text-id text-muted-foreground hover:text-foreground hover:underline"
    >
      {formatIssueId(issue.workspace?.key ?? fallbackKey, issue.number)}
    </Link>
  ) : null;
  const meta =
    issue && evt.kind !== "AGENT_STATUS_CHANGED" ? issue.title : null;

  let headline: React.ReactNode = `${actor} · ${evt.kind}`;
  switch (evt.kind) {
    case "AGENT_ASSIGNED":
      headline = (
        <>
          {actor} assigned {issueLink}
          {evt.agent && (
            <>
              {" "}to{" "}
              <span className="font-mono">@{evt.agent.profileKey}</span>
            </>
          )}
        </>
      );
      break;
    case "AGENT_STATUS_CHANGED":
      headline = (
        <>
          {evt.agent?.name ?? actor} went{" "}
          <span className="font-mono">{readPayloadString(evt.payload, "status") ?? "—"}</span>
        </>
      );
      break;
    case "ISSUE_STATUS_CHANGED":
      headline = (
        <>
          {actor} moved {issueLink}
          {issue && (
            <>
              {" "}→{" "}
              <span style={{ color: issue.status.color }}>
                {issue.status.name}
              </span>
            </>
          )}
        </>
      );
      break;
    case "ISSUE_QUEUED":
      headline = (
        <>
          {actor} queued {issueLink} for an agent
        </>
      );
      break;
    case "COMMENT_CREATED":
      headline = (
        <>
          {evt.agent ? (
            <span className="font-mono">@{evt.agent.profileKey}</span>
          ) : (
            actor
          )}{" "}
          commented on {issueLink}
        </>
      );
      break;
  }

  return (
    <>
      <div>{headline}</div>
      {meta && (
        <div className="truncate text-meta text-muted-foreground">{meta}</div>
      )}
    </>
  );
}

function KindIcon({ kind }: { kind: TimelineEvent["kind"] }) {
  const cls = "h-3.5 w-3.5 text-muted-foreground";
  switch (kind) {
    case "AGENT_ASSIGNED":
      return <UserCheck className={cls} />;
    case "AGENT_STATUS_CHANGED":
      return <Activity className={cls} />;
    case "AGENT_CREATED":
    case "AGENT_UPDATED":
    case "AGENT_DELETED":
      return <Bot className={cls} />;
    case "ISSUE_STATUS_CHANGED":
      return <ArrowRightLeft className={cls} />;
    case "ISSUE_QUEUED":
      return <Inbox className={cls} />;
    case "COMMENT_CREATED":
      return <MessageCircle className={cls} />;
    default:
      return <History className={cls} />;
  }
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
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
