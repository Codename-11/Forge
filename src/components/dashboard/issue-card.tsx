"use client";
import Link from "next/link";
import { AlertTriangle, Clock3, Loader2, PauseCircle, Timer } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { presenceAvailability } from "@/lib/transport-display";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import {
  PRIORITY_GLYPH,
  firstLine,
  formatDueDate,
  formatSlaShort,
} from "@/lib/issue-display";

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** One enriched card row from `dashboard.myWork` (focus or resume). */
export type DashboardWorkCard =
  RouterOutputs["dashboard"]["myWork"]["focus"][number];

// Only show a description snippet when the title is short enough that the
// extra line earns its space (long titles already fill the card).
const SNIPPET_TITLE_MAX = 42;

// Run statuses worth surfacing on a card — in-flight or needs-attention.
// Terminal runs (COMPLETED / ABANDONED) fall back to the updated-at stamp.
const NOTABLE_RUN = new Set(["ACTIVE", "WAITING", "STALLED"]);

/**
 * The one rich issue card used across the dashboard's "You" zone (Focus +
 * Pick-up) and, in `compact` form, the workspace lists. Renders four
 * signal rows — progress, context, people, activity — each ONLY when its
 * data exists, so a sparse issue stays short and a rich one grows. The
 * card never uses `h-full`; the parent grid uses `items-start`, so cards
 * size to content instead of stretching to the tallest sibling (that
 * stretch was the source of the dashboard's empty-space gaps).
 */
export function IssueCard({
  card,
  workspaceKey,
  slug,
  tz,
  compact = false,
}: {
  card: DashboardWorkCard;
  workspaceKey: string;
  slug: string;
  tz: string | null;
  compact?: boolean;
}) {
  const snippet =
    !compact && card.description && card.title.length <= SNIPPET_TITLE_MAX
      ? firstLine(card.description)
      : null;
  const labels = card.labels.slice(0, compact ? 1 : 3);
  const run = card.latestRun;
  const showRun = run && NOTABLE_RUN.has(run.status);
  const hasContext =
    !!card.project || labels.length > 0 || !!card.dueDate || card.slaMinutes != null;
  const hasFooter =
    card.assignees.length > 0 || !!card.assignedAgent || !!run;

  return (
    <Link
      href={`/w/${slug}/issues/${card.id}`}
      className={cn(
        "group flex flex-col rounded-lg border border-border bg-card/40 transition-colors hover:border-ember/40",
        compact ? "gap-1.5 p-2.5" : "gap-2 p-3",
      )}
    >
      {/* header: priority · id · status */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-6 shrink-0 text-center font-mono text-[0.6875rem] text-muted-foreground">
          {PRIORITY_GLYPH[card.priority] ?? "—"}
        </span>
        <span className="text-id shrink-0 text-muted-foreground">
          {formatIssueId(workspaceKey, card.number)}
        </span>
        <Badge className="ml-auto max-w-[48%] truncate" color={card.status.color}>
          {card.status.name}
        </Badge>
      </div>

      {/* title */}
      <div
        className={cn(
          "min-w-0",
          compact ? "line-clamp-1 text-[0.8125rem]" : "line-clamp-2 text-sm",
        )}
      >
        {card.title}
      </div>

      {/* description snippet (short titles only) */}
      {snippet && (
        <div className="line-clamp-1 text-[0.75rem] text-muted-foreground/90">
          {snippet}
        </div>
      )}

      {/* progress rollup (parents with sub-issues) */}
      {card.childTotal > 0 && (
        <ProgressRollup done={card.childDone} total={card.childTotal} />
      )}

      {/* context chips */}
      {hasContext && (
        <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          {card.project && (
            <Badge color={card.project.color ?? undefined}>{card.project.key}</Badge>
          )}
          {labels.map((l) => (
            <Badge key={l.label.id} color={l.label.color}>
              {l.label.name}
            </Badge>
          ))}
          {card.dueDate && (
            <span className="flex items-center gap-1">
              <Clock3 className="h-3 w-3" />
              {formatDueDate(card.dueDate, tz)}
            </span>
          )}
          {card.slaMinutes != null && (
            <span className="flex items-center gap-1">
              <Timer className="h-3 w-3" />
              SLA {formatSlaShort(card.slaMinutes)}
            </span>
          )}
        </div>
      )}

      {/* people + activity */}
      {hasFooter && (
        <div className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
          <People assignees={card.assignees} agent={card.assignedAgent} />
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {showRun ? (
              <RunChip status={run!.status} agentKey={run!.agent?.profileKey ?? null} />
            ) : (
              <span>{relativeTime(card.updatedAt)}</span>
            )}
          </span>
        </div>
      )}
    </Link>
  );
}

function ProgressRollup({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2" title={`${done} of ${total} sub-issues done`}>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-subtle">
        <div className="h-full rounded-full bg-ember/60" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
        {done}/{total}
      </span>
    </div>
  );
}

function People({
  assignees,
  agent,
}: {
  assignees: DashboardWorkCard["assignees"];
  agent: DashboardWorkCard["assignedAgent"];
}) {
  if (assignees.length === 0 && !agent) {
    return <span className="text-muted-foreground/60">Unassigned</span>;
  }
  return (
    <span className="flex items-center gap-1">
      {assignees.length > 0 && (
        <span className="flex items-center -space-x-1">
          {assignees.slice(0, 3).map((a) => (
            <Avatar
              key={a.user.id}
              name={a.user.name}
              image={a.user.image}
              size={18}
              className="ring-1 ring-card"
            />
          ))}
        </span>
      )}
      {agent && (
        <span className="relative inline-flex">
          <AgentAvatar agent={agent} size="xs" title={`@${agent.profileKey ?? agent.name ?? ""}`} />
          <AgentPresenceDot
            status={agent.status}
            availability={presenceAvailability(agent)}
            lastHeartbeatAt={agent.lastHeartbeatAt}
            className="absolute -bottom-0.5 -right-0.5"
          />
        </span>
      )}
    </span>
  );
}

const RUN_LABEL: Record<string, string> = {
  ACTIVE: "running",
  WAITING: "waiting",
  STALLED: "stalled",
};

function RunChip({ status, agentKey }: { status: string; agentKey: string | null }) {
  const Icon =
    status === "ACTIVE" ? Loader2 : status === "WAITING" ? PauseCircle : AlertTriangle;
  const tone =
    status === "STALLED"
      ? "text-amber-300"
      : status === "WAITING"
        ? "text-ember"
        : "text-success";
  return (
    <span
      className={cn("flex items-center gap-1", tone)}
      title={agentKey ? `${RUN_LABEL[status] ?? status} · @${agentKey}` : RUN_LABEL[status] ?? status}
    >
      <Icon className={cn("h-3 w-3", status === "ACTIVE" && "animate-spin")} />
      {RUN_LABEL[status] ?? status.toLowerCase()}
    </span>
  );
}
