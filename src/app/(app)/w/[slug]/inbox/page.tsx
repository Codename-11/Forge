"use client";
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Inbox, Clock, MessageCircle, Target } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Card } from "@/components/settings/card";
import { Section } from "@/components/settings/section";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { workspaceColor } from "@/lib/workspace-color";

/**
 * Unified "what's next" inbox. Four sections (assigned+unblocked,
 * mentions, stalled, current cycle burn) plus a workspace/all toggle.
 *
 * The server router lives in `inbox.ts`. It decides scoping via the
 * `allWorkspaces` flag: when true, memberships across every workspace
 * are aggregated; when false, only the header-scoped workspace is used.
 */
export default function InboxPage() {
  const workspace = useWorkspace();
  const [allWorkspaces, setAllWorkspaces] = useState(false);

  const { data, isLoading } = trpc.inbox.get.useQuery({ allWorkspaces });

  return (
    <>
      <Topbar
        title="Inbox"
        subtitle="Everything worth looking at, in one place."
        actions={
          <div className="flex items-center gap-1 rounded-md bg-subtle p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setAllWorkspaces(false)}
              className={cn(
                "focus-ring rounded px-2 py-1 transition-colors",
                !allWorkspaces
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              This workspace
            </button>
            <button
              type="button"
              onClick={() => setAllWorkspaces(true)}
              className={cn(
                "focus-ring rounded px-2 py-1 transition-colors",
                allWorkspaces
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              All my workspaces
            </button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-5">
        {isLoading || !data ? (
          <p className="p-6 text-xs text-muted-foreground">Loading inbox…</p>
        ) : (
          <>
            <Section
              title={
                <span className="flex items-center gap-2">
                  <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                  Assigned & unblocked
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {data.counts.assignedUnblocked}
                  </span>
                </span>
              }
              hint="Your assignments that aren't waiting on anything else."
            >
              <Card>
                {data.assignedUnblocked.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="Nothing in your queue."
                    hint="Pick up something from Issues or let an agent claim one via MCP."
                  />
                ) : (
                  data.assignedUnblocked.map((i) => (
                    <IssueRow
                      key={i.id}
                      issue={{
                        id: i.id,
                        number: i.number,
                        title: i.title,
                        workspace: i.workspace,
                        status: { name: i.status.name, color: i.status.color },
                        updatedAt: i.updatedAt,
                      }}
                    />
                  ))
                )}
              </Card>
            </Section>

            <Section
              title={
                <span className="flex items-center gap-2">
                  <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
                  Mentions
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {data.counts.mentions}
                  </span>
                </span>
              }
              hint="Comments that @mention you in the last 7 days (schema placeholder — user.lastInboxVisitAt not yet persisted)."
            >
              <Card>
                {data.mentions.length === 0 ? (
                  <EmptyState
                    icon={MessageCircle}
                    title="No recent mentions."
                  />
                ) : (
                  data.mentions.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-start gap-3 px-3 py-2 text-[12px]"
                    >
                      <WorkspaceBadge
                        slug={m.issue.workspace.slug}
                        wsKey={m.issue.workspace.key}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/w/${m.issue.workspace.slug}/issues/${m.issue.id}`}
                            className="font-mono text-[11px] hover:underline"
                          >
                            {formatIssueId(m.issue.workspace.key, m.issue.number)}
                          </Link>
                          <span className="truncate">{m.issue.title}</span>
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {m.author.name ?? "Someone"}
                          </span>
                          {" — "}
                          {m.body}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {relativeTime(m.createdAt)}
                      </span>
                    </li>
                  ))
                )}
              </Card>
            </Section>

            <Section
              title={
                <span className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
                  Stalled &gt; 7d
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {data.counts.stalled}
                  </span>
                </span>
              }
              hint="Your assignments without activity for more than a week."
            >
              <Card>
                {data.stalled.length === 0 ? (
                  <EmptyState
                    icon={AlertTriangle}
                    title="Nothing stalled."
                    hint="Work is moving. Nice."
                  />
                ) : (
                  data.stalled.map((i) => (
                    <IssueRow
                      key={i.id}
                      issue={{
                        id: i.id,
                        number: i.number,
                        title: i.title,
                        workspace: i.workspace,
                        status: { name: i.status.name, color: i.status.color },
                        updatedAt: i.updatedAt,
                      }}
                      tone="warn"
                    />
                  ))
                )}
              </Card>
            </Section>

            {!allWorkspaces && (
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Target className="h-3.5 w-3.5 text-muted-foreground" />
                    Current cycle burn
                  </span>
                }
                hint="Progress on the active cycle in this workspace."
              >
                {data.cycle ? (
                  <div className="rounded-lg border border-border bg-card/40 p-4">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/w/${workspace.slug}/cycles/${data.cycle.id}`}
                          className="truncate text-sm font-semibold hover:underline"
                        >
                          {data.cycle.name}
                        </Link>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {data.cycle.done}/{data.cycle.total} done · {data.cycle.remaining} remaining
                        </div>
                      </div>
                      <div className="text-right font-mono text-2xl tabular-nums">
                        {data.cycle.pctDone}%
                      </div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-subtle">
                      <div
                        className="h-full bg-ember transition-[width]"
                        style={{ width: `${data.cycle.pctDone}%` }}
                      />
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span>
                        {data.cycle.endsAt
                          ? `Ends ${relativeTime(data.cycle.endsAt)}`
                          : "No end date"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <Card as="div">
                    <EmptyState
                      icon={Target}
                      title="No active cycle."
                      hint="Start one from the Cycles page."
                    />
                  </Card>
                )}
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function IssueRow({
  issue,
  tone,
}: {
  issue: {
    id: string;
    number: number;
    title: string;
    workspace: { slug: string; key: string };
    status: { name: string; color: string };
    updatedAt: Date | string;
  };
  tone?: "warn";
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-[12px] hover:bg-subtle/40">
      <WorkspaceBadge slug={issue.workspace.slug} wsKey={issue.workspace.key} />
      <Link
        href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
        className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
      >
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {formatIssueId(issue.workspace.key, issue.number)}
        </span>
        <span className="truncate">{issue.title}</span>
      </Link>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
        style={{
          backgroundColor: `${issue.status.color}22`,
          color: issue.status.color,
        }}
      >
        {issue.status.name}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[10px]",
          tone === "warn" ? "text-danger" : "text-muted-foreground",
        )}
      >
        {relativeTime(issue.updatedAt)}
      </span>
    </li>
  );
}

function WorkspaceBadge({ slug, wsKey }: { slug: string; wsKey: string }) {
  const c = workspaceColor(wsKey);
  return (
    <Link
      href={`/w/${slug}/dashboard`}
      className="grid h-5 w-5 shrink-0 place-items-center rounded-sm font-mono text-[9px] font-semibold"
      style={{
        backgroundColor: c.bg,
        color: c.fg,
        boxShadow: `inset 0 0 0 1px ${c.ring}`,
      }}
      title={wsKey}
    >
      {wsKey.slice(0, 2)}
    </Link>
  );
}
