"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Bot,
  Check,
  History,
  Hourglass,
  Inbox,
  MessageCircle,
  MessageSquare,
  Pause,
  Play,
  UserCheck,
  Wrench,
  X as XIcon,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";
import { EmptyState, SkeletonList } from "@/components/ui";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import type { AppRouter } from "@/server/routers/_app";

/**
 * Cross-source activity timeline for one agent. Consumes
 * `trpc.agent.unifiedTimeline` which interleaves Comment + ActivityEvent
 * + AgentRunEvent rows for the agent. Pagination uses `before` cursor:
 * pass the last page's `nextBefore` to fetch the next slice.
 *
 * Sources are queried independently with `take: limit`, so a merged
 * page can be smaller than `limit`. We never infinite-loop on that —
 * the load-more button only fires on a click, and a `null` `nextBefore`
 * disables it.
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type TimelineRow = RouterOutputs["agent"]["unifiedTimeline"]["rows"][number];
type CommentRow = Extract<TimelineRow, { kind: "comment" }>["payload"];
type EventRow = Extract<TimelineRow, { kind: "event" }>["payload"];
type RunEventRow = Extract<TimelineRow, { kind: "run-event" }>["payload"];

const RUN_KIND_GLYPH: Record<string, typeof Play> = {
  STARTED: Play,
  STEP: ArrowRight,
  TOOL_CALL: Wrench,
  STATUS: MessageSquare,
  COMMENT: MessageSquare,
  TRANSITION: ArrowRight,
  DISPATCH_RECEIVED: Play,
  BLOCKED: Pause,
  COMPLETED: Check,
  ABANDONED: XIcon,
  ERRORED: XIcon,
  STALLED: Hourglass,
};

const RUN_KIND_TINT: Record<string, string> = {
  STARTED: "text-ember",
  STEP: "text-foreground/70",
  TOOL_CALL: "text-foreground/60",
  STATUS: "text-ember",
  COMMENT: "text-indigo-500",
  TRANSITION: "text-foreground/70",
  DISPATCH_RECEIVED: "text-ember",
  BLOCKED: "text-amber-500",
  COMPLETED: "text-emerald-600",
  ABANDONED: "text-muted-foreground",
  ERRORED: "text-rose-600",
  STALLED: "text-amber-500",
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export default function AgentTimeline({ profileKey }: { profileKey: string }) {
  // tRPC 11's `useInfiniteQuery` requires the input to expose a `cursor`
  // field; `unifiedTimeline` uses `before` instead. Manage paging by
  // hand: head page comes from `useQuery({ before: undefined })`; older
  // pages are fetched imperatively into `pages` via `utils.fetch`.
  const utils = trpc.useUtils();
  const [pages, setPages] = useState<TimelineRow[][]>([]);
  const [exhausted, setExhausted] = useState(false);

  const { data, isLoading, isFetching } = trpc.agent.unifiedTimeline.useQuery(
    { profileKey, limit: 50 },
    {
      enabled: !!profileKey,
      staleTime: 30_000,
    },
  );

  // First page lives in `data`; subsequent pages live in `pages`. Merge
  // them inside the memo so the dep is the stable `data?.rows` reference
  // rather than a fresh `head` array every render.
  const allRows: TimelineRow[] = useMemo(() => {
    const head = data?.rows ?? [];
    if (pages.length === 0) return head;
    return [...head, ...pages.flat()];
  }, [data?.rows, pages]);

  useRealtime(
    () => {
      // Reset paging on any timeline-shaping event so the freshest page
      // shows up at the top.
      setPages([]);
      setExhausted(false);
      void utils.agent.unifiedTimeline.invalidate({ profileKey });
    },
    {
      kind: [
        "COMMENT_CREATED",
        "AGENT_ASSIGNED",
        "AGENT_STATUS_CHANGED",
        "AGENT_NOACK",
        "ISSUE_QUEUED",
        "ISSUE_STATUS_CHANGED",
        "ISSUE_STALLED",
      ],
    },
  );

  async function loadMore() {
    // Cursor for the next page is the timestamp of the oldest row we
    // currently have. The server returns `nextBefore=null` when its own
    // merged page came up short — we honour that by disabling the
    // button.
    const oldest = allRows[allRows.length - 1];
    if (!oldest) return;
    const nextBefore = new Date(oldest.timestamp);
    const next = await utils.agent.unifiedTimeline.fetch({
      profileKey,
      before: nextBefore,
      limit: 50,
    });
    if (next.rows.length === 0) {
      setExhausted(true);
      return;
    }
    setPages((p) => [...p, next.rows]);
    if (next.nextBefore == null) setExhausted(true);
  }

  // We have more pages iff the load-more cursor isn't exhausted and
  // we have at least one row to anchor the next `before` cursor against.
  // The first-page cursor (`data.nextBefore`) is informational — even if
  // the merged head was short, additional rows may still exist beyond
  // it (Stream A's per-source `take` heuristic).
  const hasNextPage = !exhausted && allRows.length > 0;

  if (isLoading) {
    return <SkeletonList rows={5} />;
  }

  if (allRows.length === 0) {
    return (
      <EmptyState
        variant="card"
        icon={<History />}
        title="No activity yet."
        description="Comments, run events, and agent activity will appear here."
      />
    );
  }

  return (
    <div className="space-y-2">
      <ol className="overflow-hidden rounded-lg border border-border bg-card/40">
        {allRows.map((row, i) => (
          <TimelineRowItem key={rowKey(row, i)} row={row} />
        ))}
      </ol>
      {(hasNextPage || isFetching) && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={!hasNextPage || isFetching}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[0.6875rem]",
              "text-muted-foreground transition-colors hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {isFetching ? "Loading…" : "Load older"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row dispatcher
// ---------------------------------------------------------------------------

function rowKey(row: TimelineRow, idx: number): string {
  switch (row.kind) {
    case "comment":
      return `c:${row.payload.id}`;
    case "event":
      return `e:${row.payload.id}`;
    case "run-event":
      return `r:${row.payload.id}`;
    default:
      return `?:${idx}`;
  }
}

function TimelineRowItem({ row }: { row: TimelineRow }) {
  switch (row.kind) {
    case "comment":
      return <CommentRowView comment={row.payload} timestamp={row.timestamp} />;
    case "event":
      return <EventRowView evt={row.payload} timestamp={row.timestamp} />;
    case "run-event":
      return <RunEventRowView re={row.payload} timestamp={row.timestamp} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Comment row — markdown body + issue link.
// ---------------------------------------------------------------------------

function CommentRowView({
  comment,
  timestamp,
}: {
  comment: CommentRow;
  timestamp: Date | string;
}) {
  const ws = useWorkspace();
  const issue = comment.issue;
  return (
    <li className="flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0">
      <span className="mt-0.5 shrink-0">
        <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-2 text-[0.75rem]">
          <span className="font-semibold text-foreground">commented</span>
          {issue && (
            <Link
              href={`/w/${ws.slug}/issues/${issue.id}`}
              className="text-id text-muted-foreground hover:text-foreground hover:underline"
            >
              {formatIssueId(issue.workspace?.key ?? ws.key, issue.number)}
            </Link>
          )}
          {issue && (
            <span className="truncate text-meta text-muted-foreground">
              {issue.title}
            </span>
          )}
          {comment.currentStep && (
            <span className="rounded-sm bg-subtle px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {comment.currentStep}
            </span>
          )}
        </div>
        <div className="text-foreground/85">
          <ChatMarkdown body={comment.body} />
        </div>
      </div>
      <span className="shrink-0 text-meta text-muted-foreground">
        {relativeTime(timestamp)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// ActivityEvent row — kind glyph + summary line built from kind + payload.
// ---------------------------------------------------------------------------

function EventRowView({
  evt,
  timestamp,
}: {
  evt: EventRow;
  timestamp: Date | string;
}) {
  return (
    <li className="flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0 text-[0.75rem]">
      <span className="mt-0.5 shrink-0">
        <ActivityKindIcon kind={evt.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground">
          <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
            {evt.kind}
          </span>
          {evt.actor?.name && (
            <span className="ml-2 text-muted-foreground">
              by {evt.actor.name}
            </span>
          )}
        </div>
        {summarizeEventPayload(evt) && (
          <div className="line-clamp-2 text-meta text-muted-foreground">
            {summarizeEventPayload(evt)}
          </div>
        )}
      </div>
      <span className="shrink-0 text-meta text-muted-foreground">
        {relativeTime(timestamp)}
      </span>
    </li>
  );
}

function summarizeEventPayload(evt: EventRow): string | null {
  if (!evt.payload || typeof evt.payload !== "object") return null;
  const p = evt.payload as Record<string, unknown>;
  // Friendly precedence: explicit summary > currentStep > status > preview.
  if (typeof p.summary === "string" && p.summary) return p.summary;
  if (typeof p.currentStep === "string" && p.currentStep) return p.currentStep;
  if (typeof p.status === "string" && p.status) return `status: ${p.status}`;
  if (typeof p.preview === "string" && p.preview) {
    return p.preview.length > 100 ? `${p.preview.slice(0, 100)}…` : p.preview;
  }
  return null;
}

function ActivityKindIcon({ kind }: { kind: string }) {
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
    case "AGENT_NOACK":
    case "ISSUE_STALLED":
      return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
    case "ISSUE_SLA_BREACH":
      return <AlertTriangle className="h-3.5 w-3.5 text-danger" />;
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

// ---------------------------------------------------------------------------
// AgentRunEvent row — kind glyph + currentStep / kind + truncated payload.
// ---------------------------------------------------------------------------

function RunEventRowView({
  re,
  timestamp,
}: {
  re: RunEventRow;
  timestamp: Date | string;
}) {
  const ws = useWorkspace();
  const Glyph = RUN_KIND_GLYPH[re.kind] ?? Activity;
  const tint = RUN_KIND_TINT[re.kind] ?? "text-muted-foreground";
  const issue = re.run?.issue ?? null;
  const summary = previewRunPayload(re);

  return (
    <li className="flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0 text-[0.75rem]">
      <span className="mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center">
        <Glyph className={cn("h-3.5 w-3.5", tint)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[0.6875rem] font-medium uppercase tracking-wider text-foreground">
            {re.kind}
          </span>
          {re.run?.currentStep && (
            <span className="text-meta text-muted-foreground">
              {re.run.currentStep}
            </span>
          )}
          {issue && (
            <Link
              href={`/w/${ws.slug}/issues/${issue.id}`}
              className="text-id text-muted-foreground hover:text-foreground hover:underline"
            >
              {formatIssueId(issue.workspace?.key ?? ws.key, issue.number)}
            </Link>
          )}
        </div>
        {summary && (
          <div className="truncate text-meta text-foreground/70">{summary}</div>
        )}
      </div>
      <span className="shrink-0 text-meta text-muted-foreground">
        {relativeTime(timestamp)}
      </span>
    </li>
  );
}

function previewRunPayload(re: RunEventRow): string | null {
  if (re.payload && typeof re.payload === "object") {
    const p = re.payload as Record<string, unknown>;
    if (typeof p.preview === "string" && p.preview) {
      return p.preview.length > 100 ? `${p.preview.slice(0, 100)}…` : p.preview;
    }
    if (typeof p.currentStep === "string" && p.currentStep) {
      return p.currentStep;
    }
    if (typeof p.eventKind === "string" && p.eventKind) {
      return String(p.eventKind);
    }
  }
  return re.run?.currentStep ?? null;
}

