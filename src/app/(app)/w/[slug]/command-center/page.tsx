"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  Check,
  CircleDot,
  Clock,
  Eraser,
  FileText,
  Inbox,
  Loader2,
  ShieldCheck,
  Sparkles,
  StopCircle,
  Target,
  Workflow,
  X,
} from "lucide-react";
import type { Role } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/modal";
import { EmptyState, SkeletonList } from "@/components/ui";
import { AgentAttentionPanel } from "@/components/agent-attention-panel";
import { WorkspaceActivityTimeline } from "@/components/workspace-activity-timeline";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";

/**
 * Command Center — the operator's **decisions + live agent operations**
 * surface. It is the canonical place to *act on decisions*: action
 * requests (asks) and review gates are resolved inline here, not just
 * deep-linked. Alongside those it shows the live operational picture —
 * goals the crews are driving, active and stalled agent runs, issues
 * due soon, recent artifacts, and the running timer.
 *
 * This is intentionally complementary to the **Inbox**, which is "your
 * work" (assigned/unblocked issues, @-mentions, things you're watching,
 * stalled work). The Inbox does not surface action requests or review
 * gates as a decision affordance — those live here so there's exactly
 * one place to make a call.
 *
 * Realtime: subscribes to the workspace SSE bus and invalidates the
 * single `commandCenter.summary` query when a decision or run-lifecycle
 * event arrives, so an ask resolved elsewhere (or a run that completes)
 * refreshes without polling. Inline actions additionally do an
 * optimistic remove for instant feedback.
 */
