"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  Check,
  Clock,
  FileText,
  Inbox,
  Loader2,
  Shield,
  Sparkles,
  Target,
  Workflow,
  X,
} from "lucide-react";
import type { Role } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";

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
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <SkeletonList rows={6} />
        ) : !data ? (
          <EmptyState
            variant="page"
            title="Nothing to load"
            description="The command center couldn't fetch its summary."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Section
              icon={<Inbox className="h-3.5 w-3.5" />}
              title="Asks for you"
              empty="Nothing waiting on you."
              count={data.actionRequests.length}
            >
              {data.actionRequests.map((row) => (
                <ActionRequestDecisionCard
                  key={row.id}
                  request={row}
                  slug={ws.slug}
                  onResolved={() => dropActionRequest(row.id)}
                />
              ))}
            </Section>

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
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{row.title}</span>
                    <span className="shrink-0 rounded bg-subtle px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {row.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-meta text-muted-foreground">
                    <span className="truncate">
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
              icon={<Shield className="h-3.5 w-3.5" />}
              title="Review gates"
              empty="No pending gates."
              count={data.reviewGates.length}
            >
              {data.reviewGates.map((row) => (
                <ReviewGateDecisionCard
                  key={row.id}
                  gate={row}
                  slug={ws.slug}
                  onResolved={() => dropReviewGate(row.id)}
                />
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
                  <div className="flex items-center gap-2">
                    <Bot className="h-3 w-3 text-ember" />
                    <span className="text-sm font-medium">
                      @{row.agent.profileKey}
                    </span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground truncate">
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
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              title="Stalled runs"
              empty="No stalled runs."
              count={data.stalledRuns.length}
              tone="warning"
            >
              {data.stalledRuns.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/i/${row.issue.workspace.key}-${row.issue.number}`}
                  className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-2 hover:border-warning"
                >
                  <span className="text-sm font-medium">
                    {row.issue.workspace.key}-{row.issue.number}
                  </span>
                  <span className="text-meta text-muted-foreground">
                    @{row.agent.profileKey} · last event {new Date(row.lastEventAt).toLocaleString()}
                  </span>
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
                  <div className="flex items-center justify-between gap-2">
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
      <div className="flex items-start justify-between gap-2">
        {request.issue ? (
          <Link
            href={`/w/${slug}/i/${request.issue.workspace.key}-${request.issue.number}`}
            className="text-sm font-medium hover:underline"
          >
            {request.title}
          </Link>
        ) : (
          <span className="text-sm font-medium">{request.title}</span>
        )}
        <SeverityChip severity={request.severity} />
      </div>
      {request.body ? (
        <p className="line-clamp-2 text-meta text-muted-foreground">{request.body}</p>
      ) : null}
      {request.issue ? (
        <span className="text-meta text-muted-foreground">
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
          <div className="flex gap-2">
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
          <div className="flex gap-2">
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
        <div className="flex gap-2 pt-0.5">
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
        </div>
      )}
    </div>
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
          <div className="flex gap-2">
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
        <div className="flex gap-2 pt-0.5">
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
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  count: number;
  tone?: "warning";
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2 text-meta uppercase tracking-wide text-muted-foreground">
        <div className="flex items-center gap-1.5">
          {icon}
          {title}
        </div>
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
      </header>
      <div className="flex flex-col gap-2">
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
