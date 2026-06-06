"use client";
import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Pin,
  PinOff,
  ChevronRight,
  Bot,
  ExternalLink,
  ShieldAlert,
  Check,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ModeChip } from "@/components/ui/engagement-mode-glyph";
import { RunTimeline } from "./run-timeline";
import { RunActions } from "./run-actions";

/**
 * Single row inside the Live tab. One ACTIVE AgentRun.
 *
 * Collapsed: agent · issueKey · current step · elapsed · "updated Ns ago"
 * with a small ember pulse dot.
 *
 * Expanded: timeline of recent AgentRunEvents below the headline,
 * fetched lazily on first expand to avoid spamming the events query
 * for every row.
 */

export type RunRowData = {
  id: string;
  startedAt: Date | string;
  lastEventAt: Date | string;
  currentStep: string | null;
  /** Engagement mode of this run — what kind of work is in flight. */
  engagementMode?: string | null;
  agent: { id: string; name: string; profileKey: string };
  issue: {
    id: string;
    number: number;
    title: string;
    workspace: { key: string; slug: string };
  } | null;
  statusComment?: { body: string; currentStep: string | null } | null;
  /** Token usage written by `runs.recordUsage` (Stream A). Each is
   * cumulative-as-reported. Render a compact chip when present. */
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensCached?: number | null;
  /** Set when a connector-driven run paused awaiting operator permission
   * (e.g. Hermes flagged a dangerous command). Shows Approve/Reject. */
  awaitingApprovalAt?: Date | string | null;
  /** Command/risk detail captured from the live events stream (JSON). */
  pendingApproval?: unknown;
};

/** Narrow the JSON `pendingApproval` blob to its displayable fields. */
function readPendingApproval(v: unknown): { command: string | null; description: string | null } {
  if (!v || typeof v !== "object") return { command: null, description: null };
  const o = v as Record<string, unknown>;
  return {
    command: typeof o.command === "string" ? o.command : null,
    description: typeof o.description === "string" ? o.description : null,
  };
}

