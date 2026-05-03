"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Workflow } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { EmptyState, SkeletonList } from "@/components/ui";
import {
  RunControlMenu,
  type RunControlMenuRun,
} from "@/components/run-control-menu";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { formatIssueId, relativeTime } from "@/lib/utils";

type PipelineData = inferRouterOutputs<AppRouter>["agent"]["pipeline"];
type PipelineIssue = PipelineData["lanes"][number]["assigned"][number];
type AgentRunRow =
  inferRouterOutputs<AppRouter>["agentRun"]["activeAll"][number];
type ListedRunRow = inferRouterOutputs<AppRouter>["agentRun"]["list"][number];

export default function AgentPipeline() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data } = trpc.agent.pipeline.useQuery({});
  // Active runs power the In-flight column's RunControlMenu — joined
  // client-side by issueId so the existing pipeline rollup query
  // doesn't need to grow a join.
  const { data: activeRuns } = trpc.agentRun.activeAll.useQuery({ limit: 50 });
  // Failed-run lane: terminal-but-not-clean runs in the last 24h.
  // `AgentRunStatus` is { ACTIVE, COMPLETED, ABANDONED, STALLED } —
  // there's no FAILED enum value, so the failure surface is the union
  // of ABANDONED + STALLED. The procedure doesn't expose a `since`
  // filter; we pull the most recent 30 then window them client-side.
  const { data: failedRuns } = trpc.agentRun.list.useQuery({
    status: ["ABANDONED", "STALLED"],
    limit: 30,
  });

  useRealtime(
    () => {
      void utils.agent.pipeline.invalidate();
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.list.invalidate();
    },
    {
      kind: [
        "ISSUE_STATUS_CHANGED",
        "ISSUE_QUEUED",
        "AGENT_ASSIGNED",
        "AGENT_STATUS_CHANGED",
        "ISSUE_CREATED",
        "ISSUE_UPDATED",
        "ISSUE_DELETED",
        "AGENT_RUN_CONTROL_REQUESTED",
      ],
    },
  );

  if (data === undefined) {
    return <SkeletonList rows={4} />;
  }

  const { pool, lanes } = data;

  if (
    lanes.length === 0 &&
    pool.ready.length === 0 &&
    pool.blocked.length === 0
  ) {
    return (
      <EmptyState
        variant="card"
        icon={<Workflow />}
        title="Pipeline is clear."
        description="No queued or in-flight agent work right now."
      />
    );
  }

  // issueId → most recent ACTIVE run (sorted desc by lastEventAt by the
  // procedure itself, so the first encounter wins).
  const runByIssueId = new Map<string, AgentRunRow>();
  for (const r of activeRuns ?? []) {
    if (!runByIssueId.has(r.issueId)) runByIssueId.set(r.issueId, r);
  }

  // 24h sliding window for the Failed lane. Trim client-side; bumping
  // the procedure's window-knob is a future cleanup.
  const cutoff = Date.now() - 24 * 3_600_000;
  const failedWindow = (failedRuns ?? []).filter((r) => {
    const t = r.finishedAt ?? r.lastEventAt;
    return t ? new Date(t).getTime() >= cutoff : false;
  });

  return (
    <div className="space-y-3">
      <Lane
        header={
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-medium text-foreground">Pool</span>
            <span className="text-meta truncate text-muted-foreground">
              queued &middot; unassigned &middot; {pool.ready.length} ready
              &middot; {pool.blocked.length} blocked
            </span>
          </div>
        }
      >
        <div className="grid grid-cols-[3fr_1fr] gap-2">
          <Column label="Ready" count={pool.ready.length}>
            {pool.ready.map((issue) => (
              <IssueCard key={issue.id} issue={issue} wsSlug={ws.slug} wsKey={ws.key} />
            ))}
            {pool.ready.length === 0 && <EmptyRow />}
          </Column>
          <Column label="Blocked" count={pool.blocked.length}>
            {pool.blocked.map((issue) => (
              <IssueCard key={issue.id} issue={issue} wsSlug={ws.slug} wsKey={ws.key} />
            ))}
            {pool.blocked.length === 0 && <EmptyRow />}
          </Column>
        </div>
      </Lane>

      {lanes.map((lane) => {
        const { agent, counts } = lane;
        const loadText =
          agent.maxConcurrent === 0
            ? `${counts.load} active`
            : `${counts.load}/${agent.maxConcurrent}`;
        return (
          <Lane
            key={agent.id}
            header={
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <AgentPresenceDot
                  status={agent.status}
                  size="md"
                  lastHeartbeatAt={agent.lastHeartbeatAt}
                />
                <Link
                  href={`/w/${ws.slug}/agents/${agent.profileKey}`}
                  className="flex min-w-0 items-center gap-2 hover:underline"
                >
                  <span className="truncate text-sm font-medium text-foreground">
                    {agent.name}
                  </span>
                  <span className="text-meta truncate font-mono text-muted-foreground">
                    @{agent.profileKey}
                  </span>
                </Link>
                <span className="text-meta ml-auto shrink-0 font-mono text-muted-foreground">
                  {loadText}
                </span>
              </div>
            }
          >
            <div className="grid grid-cols-3 gap-2">
              <Column label="Assigned" count={counts.assigned}>
                {lane.assigned.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} wsSlug={ws.slug} wsKey={ws.key} />
                ))}
                {lane.assigned.length === 0 && <EmptyRow />}
              </Column>
              <Column label="In flight" count={counts.inFlight}>
                {lane.inFlight.map((issue) => {
                  const run = runByIssueId.get(issue.id);
                  return (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      wsSlug={ws.slug}
                      wsKey={ws.key}
                      run={
                        run
                          ? {
                              id: run.id,
                              status: run.status,
                              controlState: run.controlState,
                              agentId: agent.id,
                            }
                          : null
                      }
                      controlRequestedAt={run?.controlRequestedAt ?? null}
                      controlRequestedByName={
                        run?.controlRequestedBy?.name ?? null
                      }
                    />
                  );
                })}
                {lane.inFlight.length === 0 && <EmptyRow />}
              </Column>
              <Column label="Recently done" count={counts.recentlyDone}>
                {lane.recentlyDone.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} wsSlug={ws.slug} wsKey={ws.key} />
                ))}
                {lane.recentlyDone.length === 0 && <EmptyRow />}
              </Column>
            </div>
          </Lane>
        );
      })}

      <FailedLane runs={failedWindow} wsSlug={ws.slug} wsKey={ws.key} />
    </div>
  );
}