export default function CommandCenterPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const canRecoverRuns = ws.role === ("OWNER" as Role) || ws.role === ("ADMIN" as Role);
  const summaryInput = { dueWindowDays: 7, limit: 20 } as const;
  const { data, isLoading } = trpc.commandCenter.summary.useQuery(summaryInput);

  // Realtime fan-out. The summary stitches together action requests,
  // review gates, goals, and agent runs — invalidate on the events that
  // reshape any of those. Action-request + review-gate resolutions and
  // goal transitions all surface as ISSUE_UPDATED with a distinguishing
  // `subjectType`, so we key off subjectType for those and off the
  // AGENT_RUN_* kind family for run lifecycle. Broad but not a firehose:
  // pure ISSUE_* edits that don't touch a CC surface are ignored unless
  // they carry one of these subject types.
  useRealtime((evt) => {
    const k = evt.kind ?? "";
    const subject = evt.subjectType ?? "";
    const relevant =
      subject === "action-request" ||
      subject === "review-gate" ||
      subject === "agent-run" ||
      subject === "goal" ||
      k.startsWith("AGENT_RUN_") ||
      k === "GOAL_CREATED" ||
      k === "GOAL_STATUS_CHANGED";
    if (!relevant) return;
    void utils.commandCenter.summary.invalidate();
    void utils.commandCenter.decisionsCount.invalidate();
  });

  // Optimistic helpers — drop an acted-on decision from the cached
  // summary so the card disappears immediately, before the realtime
  // invalidation lands. `invalidate()` in the mutation's onSettled
  // reconciles with the server.
  const dropActionRequest = (id: string) => {
    const prev = utils.commandCenter.summary.getData(summaryInput);
    if (!prev) return;
    utils.commandCenter.summary.setData(summaryInput, {
      ...prev,
      actionRequests: prev.actionRequests.filter((r) => r.id !== id),
      counts: { ...prev.counts, actionRequests: Math.max(0, prev.counts.actionRequests - 1) },
    });
  };
  const dropReviewGate = (id: string) => {
    const prev = utils.commandCenter.summary.getData(summaryInput);
    if (!prev) return;
    utils.commandCenter.summary.setData(summaryInput, {
      ...prev,
      reviewGates: prev.reviewGates.filter((r) => r.id !== id),
      counts: { ...prev.counts, reviewGates: Math.max(0, prev.counts.reviewGates - 1) },
    });
  };
  const dropRunFailures = (ids: string[]) => {
    const prev = utils.commandCenter.summary.getData(summaryInput);
    if (!prev) return;
    const drop = new Set(ids);
    const stalledRuns = prev.stalledRuns.filter((r) => !drop.has(r.id));
    utils.commandCenter.summary.setData(summaryInput, {
      ...prev,
      stalledRuns,
      counts: { ...prev.counts, stalledRuns: stalledRuns.length },
    });
  };
  const recoverRuns = trpc.agentRun.recoverMany.useMutation({
    onMutate: ({ runIds }) => dropRunFailures(runIds),
    onError: (e) => {
      toast.error(e.message);
      void utils.commandCenter.summary.invalidate();
    },
    onSuccess: (result) => {
      if (result.changed > 0) {
        const verb =
          result.action === "ABANDON"
            ? "abandoned"
            : result.action === "RECONCILE"
              ? "reconciled"
              : "cleared";
        toast.success(`${result.changed} run${result.changed === 1 ? "" : "s"} ${verb}.`);
      }
    },
    onSettled: () => {
      void utils.commandCenter.summary.invalidate();
      void utils.agentRun.list.invalidate();
    },
  });
  const attentionCount = data
    ? data.actionRequests.length + data.reviewGates.length + data.stalledRuns.length
    : 0;

  return (
    <>
      <Topbar
        title="Command Center"
        subtitle={
          data
            ? `Decisions & live agent ops · ${data.counts.actionRequests} asks · ${data.counts.reviewGates} gates · ${data.counts.activeRuns} active runs`
            : "Decisions & live agent ops"
        }
      />
      {/* Ambient background now lives once in the app shell <main>
          (.forge-page-bg) — previously this page mounted the grid on the
          scroll container itself, so it only covered the first viewport. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        {isLoading ? (
          <SkeletonList rows={6} />
        ) : !data ? (
          <EmptyState
            variant="page"
            title="Nothing to load"
            description="The command center couldn't fetch its summary."
          />
        ) : (
          <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
            <div className="min-w-0 space-y-4">
              <Section
                icon={<Inbox className="h-3.5 w-3.5" />}
                title="Attention queue"
                empty="Nothing waiting on you."
                count={attentionCount}
                className="min-w-0"
                bodyClassName="p-0"
              >
                <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-3">
                  <AttentionGroup
                    title="Asks"
                    count={data.actionRequests.length}
                    empty="No agent asks."
                  >
                    {data.actionRequests.map((row) => (
                      <ActionRequestDecisionCard
                        key={row.id}
                        request={row}
                        slug={ws.slug}
                        onResolved={() => dropActionRequest(row.id)}
                      />
                    ))}
                  </AttentionGroup>
                  <AttentionGroup
                    title="Stalled runs"
                    count={data.stalledRuns.length}
                    empty="No recoverable runs."
                    action={
                      data.stalledRuns.length > 0 && canRecoverRuns ? (
                        <RunRecoveryBulkActions
                          runs={data.stalledRuns}
                          pending={recoverRuns.isPending}
                          onRecover={(action, runIds) => recoverRuns.mutate({ action, runIds })}
                        />
                      ) : null
                    }
                  >
                    {data.stalledRuns.map((row) => (
                      <RunFailureCard
                        key={row.id}
                        run={row}
                        slug={ws.slug}
                        canRecover={canRecoverRuns}
                        pending={recoverRuns.isPending}
                        onRecover={(action) => recoverRuns.mutate({ action, runIds: [row.id] })}
                      />
                    ))}
                  </AttentionGroup>
                  <AttentionGroup
                    title="Review gates"
                    count={data.reviewGates.length}
                    empty="No review gates."
                  >
                    {data.reviewGates.map((row) => (
                      <ReviewGateDecisionCard
                        key={row.id}
                        gate={row}
                        slug={ws.slug}
                        onResolved={() => dropReviewGate(row.id)}
                      />
                    ))}
                  </AttentionGroup>
                </div>
              </Section>

              <AgentAttentionPanel
                slug={ws.slug}
                showEmpty
                limit={6}
                itemLimit={2}
                bodyClassName="max-h-[24rem] overflow-y-auto"
              />

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Section
              icon={<Target className="h-3.5 w-3.5" />}
              title="Live goals"
              empty="No goals running."
              count={data.liveGoals.length}
            >
              {data.liveGoals.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/goals/${row.id}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{row.title}</span>
                    <span className="shrink-0 rounded bg-subtle px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {row.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-meta text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">
                      {row.crew ? `${row.crew.name} · ` : ""}
                      {row._count.plans} plan{row._count.plans === 1 ? "" : "s"}
                    </span>
                    {row.maxTotalCostUsd != null && (
                      <span className="ml-auto shrink-0 font-mono tabular-nums">
                        ${row.totalCostUsd.toFixed(2)} / ${row.maxTotalCostUsd.toFixed(2)}
                      </span>
                    )}
                  </div>
                  {row.maxTotalCostUsd != null && row.maxTotalCostUsd > 0 && (
                    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-subtle">
                      <div
                        className="h-full rounded-full bg-ember"
                        style={{
                          width: `${Math.min(100, (row.totalCostUsd / row.maxTotalCostUsd) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {row.totalSteps > 0 && (
                    <>
                      <div className="flex items-center justify-between text-meta text-muted-foreground">
                        <span>steps</span>
                        <span className="font-mono tabular-nums">
                          {row.doneSteps}/{row.totalSteps} steps
                        </span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-subtle">
                        <div
                          className="h-full rounded-full bg-ember"
                          style={{
                            width: `${Math.min(100, (row.doneSteps / row.totalSteps) * 100)}%`,
                          }}
                        />
                      </div>
                    </>
                  )}
                </Link>
              ))}
            </Section>

            <Section
              icon={<Workflow className="h-3.5 w-3.5" />}
              title="Active runs"
              empty="No agents running."
              count={data.activeRuns.length}
            >
              {data.activeRuns.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/i/${row.issue.workspace.key}-${row.issue.number}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Bot className="h-3 w-3 text-ember" />
                    <span className="text-sm font-medium">
                      @{row.agent.profileKey}
                    </span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="min-w-0 truncate text-sm text-muted-foreground">
                      {row.issue.workspace.key}-{row.issue.number}
                    </span>
                  </div>
                  {row.currentStep ? (
                    <span className="text-meta text-muted-foreground">
                      {row.currentStep}
                    </span>
                  ) : null}
                </Link>
              ))}
            </Section>

            <Section
              icon={<CalendarClock className="h-3.5 w-3.5" />}
              title="Due soon"
              empty="Nothing due in the next week."
              count={data.dueIssues.length}
            >
              {data.dueIssues.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/i/${row.workspace.key}-${row.number}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{row.title}</span>
                    <PriorityChip priority={row.priority} />
                  </div>
                  <span className="text-meta text-muted-foreground">
                    {row.workspace.key}-{row.number} · due {row.dueDate ? new Date(row.dueDate).toLocaleDateString() : "—"}
                  </span>
                </Link>
              ))}
            </Section>

            <Section
              icon={<FileText className="h-3.5 w-3.5" />}
              title="Recent artifacts"
              empty="No artifacts yet."
              count={data.recentArtifacts.length}
            >
              {data.recentArtifacts.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/artifacts/${row.slug}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <span className="text-sm font-medium">{row.title}</span>
                  <span className="text-meta text-muted-foreground">
                    {row.type.toLowerCase()} · {row.status.replace("_", " ").toLowerCase()}
                  </span>
                </Link>
              ))}
            </Section>

            {data.runningTimer && data.runningTimer.issue ? (
              <Section
                icon={<Clock className="h-3.5 w-3.5" />}
                title="Timer"
                empty=""
                count={1}
              >
                <Link
                  href={`/w/${ws.slug}/i/${data.runningTimer.issue.workspace.key}-${data.runningTimer.issue.number}`}
                  className="flex flex-col gap-1 rounded-md border border-ember/40 bg-ember/5 p-2 hover:border-ember"
                >
                  <span className="text-sm font-medium">
                    {data.runningTimer.issue.workspace.key}-{data.runningTimer.issue.number}
                  </span>
                  <span className="text-meta text-muted-foreground">
                    Started {new Date(data.runningTimer.startedAt).toLocaleTimeString()}
                  </span>
                </Link>
              </Section>
            ) : null}
            </div>
          </div>
          <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            <WorkspaceActivityTimeline
              limit={20}
              defaultFilter="decisions"
              className="min-w-0"
              bodyClassName="max-h-[42rem] overflow-y-auto xl:max-h-[calc(100svh-14rem)]"
            />
          </aside>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline decision cards. Command Center is the canonical place to *act* on
// decisions, so action-request asks and review gates resolve here rather
// than only deep-linking. Both use the same mutations the canonical detail
// surfaces use (`actionRequest.accept/.decline`, `reviewGate.resolve`) and
// optimistically drop the acted item via `onResolved`; the realtime
// invalidation reconciles with the server.
// ---------------------------------------------------------------------------

type CCActionRequest = {
  id: string;
  title: string;
  body: string | null;
  severity: string;
  /** ActionRequestKind — FREE_FORM asks need an answer, not just Accept. */
  kind: string;
  issue: {
    id: string;
    number: number;
    title: string;
    workspace: { slug: string; key: string };
  } | null;
  requestedByAgent: {
    profileKey: string;
    name?: string | null;
    avatar?: string | null;
  } | null;
  requestedByUser: { name: string | null } | null;
};

function ActionRequestDecisionCard({
  request,
  slug,
  onResolved,
}: {
  request: CCActionRequest;
  slug: string;
  onResolved: () => void;
}) {
  const utils = trpc.useUtils();
  const [showDecline, setShowDecline] = useState(false);
  const [reason, setReason] = useState("");
  // FREE_FORM asks are the agent asking *us* for info — the primary
  // action is to answer, not a bare Accept (which delivers nothing).
  const needsAnswer = request.kind === "FREE_FORM";
  const [showRespond, setShowRespond] = useState(false);
  const [answer, setAnswer] = useState("");
  // Operator can move the linked issue's status straight from the ask —
  // e.g. the agent blocked asking a question, but you've decided the
  // issue is actually Done. This is independent of Accept/Decline: it
  // does NOT resolve the ask or record a decline resolution, it just
  // transitions the issue (which closes any active runs on DONE/CANCELED).
  const [showStatus, setShowStatus] = useState(false);

  const settle = () => {
    void utils.commandCenter.summary.invalidate();
    void utils.commandCenter.decisionsCount.invalidate();
    if (request.issue) {
      // Accept may dispatch a status/label/assign change on the issue.
      void utils.inbox.get.invalidate();
    }
  };

  const accept = trpc.actionRequest.accept.useMutation({
    onMutate: () => onResolved(),
    onError: (e) => {
      toast.error(e.message);
      void utils.commandCenter.summary.invalidate();
    },
    onSuccess: () => toast.success("Accepted."),
    onSettled: settle,
  });
  const decline = trpc.actionRequest.decline.useMutation({
    onMutate: () => onResolved(),
    onError: (e) => {
      toast.error(e.message);
      void utils.commandCenter.summary.invalidate();
    },
    onSuccess: () => toast.success("Declined."),
    onSettled: settle,
  });

  const pending = accept.isPending || decline.isPending;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card/40 p-2">
      {request.requestedByAgent ? (
        <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
          <span
            aria-hidden
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-subtle text-[0.625rem]"
            title={request.requestedByAgent.name ?? request.requestedByAgent.profileKey}
          >
            {request.requestedByAgent.avatar ?? (
              <Bot className="h-2.5 w-2.5 text-muted-foreground" />
            )}
          </span>
          <span className="text-id text-muted-foreground">
            @{request.requestedByAgent.profileKey}
          </span>
          <span className="text-muted-foreground/70">asks</span>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        {request.issue ? (
          <Link
            href={`/w/${slug}/i/${request.issue.workspace.key}-${request.issue.number}`}
            className="min-w-0 flex-1 text-sm font-medium hover:underline"
          >
            {request.title}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 text-sm font-medium">{request.title}</span>
        )}
        <SeverityChip severity={request.severity} />
      </div>
      {request.body ? (
        <p className="line-clamp-2 text-meta text-muted-foreground">{request.body}</p>
      ) : null}
      {request.issue ? (
        <span className="text-meta break-words text-muted-foreground">
          {request.issue.workspace.key}-{request.issue.number} · {request.issue.title}
        </span>
      ) : null}
      {showDecline ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={2_000}
            className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-meta"
            aria-label="Decline reason"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => decline.mutate({ id: request.id, reason: reason || null })}
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              Decline
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setShowDecline(false);
                setReason("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : showRespond ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          <textarea
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={`Answer ${request.requestedByAgent?.profileKey ? `@${request.requestedByAgent.profileKey}` : "the agent"}…`}
            maxLength={10_000}
            rows={3}
            className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-meta"
            aria-label="Answer"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ember"
              disabled={pending || !answer.trim()}
              onClick={() => accept.mutate({ id: request.id, resolution: answer.trim() })}
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Send answer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setShowRespond(false);
                setAnswer("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {needsAnswer ? (
            <Button
              size="sm"
              variant="ember"
              disabled={pending}
              onClick={() => setShowRespond(true)}
              aria-label="Respond to this ask"
            >
              <Sparkles className="h-3 w-3" />
              Respond
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ember"
              disabled={pending}
              onClick={() => accept.mutate({ id: request.id })}
              aria-label="Accept this ask"
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Accept
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setShowDecline(true)}
            aria-label="Decline this ask"
          >
            Decline
          </Button>
          {request.issue ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setShowStatus(true)}
              aria-label="Set the linked issue's status"
              title="Move the linked issue to another status without resolving this ask"
            >
              <CircleDot className="h-3 w-3" />
              Set status…
            </Button>
          ) : null}
        </div>
      )}
      {request.issue ? (
        <IssueStatusPicker
          issueId={request.issue.id}
          open={showStatus}
          onOpenChange={setShowStatus}
        />
      ) : null}
    </div>
  );
}

