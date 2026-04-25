"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Workflow } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { EmptyState, SkeletonList } from "@/components/ui";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { formatIssueId } from "@/lib/utils";

type PipelineData = inferRouterOutputs<AppRouter>["agent"]["pipeline"];
type PipelineIssue = PipelineData["lanes"][number]["assigned"][number];

export default function AgentPipeline() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data } = trpc.agent.pipeline.useQuery({});

  useRealtime(
    () => {
      void utils.agent.pipeline.invalidate();
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
                <span className="truncate text-sm font-medium text-foreground">
                  {agent.name}
                </span>
                <span className="text-meta truncate font-mono text-muted-foreground">
                  @{agent.profileKey}
                </span>
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
                {lane.inFlight.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} wsSlug={ws.slug} wsKey={ws.key} />
                ))}
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
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="text-meta font-mono text-muted-foreground">{count}</span>
      </div>
      <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">{children}</div>
    </div>
  );
}

function IssueCard({
  issue,
  wsSlug,
  wsKey,
}: {
  issue: PipelineIssue;
  wsSlug: string;
  wsKey: string;
}) {
  return (
    <Link
      href={`/w/${wsSlug}/issues/${issue.id}`}
      className="focus-ring block rounded-md border border-border bg-card px-2 py-1.5 hover:bg-subtle"
    >
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className="text-id text-muted-foreground">
          {formatIssueId(wsKey, issue.number)}
        </span>
        {!issue.unblocked && (
          <span className="rounded-sm bg-danger/10 px-1 text-[9px] font-semibold uppercase tracking-wider text-danger">
            blocked
          </span>
        )}
        <span
          className="ml-auto h-1.5 w-1.5 rounded-full"
          style={{ background: issue.status.color }}
          title={issue.status.name}
        />
      </div>
      <div className="mt-0.5 truncate text-[12px]">{issue.title}</div>
      {(issue.project || issue._count.comments > 0) && (
        <div className="text-meta mt-1 flex items-center gap-2 text-muted-foreground">
          {issue.project && (
            <span className="font-mono">{issue.project.key}</span>
          )}
          {issue._count.comments > 0 && <span>{issue._count.comments}c</span>}
        </div>
      )}
    </Link>
  );
}

function EmptyRow() {
  return (
    <div className="text-meta px-2 py-1.5 text-muted-foreground">—</div>
  );
}