function Lane({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">{header}</div>
      {children}
    </div>
  );
}

function Column({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="text-meta font-mono text-muted-foreground">{count}</span>
      </div>
      <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">{children}</div>
    </div>
  );
}

/**
 * `IssueCard` — the single-issue row used in every pipeline lane. The
 * `run` prop is only set in the In-flight column and powers two
 * affordances:
 *   - A `RunControlMenu` trigger in the row's top-right.
 *   - A "pause requested" / "cancel requested" badge so the operator
 *     sees the in-flight signal before the runtime acts on it.
 *
 * Note we still render a `<Link>` wrapping the row for navigation; the
 * `RunControlMenu` lives outside the link so its click handler isn't
 * swallowed by the parent.
 */
function IssueCard({
  issue,
  wsSlug,
  wsKey,
  run,
  controlRequestedAt,
  controlRequestedByName,
}: {
  issue: PipelineIssue;
  wsSlug: string;
  wsKey: string;
  run?: RunControlMenuRun | null;
  /** When set, used for the pending-control badge tooltip. */
  controlRequestedAt?: Date | string | null;
  controlRequestedByName?: string | null;
}) {
  const controlBadge =
    run && run.controlState === "PAUSE_REQUESTED"
      ? "pause requested"
      : run && run.controlState === "CANCEL_REQUESTED"
        ? "cancel requested"
        : null;
  const controlBadgeTitle = controlBadge
    ? controlRequestedAt
      ? `Requested ${relativeTime(controlRequestedAt)}${
          controlRequestedByName ? ` by ${controlRequestedByName}` : ""
        }`
      : controlRequestedByName
        ? `Requested by ${controlRequestedByName}`
        : "Control request pending"
    : undefined;

  return (
    <div className="relative">
      <Link
        href={`/w/${wsSlug}/issues/${issue.id}`}
        className="focus-ring block rounded-md border border-border bg-card px-2 py-1.5 hover:bg-subtle"
      >
        <div className="flex items-center gap-1.5 text-[0.75rem]">
          <span className="text-id text-muted-foreground">
            {formatIssueId(wsKey, issue.number)}
          </span>
          {!issue.unblocked && (
            <span className="rounded-sm bg-danger/10 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-danger">
              blocked
            </span>
          )}
          {controlBadge && (
            <span
              title={controlBadgeTitle}
              className="rounded-sm bg-warning/10 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-warning"
            >
              {controlBadge}
            </span>
          )}
          <span
            className="ml-auto h-1.5 w-1.5 rounded-full"
            style={{ background: issue.status.color }}
            title={issue.status.name}
          />
        </div>
        <div className={run ? "mt-0.5 truncate pr-6 text-[0.75rem]" : "mt-0.5 truncate text-[0.75rem]"}>
          {issue.title}
        </div>
        {(issue.project || issue._count.comments > 0) && (
          <div className="text-meta mt-1 flex items-center gap-2 text-muted-foreground">
            {issue.project && (
              <span className="font-mono">{issue.project.key}</span>
            )}
            {issue._count.comments > 0 && <span>{issue._count.comments}c</span>}
          </div>
        )}
      </Link>
      {run && (
        <div className="absolute right-1 top-1">
          <RunControlMenu run={run} />
        </div>
      )}
    </div>
  );
}