/**
 * Inline status picker for the linked issue of an ask. Reuses the
 * shared `Picker` (command-palette chooser) and drives `issue.update`
 * with the chosen `statusId`. Transitioning to a terminal status
 * (DONE/CANCELED) closes the issue's active runs server-side — see
 * `issue.ts` `finishRunsForIssue`. Deliberately does NOT touch the
 * ActionRequest: the ask stays open for a separate Accept/Decline, so
 * marking an issue Done never writes a decline resolution.
 */
function IssueStatusPicker({
  issueId,
  open,
  onOpenChange,
}: {
  issueId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: statuses, isLoading } = trpc.status.list.useQuery(undefined, {
    enabled: open,
  });
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items = (statuses ?? []).filter(
    (s) => !q || s.name.toLowerCase().includes(q),
  );

  const update = trpc.issue.update.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (_d, vars) => {
      const name = statuses?.find((s) => s.id === vars.statusId)?.name;
      toast.success(name ? `Moved to ${name}.` : "Issue status updated.");
    },
    onSettled: () => {
      void utils.commandCenter.summary.invalidate();
      void utils.commandCenter.decisionsCount.invalidate();
      void utils.inbox.get.invalidate();
    },
  });

  return (
    <Picker
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Move issue to status…"
      items={items}
      getKey={(s) => s.id}
      onQueryChange={setQuery}
      loading={isLoading}
      emptyLabel="No statuses match."
      onSelect={(s) => {
        onOpenChange(false);
        update.mutate({ id: issueId, statusId: s.id });
      }}
      renderItem={(s) => (
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: s.color }}
          />
          <span className="truncate">{s.name}</span>
          <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
            {s.category.toLowerCase().replace(/_/g, " ")}
          </span>
        </div>
      )}
    />
  );
}

