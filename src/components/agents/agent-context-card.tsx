"use client";
import Link from "next/link";
import { Eye, ExternalLink, MessageSquare, Paperclip, Workflow } from "lucide-react";
import { Section, Card, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { formatIssueId, relativeTime } from "@/lib/utils";

/**
 * "What this agent currently sees" preview card. Shown on the agent
 * detail page right rail. v1 scope:
 *
 *   - The most recent in-flight (or assigned) issue assigned to this
 *     agent — the one its next loop iteration is most likely to act on.
 *   - Title, status dot, attachment count, comment count.
 *   - Click-through opens the issue.
 *
 * Stream BA is shipping `agent.context.bundle({ issueId })` which would
 * give a richer preview (pinned context, recent runs). When that lands
 * the card can swap from the existing-data path to the bundle endpoint
 * without touching its placement on the page.
 *
 * Data sources (no new tRPC procedures):
 *   - `agent.pipeline` — already used elsewhere on the page; cheap to
 *     re-query because react-query dedupes.
 *   - `issue.byId`     — populated `attachments[]` and `comments[]`.
 */
export function AgentContextCard({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName?: string | null;
}) {
  const ws = useWorkspace();
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const lane = pipeline?.lanes.find((l) => l.agent.id === agentId);
  // Prefer in-flight (active work) over plain assigned (queued).
  const nextIssue = lane?.inFlight[0] ?? lane?.assigned[0] ?? null;

  const { data: issueDetail } = trpc.issue.byId.useQuery(
    { id: nextIssue?.id ?? "" },
    { enabled: !!nextIssue?.id, staleTime: 30_000 },
  );

  if (!pipeline) {
    return (
      <Section
        title={
          <span className="flex items-center gap-2">
            <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            {agentName ? `What ${agentName} sees next` : "What agent sees next"}
          </span>
        }
      >
        <Card className="text-meta space-y-2 p-3 text-muted-foreground">Loading…</Card>
      </Section>
    );
  }

  if (!nextIssue) {
    return (
      <Section
        title={
          <span className="flex items-center gap-2">
            <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            {agentName ? `What ${agentName} sees next` : "What agent sees next"}
          </span>
        }
        hint="What the agent's next loop iteration will see."
      >
        <EmptyState
          variant="card"
          icon={<Workflow />}
          title="Nothing on deck."
          description="Assign an issue to this agent to populate its working context."
        />
      </Section>
    );
  }

  const attachmentCount = issueDetail?.attachments?.length ?? 0;
  const commentCount = issueDetail?.comments?.length ?? nextIssue._count?.comments ?? 0;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          {agentName ? `What ${agentName} sees next` : "What agent sees next"}
        </span>
      }
      hint="What the agent's next loop iteration will see."
    >
      <Card className="space-y-2 p-3 text-[0.75rem]">
        <Link
          href={`/w/${ws.slug}/issues/${nextIssue.id}`}
          className="focus-ring flex items-start gap-2 rounded-md hover:text-ember"
        >
          <span
            className="mt-1 h-2 w-2 shrink-0 rounded-full"
            style={{ background: nextIssue.status.color }}
            title={nextIssue.status.name}
          />
          <span className="min-w-0 flex-1">
            <span className="text-id mr-1.5 text-muted-foreground">
              {formatIssueId(ws.key, nextIssue.number)}
            </span>
            <span className="font-medium text-foreground">{nextIssue.title}</span>
          </span>
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Link>
        <div className="text-meta flex flex-wrap items-center gap-3 text-muted-foreground">
          <span className="capitalize">{nextIssue.status.name.toLowerCase()}</span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {commentCount} comment{commentCount === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Paperclip className="h-3 w-3" />
            {attachmentCount} attachment{attachmentCount === 1 ? "" : "s"}
          </span>
        </div>
        {issueDetail && (
          <div className="text-meta text-muted-foreground">
            updated {relativeTime(issueDetail.updatedAt)}
          </div>
        )}
        <div className="text-meta border-t border-border pt-2 text-muted-foreground">
          {lane?.counts.load ?? 0} active in this agent&apos;s lane ·{" "}
          {lane?.counts.recentlyDone ?? 0} done (7d)
        </div>
      </Card>
    </Section>
  );
}