/** Format a token count compactly: <1k as raw, ≥1k rounded to k. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

const STALE_RUN_MS = 5 * 60_000;

function elapsed(from: Date | string): string {
  const t = typeof from === "string" ? new Date(from) : from;
  const ms = Date.now() - t.getTime();
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function relativeTime(input: Date | string): string {
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function formatEta(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

export function RunRow({
  run,
  pinned,
  onTogglePin,
  active,
  onActivate,
}: {
  run: RunRowData;
  pinned: boolean;
  onTogglePin: () => void;
  /** True when keyboard navigation has this row "selected." */
  active?: boolean;
  /** Click handler — sets keyboard-active row for j/k traversal. */
  onActivate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const utils = trpc.useUtils();
  const { data: events } = trpc.agentRun.events.useQuery(
    { runId: run.id, limit: 40 },
    { enabled: expanded, staleTime: 5_000 },
  );
  const awaitingApproval = Boolean(run.awaitingApprovalAt);
  const pendingApproval = readPendingApproval(run.pendingApproval);
  const respondApproval = trpc.agentRun.respondApproval.useMutation({
    onSettled: () => {
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.activeForIssue.invalidate();
    },
  });

  const issueKey = run.issue ? `${run.issue.workspace.key}-${run.issue.number}` : "—";
  const issueHref = run.issue ? `/w/${run.issue.workspace.slug}/issues/${run.issue.id}` : null;
  const lastEventAt =
    typeof run.lastEventAt === "string" ? new Date(run.lastEventAt) : run.lastEventAt;
  const lastEventAgeMs = Date.now() - lastEventAt.getTime();
  const isStalled = lastEventAgeMs > STALE_RUN_MS;

  const { data: etaData } = trpc.agentRun.eta.useQuery(
    { runId: run.id },
    { staleTime: 60_000, enabled: !isStalled },
  );
  const etaLabel = etaData?.etaMs ? `~${formatEta(etaData.etaMs)} left` : null;

  const { data: coachComment } = trpc.agentRun.coachDiagnosis.useQuery(
    { runId: run.id },
    { staleTime: 30_000, enabled: isStalled },
  );

  return (
    <div
      data-active={active || undefined}
      className={cn(
        "group/row relative rounded-md border border-border bg-card/40 px-2.5 py-2 text-[0.75rem] transition-colors",
        active && "border-ember/40 bg-ember/5",
        isStalled && "border-warning/40 bg-warning/5",
      )}
      onMouseEnter={onActivate}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground sm:h-4 sm:w-4"
          aria-label={expanded ? "Collapse timeline" : "Expand timeline"}
          title={expanded ? "Collapse timeline" : "Expand timeline"}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
        </button>
        {isStalled ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
        ) : (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember opacity-50" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
          </span>
        )}
        <Bot className="h-3.5 w-3.5 shrink-0 text-ember" />
        <span className="min-w-0 truncate font-medium text-foreground">{run.agent.name}</span>
        <span className="text-muted-foreground">·</span>
        {issueHref ? (
          <Link
            href={issueHref}
            className="font-mono text-[0.6875rem] text-foreground/80 hover:text-ember"
            title={run.issue?.title}
          >
            {issueKey}
          </Link>
        ) : (
          <span className="font-mono text-[0.6875rem] text-foreground/60">{issueKey}</span>
        )}
        {run.engagementMode && run.engagementMode !== "EXECUTE" && (
          <ModeChip mode={run.engagementMode} />
        )}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <RunActions runId={run.id} agentName={run.agent.name} />
          {(() => {
            const tokens = (run.tokensIn ?? 0) + (run.tokensOut ?? 0);
            if (tokens === 0) return null;
            const inPart = run.tokensIn ?? 0;
            const outPart = run.tokensOut ?? 0;
            const cachedPart = run.tokensCached ?? 0;
            return (
              <span
                className="rounded border border-border/60 bg-subtle/40 px-1 py-0 font-mono text-[0.625rem] text-muted-foreground"
                title={`tokens · in ${inPart} · out ${outPart}${cachedPart ? ` · cached ${cachedPart}` : ""}`}
              >
                {formatTokens(tokens)} tok
              </span>
            );
          })()}
          <span
            className="text-meta font-mono text-muted-foreground"
            title={`Started ${new Date(run.startedAt).toLocaleString()}`}
          >
            {elapsed(run.startedAt)}
          </span>
          <button
            type="button"
            onClick={onTogglePin}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground sm:h-5 sm:w-5",
              pinned && "text-ember hover:text-ember",
            )}
            aria-label={pinned ? "Unpin run" : "Pin run"}
            title={pinned ? "Unpin run" : "Pin run"}
          >
            {pinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
          </button>
          {issueHref && (
            <Link
              href={issueHref}
              className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground sm:h-5 sm:w-5"
              aria-label="Open issue"
              title="Open issue"
            >
              <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </span>
      </div>
      {/* Headline step + last-event freshness */}
      <div className="mt-0.5 flex flex-wrap items-baseline gap-2 pl-6">
        <span className="min-w-[12rem] flex-1 truncate text-foreground/80">
          {run.currentStep ?? run.statusComment?.currentStep ?? "working…"}
        </span>
        <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          {etaLabel && (
            <span
              className="rounded-md border border-border/60 bg-subtle/60 px-1.5 py-0 font-mono text-[0.625rem] text-muted-foreground"
              title={`Median ${Math.round((etaData?.medianMs ?? 0) / 60_000)}m over ${etaData?.sampleSize ?? 0} runs`}
            >
              {etaLabel}
            </span>
          )}
          <span
            className={cn("text-meta", isStalled ? "text-warning" : "text-muted-foreground")}
            title={`Last event ${lastEventAt.toLocaleString()}`}
          >
            {relativeTime(run.lastEventAt)}
          </span>
        </span>
      </div>
      {awaitingApproval && (
        <div
          className="text-meta mt-1.5 flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5"
          data-no-drag
          onClick={(e) => e.stopPropagation()}
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-foreground/80">
            {run.agent.name} needs permission
            {pendingApproval.command ? (
              <>
                {" "}
                to run{" "}
                <code className="rounded bg-background/60 px-1 font-mono text-[0.625rem] text-foreground">
                  {pendingApproval.command.length > 80
                    ? `${pendingApproval.command.slice(0, 77)}…`
                    : pendingApproval.command}
                </code>
              </>
            ) : (
              " to run a command"
            )}
            {pendingApproval.description ? (
              <span className="mt-0.5 block text-[0.625rem] text-muted-foreground">
                {pendingApproval.description}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            disabled={respondApproval.isPending}
            onClick={() => respondApproval.mutate({ runId: run.id, decision: "approve" })}
            className="inline-flex min-h-8 items-center gap-1 rounded border border-ember/40 bg-ember/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-ember hover:bg-ember/25 disabled:opacity-50 sm:min-h-0"
          >
            <Check className="h-3 w-3" /> Approve
          </button>
          <button
            type="button"
            disabled={respondApproval.isPending}
            onClick={() => respondApproval.mutate({ runId: run.id, decision: "reject" })}
            className="inline-flex min-h-8 items-center gap-1 rounded border border-border bg-card/40 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:text-foreground disabled:opacity-50 sm:min-h-0"
          >
            <X className="h-3 w-3" /> Reject
          </button>
        </div>
      )}
      {isStalled && !awaitingApproval && (
        <div className="text-meta mt-1.5 rounded-md border border-warning/30 bg-background/50 px-2 py-1.5 text-muted-foreground">
          <div className="font-medium text-foreground">
            No run event for {elapsed(lastEventAt)}.
          </div>
          <div>
            Last signal: {lastEventAt.toLocaleString()}. Recommended fix: check the agent heartbeat,
            webhook delivery, and latest issue status comment before reassigning.
          </div>
          {coachComment && (
            <div className="mt-1.5 rounded border border-warning/30 bg-card/60 px-2 py-1 text-foreground/80">
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-warning">
                {coachComment.authoringAgent?.name ?? "Coach"} ·{" "}
                {relativeTime(coachComment.createdAt)}
              </div>
              <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap">{coachComment.body}</div>
            </div>
          )}
        </div>
      )}
      {expanded && (
        <div className="mt-1.5 border-t border-border/60 pl-6 pt-1.5">
          <RunTimeline events={events ?? []} />
        </div>
      )}
    </div>
  );
}