type CCReviewGate = {
  id: string;
  prompt: string;
  targetType: string;
  targetId: string;
};

function ReviewGateDecisionCard({
  gate,
  slug,
  onResolved,
}: {
  gate: CCReviewGate;
  slug: string;
  onResolved: () => void;
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  // reviewGate.resolve is an adminProcedure — only OWNER/ADMIN can act
  // inline. Everyone else still gets the deep link to inspect the target.
  const canResolve = ws.role === ("OWNER" as Role) || ws.role === ("ADMIN" as Role);
  const href = gateTargetHref(slug, gate.targetType, gate.targetId);
  const [showResolution, setShowResolution] = useState(false);
  const [resolution, setResolution] = useState("");

  const resolve = trpc.reviewGate.resolve.useMutation({
    onMutate: () => onResolved(),
    onError: (e) => {
      toast.error(e.message);
      void utils.commandCenter.summary.invalidate();
    },
    onSuccess: () => toast.success("Gate resolved."),
    onSettled: () => {
      void utils.commandCenter.summary.invalidate();
      void utils.commandCenter.decisionsCount.invalidate();
      void utils.reviewGate.list.invalidate();
    },
  });

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card/40 p-2">
      <div className="flex flex-col gap-0.5">
        {href ? (
          <Link href={href} className="text-sm font-medium hover:underline">
            {gate.prompt.slice(0, 80)}
          </Link>
        ) : (
          <span className="text-sm font-medium">{gate.prompt.slice(0, 80)}</span>
        )}
        <span className="text-meta text-muted-foreground">
          {gate.targetType.replace(/-/g, " ")}
          {href ? "" : ` · ${gate.targetId.slice(0, 12)}…`}
        </span>
      </div>
      {!canResolve ? (
        <span className="text-meta italic text-muted-foreground">
          Awaiting an authorized reviewer.
        </span>
      ) : showResolution ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          <input
            autoFocus
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Resolution note (optional)"
            maxLength={10_000}
            className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-meta"
            aria-label="Resolution note"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ember"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({ id: gate.id, decision: "APPROVED", resolution: resolution || null })
              }
            >
              {resolve.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({ id: gate.id, decision: "REJECTED", resolution: resolution || null })
              }
            >
              <X className="h-3 w-3" />
              Reject
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={resolve.isPending}
              onClick={() => {
                setShowResolution(false);
                setResolution("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-0.5">
          <Button
            size="sm"
            variant="ember"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ id: gate.id, decision: "APPROVED", resolution: null })}
          >
            <Check className="h-3 w-3" /> Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => setShowResolution(true)}
          >
            Reject…
          </Button>
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  empty,
  count,
  tone,
  action,
  className,
  bodyClassName,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  count: number;
  tone?: "warning";
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-col rounded-lg border border-border bg-card/40",
        className,
      )}
    >
      <header className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-meta uppercase tracking-wide text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {action}
          {count > 0 ? (
            <span
              className={
                tone === "warning"
                  ? "inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning"
                  : "inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[10px]"
              }
            >
              {count}
            </span>
          ) : null}
        </div>
      </header>
      <div className={cn("flex min-h-0 flex-col gap-2 p-3", bodyClassName)}>
        {count === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card/20 p-3 text-meta text-muted-foreground">
            {empty}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function AttentionGroup({
  title,
  count,
  empty,
  action,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-h-0 rounded-md border border-border bg-background/35">
      <header className="flex min-w-0 items-center gap-2 border-b border-border/70 px-3 py-2">
        <span className="truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">
          {count}
        </span>
        {action ? <span className="ml-auto flex shrink-0 items-center gap-1">{action}</span> : null}
      </header>
      <div className="max-h-[22rem] min-h-0 space-y-2 overflow-y-auto p-2">
        {count === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card/20 p-3 text-meta text-muted-foreground">
            {empty}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

type CCRunFailure = {
  id: string;
  status: string;
  summary: string | null;
  currentStep: string | null;
  lastEventAt: Date | string;
  finishedAt: Date | string | null;
  recoveryReason: string;
  recoveryTitle: string;
  recoveryDetail: string;
  recommendedAction: "ABANDON" | "CLEAR" | "RECONCILE";
  availableActions: Array<"ABANDON" | "CLEAR" | "RECONCILE">;
  agent: { profileKey: string };
  issue: {
    id: string;
    number: number;
    title: string;
    workspace: { key: string };
  };
};

function recoveryActionLabel(action: CCRunFailure["recommendedAction"]): string {
  if (action === "ABANDON") return "Abandon";
  if (action === "RECONCILE") return "Reconcile";
  return "Clear";
}

function recoveryActionIcon(action: CCRunFailure["recommendedAction"]) {
  if (action === "ABANDON") return StopCircle;
  if (action === "RECONCILE") return ShieldCheck;
  return Eraser;
}

function RunRecoveryBulkActions({
  runs,
  pending,
  onRecover,
}: {
  runs: CCRunFailure[];
  pending: boolean;
  onRecover: (action: CCRunFailure["recommendedAction"], runIds: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {(["ABANDON", "RECONCILE", "CLEAR"] as const).map((action) => {
        const runIds = runs
          .filter((run) => run.availableActions.includes(action))
          .map((run) => run.id);
        if (runIds.length === 0) return null;
        const Icon = recoveryActionIcon(action);
        return (
          <Button
            key={action}
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[0.6875rem] normal-case tracking-normal"
            disabled={pending}
            onClick={() => onRecover(action, runIds)}
            title={`${recoveryActionLabel(action)} ${runIds.length} run${runIds.length === 1 ? "" : "s"}`}
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
            {recoveryActionLabel(action)} {runIds.length}
          </Button>
        );
      })}
    </div>
  );
}

function RunFailureCard({
  run,
  slug,
  canRecover,
  pending,
  onRecover,
}: {
  run: CCRunFailure;
  slug: string;
  canRecover: boolean;
  pending: boolean;
  onRecover: (action: CCRunFailure["recommendedAction"]) => void;
}) {
  const ts = run.finishedAt ?? run.lastEventAt;
  const excerpt = run.recoveryDetail ?? run.summary ?? run.currentStep ?? run.issue.title;
  const ActionIcon = recoveryActionIcon(run.recommendedAction);
  return (
    <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 hover:border-warning">
      <Link
        href={`/w/${slug}/issues/${run.issue.id}`}
        className="min-w-0 flex-1"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {run.issue.workspace.key}-{run.issue.number}
          </span>
          <span className="rounded bg-warning/10 px-1 py-0.5 text-[10px] uppercase text-warning">
            {run.recoveryReason.replace("-", " ")}
          </span>
        </div>
        <span className="text-meta block font-medium text-foreground/80">
          {run.recoveryTitle}
        </span>
        <span className="text-meta line-clamp-2 text-muted-foreground">
          @{run.agent.profileKey} · {new Date(ts).toLocaleString()} · {excerpt}
        </span>
      </Link>
      {canRecover ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-muted-foreground"
          disabled={pending}
          onClick={() => onRecover(run.recommendedAction)}
          title={`${recoveryActionLabel(run.recommendedAction)} this run from operational queues`}
          aria-label={`${recoveryActionLabel(run.recommendedAction)} run`}
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ActionIcon className="h-3 w-3" />}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Resolve a review-gate target to a deep link where it can be acted on.
 * Returns null for target types we can't route from id alone (e.g. a
 * bare execution-step, which has no standalone page) — those render as
 * plain text.
 */
function gateTargetHref(
  slug: string,
  targetType: string,
  targetId: string,
): string | null {
  switch (targetType) {
    case "execution-plan":
      return `/w/${slug}/plans/${targetId}`;
    case "goal":
      return `/w/${slug}/goals/${targetId}`;
    case "issue":
      return `/w/${slug}/issues/${targetId}`;
    default:
      return null;
  }
}

function SeverityChip({ severity }: { severity: string }) {
  const tone =
    severity === "CRITICAL"
      ? "bg-destructive/20 text-destructive"
      : severity === "ERROR"
        ? "bg-destructive/10 text-destructive"
        : severity === "WARNING"
          ? "bg-warning/10 text-warning"
          : severity === "SUCCESS"
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-subtle text-muted-foreground";
  return (
    <span className={`rounded px-1 py-0.5 text-[10px] uppercase ${tone}`}>
      {severity.toLowerCase()}
    </span>
  );
}

function PriorityChip({ priority }: { priority: string }) {
  if (priority === "NONE") return null;
  const tone =
    priority === "URGENT"
      ? "bg-destructive/15 text-destructive"
      : priority === "HIGH"
        ? "bg-warning/15 text-warning"
        : "bg-subtle text-muted-foreground";
  return (
    <span className={`rounded px-1 py-0.5 text-[10px] uppercase ${tone}`}>
      {priority.toLowerCase()}
    </span>
  );
}