/**
 * `FailedLane` — fourth lane on the pipeline (ABANDONED / STALLED
 * runs in the last 24 hours). Compact rows: agent avatar +
 * issue key + last error excerpt + relative timestamp. Quiet empty
 * state — the lane should disappear visually when there's nothing
 * to surface.
 *
 * The procedure doesn't currently include a `lastError` field on its
 * AgentRun rows; we lean on the run's `summary` (populated when
 * `finishRun` is called with a tail message) and fall back to the
 * status comment's `body`. Either way is best-effort context — the
 * lane's value is showing the agent + issue + timestamp.
 */
function FailedLane({
  runs,
  wsSlug,
  wsKey,
}: {
  runs: ListedRunRow[];
  wsSlug: string;
  wsKey: string;
}) {
  return (
    <Lane
      header={
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">
            Failed (24h)
          </span>
          <span className="text-meta truncate text-muted-foreground">
            abandoned &middot; stalled &middot; {runs.length}
          </span>
        </div>
      }
    >
      {runs.length === 0 ? (
        <div className="text-meta px-2 py-1.5 text-muted-foreground">
          No failures in the last day.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {runs.map((run) => {
            const issueKey = run.issue
              ? formatIssueId(wsKey, run.issue.number)
              : "—";
            const ts = run.finishedAt ?? run.lastEventAt;
            const excerpt = excerptFor(run);
            return (
              <li key={run.id}>
                <Link
                  href={
                    run.issue
                      ? `/w/${wsSlug}/issues/${run.issue.id}`
                      : `/w/${wsSlug}/agents/${run.agent.profileKey}`
                  }
                  className="focus-ring flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 hover:bg-subtle"
                >
                  <AgentPresenceDot
                    status={run.agent.status}
                    size="sm"
                  />
                  <span className="text-id shrink-0 text-muted-foreground">
                    {issueKey}
                  </span>
                  <span className="text-meta shrink-0 font-mono text-muted-foreground">
                    @{run.agent.profileKey}
                  </span>
                  <span className="rounded-sm bg-danger/10 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-danger">
                    {run.status.toLowerCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[0.75rem]">
                    {excerpt ?? run.issue?.title ?? "Failed run"}
                  </span>
                  {ts && (
                    <span className="text-meta shrink-0 text-muted-foreground">
                      {relativeTime(ts)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Lane>
  );
}

function excerptFor(run: ListedRunRow): string | null {
  // `summary` is set when the run terminates via the `finishRun` helper.
  // The status comment is a rolling description ("running tests…") and
  // is the closest thing to a `lastError` we have without a dedicated
  // column. Truncate so the row doesn't blow up the lane's height.
  const raw = run.summary ?? run.statusComment?.body ?? null;
  if (!raw) return null;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= 120) return flat;
  return `${flat.slice(0, 117)}…`;
}

function EmptyRow() {
  return (
    <div className="text-meta px-2 py-1.5 text-muted-foreground">—</div>
  );
}
