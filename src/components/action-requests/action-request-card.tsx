"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  CheckCircle2,
  Sparkles,
  AlertTriangle,
  AlertOctagon,
  XCircle,
  Loader2,
  ShieldCheck,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import type {
  ActionRequestKind,
  ActionRequestStatus,
  NotificationSeverity,
  Role,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import { useConfirm } from "@/components/ui/modal";

/**
 * Inline ActionRequest card rendered above an agent comment. Reads
 * the bound row via `actionRequest.forComment`, renders kind-specific
 * summary chips, and exposes Accept / Decline mutations.
 *
 * Visual language:
 *   - OPEN     → severity-toned border + accent.
 *   - RESOLVED → dimmed paper card, green check, "Accepted by … Ns ago".
 *   - REJECTED → dimmed paper card, red X, "Declined by …: reason".
 *   - SNOOZED / DISMISSED → muted neutral, no buttons.
 *
 * Permission gate matches the server: visible Accept/Decline buttons
 * only when role ∈ {OWNER, ADMIN} OR the user is on the issue's
 * assignees/watchers list (signal passed in via `canResolve`).
 */
export type ActionRequestCardProps =
  | ActionRequestCardCommentProps
  | ActionRequestCardPlanProps
  | ActionRequestCardDirectProps;

interface ActionRequestCardCommentProps {
  /** Comment row's id — the bound ActionRequest is fetched by this. */
  commentId: string;
  planId?: never;
  /**
   * Caller-supplied permission signal. Lets the parent (issue page)
   * fold in assignee/watcher membership without this card hitting tRPC
   * for it. OWNER/ADMIN role is computed inside via `useWorkspace`.
   */
  canResolve?: boolean;
  /**
   * Issue id — used for cache invalidation after Accept dispatches a
   * status / labels / assign mutation so the rest of the page picks
   * up the new state.
   */
  issueId: string;
}

interface ActionRequestCardPlanProps {
  /**
   * Execution plan id — the bound approval ActionRequest is fetched via
   * `actionRequest.forPlan`. Used by the plan cockpit so Accept fires
   * the proper activation path (DRAFT→RUNNING + goal→ACTIVE + crew
   * kickoff) instead of a direct status flip.
   */
  planId: string;
  commentId?: never;
  issueId?: never;
  canResolve?: boolean;
  /** Fired after a successful Accept/Decline so the page can refresh. */
  onResolved?: () => void;
}

interface ActionRequestCardDirectProps {
  /** Render an issue-bound request that was not created from a comment. */
  requestId: string;
  commentId?: never;
  planId?: never;
  issueId: string;
  canResolve?: boolean;
  onResolved?: () => void;
}

export function ActionRequestCard(props: ActionRequestCardProps) {
  if ("requestId" in props && props.requestId) {
    return <ActionRequestCardForRequest {...props} />;
  }
  if ("planId" in props && props.planId) {
    return <ActionRequestCardForPlan {...props} />;
  }
  return <ActionRequestCardForComment {...(props as ActionRequestCardCommentProps)} />;
}

function ActionRequestCardForRequest({
  requestId,
  issueId,
  canResolve,
  onResolved,
}: ActionRequestCardDirectProps) {
  const utils = trpc.useUtils();
  const ws = useWorkspace();
  const isAdmin = ws.role === ("OWNER" as Role) || ws.role === ("ADMIN" as Role);
  const visibleCanResolve = canResolve || isAdmin;
  const { data: request, isLoading } = trpc.actionRequest.get.useQuery(
    { id: requestId },
    { staleTime: 30_000 },
  );
  const [showDeclineReason, setShowDeclineReason] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const autoRefreshStarted = useRef(false);
  const refreshEvidence = trpc.actionRequest.refreshCompletionEvidence.useMutation();
  useRealtime((event) => {
    if (event.subjectType !== "action-request" || event.subjectId !== requestId) return;
    void utils.actionRequest.get.invalidate({ id: requestId });
  });
  useEffect(() => {
    if (!request || autoRefreshStarted.current || !completionNeedsRefresh(request.payload)) return;
    autoRefreshStarted.current = true;
    refreshEvidence.mutate({ id: requestId });
  }, [request, requestId, refreshEvidence]);
  useEffect(() => {
    const refreshOnFocus = () => {
      const current = utils.actionRequest.get.getData({ id: requestId });
      if (current && completionNeedsRefresh(current.payload)) {
        refreshEvidence.mutate({ id: requestId });
      }
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refreshEvidence, requestId, utils]);
  const settle = () => {
    void utils.actionRequest.get.invalidate({ id: requestId });
    void utils.actionRequest.list.invalidate();
    void utils.issue.byId.invalidate({ id: issueId });
    void utils.commandCenter.summary.invalidate();
    void utils.commandCenter.decisionsCount.invalidate();
    onResolved?.();
  };
  const accept = trpc.actionRequest.accept.useMutation({
    onError: (error) => toast.error(error.message),
    onSuccess: settle,
  });
  const decline = trpc.actionRequest.decline.useMutation({
    onError: (error) => toast.error(error.message),
    onSuccess: () => {
      setShowDeclineReason(false);
      setDeclineReason("");
      settle();
    },
  });

  if (isLoading || !request) return null;
  return (
    <ActionRequestCardView
      request={request}
      visibleCanResolve={visibleCanResolve}
      showDeclineReason={showDeclineReason}
      declineReason={declineReason}
      onDeclineReasonChange={setDeclineReason}
      onAccept={() => accept.mutate({ id: request.id })}
      onDecline={() => {
        if (!showDeclineReason) {
          setShowDeclineReason(true);
          return;
        }
        decline.mutate({ id: request.id, reason: declineReason || null });
      }}
      onCancelDecline={() => {
        setShowDeclineReason(false);
        setDeclineReason("");
      }}
      pending={accept.isPending || decline.isPending}
      refreshingEvidence={refreshEvidence.isPending}
      onRefreshEvidence={() =>
        refreshEvidence.mutate(
          { id: requestId },
          {
            onSuccess: ({ queued }) => {
              if (queued > 0) toast.success("Verification queued.");
              else toast.info("No linked GitHub pull request needs verification.");
            },
            onError: (error) => toast.error(error.message),
          },
        )
      }
      issueId={issueId}
      workspaceSlug={ws.slug}
    />
  );
}

function ActionRequestCardForComment({
  commentId,
  canResolve,
  issueId,
}: ActionRequestCardCommentProps) {
  const utils = trpc.useUtils();
  const ws = useWorkspace();
  const isAdmin = ws.role === ("OWNER" as Role) || ws.role === ("ADMIN" as Role);
  const visibleCanResolve = canResolve || isAdmin;

  const { data: request, isLoading } = trpc.actionRequest.forComment.useQuery(
    { commentId },
    { staleTime: 30_000 },
  );

  const [showDeclineReason, setShowDeclineReason] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const accept = trpc.actionRequest.accept.useMutation({
    // Optimistic flip: update the cached row so the buttons disappear
    // immediately and the resolved-banner replaces them. Rollback on
    // error happens in `onError`.
    onMutate: async () => {
      await utils.actionRequest.forComment.cancel({ commentId });
      const prev = utils.actionRequest.forComment.getData({ commentId });
      if (prev) {
        utils.actionRequest.forComment.setData(
          { commentId },
          {
            ...prev,
            status: "RESOLVED" as ActionRequestStatus,
            resolvedAt: new Date(),
            resolution: "Accepted",
          },
        );
      }
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) {
        utils.actionRequest.forComment.setData({ commentId }, ctx.prev);
      }
      toast.error(e.message);
    },
    onSuccess: () => {
      // Refresh the issue payload so the dispatched action (status flip,
      // labels, assignment, runtime grant) materializes everywhere.
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      utils.agentRun.activeForIssue.invalidate({ issueId });
      utils.actionRequest.forComment.invalidate({ commentId });
    },
  });

  const decline = trpc.actionRequest.decline.useMutation({
    onMutate: async () => {
      await utils.actionRequest.forComment.cancel({ commentId });
      const prev = utils.actionRequest.forComment.getData({ commentId });
      if (prev) {
        utils.actionRequest.forComment.setData(
          { commentId },
          {
            ...prev,
            status: "REJECTED" as ActionRequestStatus,
            resolvedAt: new Date(),
            resolution: declineReason ? `Declined: ${declineReason}` : "Declined",
          },
        );
      }
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) {
        utils.actionRequest.forComment.setData({ commentId }, ctx.prev);
      }
      toast.error(e.message);
    },
    onSuccess: () => {
      utils.actionRequest.forComment.invalidate({ commentId });
      setShowDeclineReason(false);
      setDeclineReason("");
    },
  });

  if (isLoading) return null;
  if (!request) return null;

  return (
    <ActionRequestCardView
      request={request}
      visibleCanResolve={visibleCanResolve}
      showDeclineReason={showDeclineReason}
      declineReason={declineReason}
      onDeclineReasonChange={setDeclineReason}
      onAccept={() => accept.mutate({ id: request.id })}
      onDecline={() => {
        if (!showDeclineReason) {
          setShowDeclineReason(true);
          return;
        }
        decline.mutate({ id: request.id, reason: declineReason || null });
      }}
      onCancelDecline={() => {
        setShowDeclineReason(false);
        setDeclineReason("");
      }}
      pending={accept.isPending || decline.isPending}
      issueId={issueId}
      workspaceSlug={ws.slug}
    />
  );
}

/**
 * Plan-cockpit variant. Fetches the bound approval ActionRequest via
 * `actionRequest.forPlan` and reuses the same Accept/Decline path —
 * Accepting runs the proper activation (DRAFT→RUNNING + goal→ACTIVE +
 * crew kickoff) server-side. Returns `null` when no row is bound so the
 * caller's direct-approve fallback can take over.
 */
function ActionRequestCardForPlan({ planId, canResolve, onResolved }: ActionRequestCardPlanProps) {
  const utils = trpc.useUtils();
  const ws = useWorkspace();
  const isAdmin = ws.role === ("OWNER" as Role) || ws.role === ("ADMIN" as Role);
  const visibleCanResolve = canResolve || isAdmin;

  const { data: request, isLoading } = trpc.actionRequest.forPlan.useQuery(
    { planId },
    { staleTime: 30_000 },
  );

  const [showDeclineReason, setShowDeclineReason] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const accept = trpc.actionRequest.accept.useMutation({
    onMutate: async () => {
      await utils.actionRequest.forPlan.cancel({ planId });
      const prev = utils.actionRequest.forPlan.getData({ planId });
      if (prev) {
        utils.actionRequest.forPlan.setData(
          { planId },
          {
            ...prev,
            status: "RESOLVED" as ActionRequestStatus,
            resolvedAt: new Date(),
            resolution: "Accepted",
          },
        );
      }
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) utils.actionRequest.forPlan.setData({ planId }, ctx.prev);
      toast.error(e.message);
    },
    onSuccess: () => {
      utils.actionRequest.forPlan.invalidate({ planId });
      onResolved?.();
    },
  });

  const decline = trpc.actionRequest.decline.useMutation({
    onMutate: async () => {
      await utils.actionRequest.forPlan.cancel({ planId });
      const prev = utils.actionRequest.forPlan.getData({ planId });
      if (prev) {
        utils.actionRequest.forPlan.setData(
          { planId },
          {
            ...prev,
            status: "REJECTED" as ActionRequestStatus,
            resolvedAt: new Date(),
            resolution: declineReason ? `Declined: ${declineReason}` : "Declined",
          },
        );
      }
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) utils.actionRequest.forPlan.setData({ planId }, ctx.prev);
      toast.error(e.message);
    },
    onSuccess: () => {
      utils.actionRequest.forPlan.invalidate({ planId });
      setShowDeclineReason(false);
      setDeclineReason("");
      onResolved?.();
    },
  });

  if (isLoading) return null;
  if (!request) return null;

  return (
    <ActionRequestCardView
      request={request}
      visibleCanResolve={visibleCanResolve}
      showDeclineReason={showDeclineReason}
      declineReason={declineReason}
      onDeclineReasonChange={setDeclineReason}
      onAccept={() => accept.mutate({ id: request.id })}
      onDecline={() => {
        if (!showDeclineReason) {
          setShowDeclineReason(true);
          return;
        }
        decline.mutate({ id: request.id, reason: declineReason || null });
      }}
      onCancelDecline={() => {
        setShowDeclineReason(false);
        setDeclineReason("");
      }}
      pending={accept.isPending || decline.isPending}
      workspaceSlug={ws.slug}
    />
  );
}

/**
 * Pure view layer — receives a fully-resolved row + callbacks. Split
 * out so the storybook / unit-test surface doesn't need a tRPC mock
 * to render the card.
 */
function ActionRequestCardView({
  request,
  visibleCanResolve,
  showDeclineReason,
  declineReason,
  onDeclineReasonChange,
  onAccept,
  onDecline,
  onCancelDecline,
  pending,
  refreshingEvidence,
  onRefreshEvidence,
  issueId,
  workspaceSlug,
}: {
  request: {
    id: string;
    title: string;
    body: string | null;
    status: ActionRequestStatus;
    severity: NotificationSeverity;
    kind: ActionRequestKind;
    payload: unknown;
    resolution: string | null;
    resolvedAt: Date | string | null;
    createdAt: Date | string;
    resolvedByUser?: { id: string; name: string | null; handle: string | null } | null;
    requestedByAgent?: { id: string; name: string; profileKey: string } | null;
    requestedByUser?: { id: string; name: string | null; handle: string | null } | null;
    sourceType?: string | null;
  };
  visibleCanResolve: boolean;
  showDeclineReason: boolean;
  declineReason: string;
  onDeclineReasonChange: (v: string) => void;
  onAccept: () => void;
  onDecline: () => void;
  onCancelDecline: () => void;
  pending: boolean;
  refreshingEvidence?: boolean;
  onRefreshEvidence?: () => void;
  issueId?: string;
  workspaceSlug: string;
}) {
  const isOpen = request.status === "OPEN";
  const isResolved = request.status === "RESOLVED";
  const isRejected = request.status === "REJECTED";
  const { confirm, confirmElement } = useConfirm();

  const tone = useMemo(() => severityToTone(request.severity), [request.severity]);
  const kindChip = useMemo(
    () => kindChipLabel(request.kind, request.payload),
    [request.kind, request.payload],
  );
  const runtimeGrant = useMemo(
    () =>
      request.kind === "RUNTIME_TOOL_GRANT" ? readRuntimeToolGrantPayload(request.payload) : null,
    [request.kind, request.payload],
  );
  const completion = useMemo(
    () => (request.kind === "TRANSITION" ? readCompletionTransitionPayload(request.payload) : null),
    [request.kind, request.payload],
  );
  const requesterName = request.requestedByAgent
    ? `@${request.requestedByAgent.profileKey}`
    : request.requestedByUser?.handle
      ? `@${request.requestedByUser.handle}`
      : (request.requestedByUser?.name ?? "system");
  const completionOverride =
    completion?.intent === "COMPLETE" && completion.assessment?.state !== "READY";

  const acceptWithConfirmation = async () => {
    if (completionOverride) {
      const ok = await confirm({
        title: "Mark done without verified evidence?",
        description: (
          <div className="space-y-2">
            <p>
              Forge has not confirmed every close-out check. This override will mark the issue done
              anyway.
            </p>
            {completion.autoHeldReasons.length > 0 && (
              <ul className="list-disc space-y-1 pl-4">
                {completion.autoHeldReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </div>
        ),
        primaryLabel: "Mark done anyway",
        secondaryLabel: "Keep reviewing",
        variant: "destructive",
      });
      if (!ok) return;
    }
    onAccept();
  };

  return (
    <>
      <div
        role="article"
        aria-label={`Action request: ${request.title}`}
        className={[
          "rounded-md border-y border-l-2 border-r p-3",
          "border-y-border border-r-border",
          isOpen ? tone.borderClass : "border-l-border/60",
          isOpen ? tone.bgClass : "bg-card/30",
          !isOpen ? "opacity-80" : "",
        ].join(" ")}
      >
        <div className="flex items-start gap-2">
          <span
            className={[
              "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
              isOpen ? tone.iconBgClass : "bg-muted/40",
            ].join(" ")}
          >
            {isResolved ? (
              <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />
            ) : isRejected ? (
              <XCircle className="h-3 w-3 text-danger" />
            ) : (
              tone.icon
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="text-meta flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-foreground">{request.title}</span>
              <Badge color="#6366f1" className="font-mono text-[0.625rem] uppercase tracking-wider">
                recommendation
              </Badge>
              {kindChip && (
                <span title={kindChip.title} className="inline-flex">
                  <Badge
                    color="#d97706"
                    className="font-mono text-[0.625rem] uppercase tracking-wider"
                  >
                    {kindChip.label}
                  </Badge>
                </span>
              )}
              <span className="text-muted-foreground">
                · {requesterName} · {relativeTime(request.createdAt)}
              </span>
            </div>
            {request.body && (
              <MarkdownWithAttachments
                body={request.body}
                className="text-[0.8125rem] text-foreground/90"
              />
            )}
            {runtimeGrant && <RuntimeToolGrantSummary grant={runtimeGrant} />}
            {completion && (
              <CompletionEvidenceSummary
                completion={completion}
                issueId={issueId}
                workspaceSlug={workspaceSlug}
                refreshing={refreshingEvidence}
                onRefresh={onRefreshEvidence}
              />
            )}

            {isOpen && visibleCanResolve && !showDeclineReason && (
              <div className="flex gap-2 pt-1">
                <Button
                  variant={completionOverride ? "outline" : "ember"}
                  size="sm"
                  onClick={() => void acceptWithConfirmation()}
                  disabled={pending}
                  aria-label={
                    request.kind === "RUNTIME_TOOL_GRANT"
                      ? "Grant runtime tool access and rerun"
                      : "Accept this action request"
                  }
                >
                  {pending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : request.kind === "RUNTIME_TOOL_GRANT" ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {request.kind === "RUNTIME_TOOL_GRANT"
                    ? "Grant and rerun"
                    : completion?.intent === "COMPLETE"
                      ? completionOverride
                        ? "Mark done anyway"
                        : "Mark done"
                      : completion?.intent === "RECOVER"
                        ? "Return to in progress"
                        : "Accept"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDecline}
                  disabled={pending}
                  aria-label="Decline this action request"
                >
                  {completion?.intent === "COMPLETE"
                    ? "Keep in review"
                    : completion?.intent === "RECOVER"
                      ? "Keep current status"
                      : "Decline"}
                </Button>
              </div>
            )}

            {isOpen && visibleCanResolve && showDeclineReason && (
              <div className="space-y-1.5 pt-1">
                <input
                  autoFocus
                  type="text"
                  value={declineReason}
                  onChange={(e) => onDeclineReasonChange(e.target.value)}
                  placeholder={
                    completion?.intent === "COMPLETE"
                      ? "Why should this stay in review? (optional)"
                      : completion?.intent === "RECOVER"
                        ? "Why keep the current status? (optional)"
                        : "Reason (optional)"
                  }
                  maxLength={2_000}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-[0.8125rem]"
                  aria-label="Decline reason"
                />
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={onDecline} disabled={pending}>
                    {pending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <XCircle className="h-3 w-3" />
                    )}
                    {completion?.intent === "COMPLETE"
                      ? "Keep in review"
                      : completion?.intent === "RECOVER"
                        ? "Keep current status"
                        : "Decline"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={onCancelDecline} disabled={pending}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {isOpen && !visibleCanResolve && (
              <div className="text-meta italic text-muted-foreground">
                Awaiting decision from an authorized reviewer.
              </div>
            )}

            {!isOpen && (
              <div className="text-meta text-muted-foreground">
                {request.resolution ?? "Resolved."}
                {request.resolvedAt && (
                  <span className="ml-1">· {relativeTime(request.resolvedAt)}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {confirmElement}
    </>
  );
}

type CompletionTransitionPayload = {
  intent: "COMPLETE" | "RECOVER";
  sourceLabel: string | null;
  sourceUrl: string | null;
  evidence: Array<{
    label: string;
    value: string;
    tone: "SUCCESS" | "WARNING" | "NEUTRAL";
  }>;
  autoHeldReasons: string[];
  assessment: CompletionAssessmentPayload | null;
};

type CompletionFactStatus = "PASS" | "FAIL" | "VERIFYING" | "UNAVAILABLE" | "STALE";

type CompletionAssessmentPayload = {
  version: 1;
  state: "READY" | "BLOCKED" | "VERIFYING" | "UNAVAILABLE" | "STALE";
  evaluatedAt: string;
  facts: Array<{
    key: string;
    label: string;
    summary: string;
    status: CompletionFactStatus;
    detail: string | null;
    observedAt: string | null;
    nextRetryAt: string | null;
    diagnostic: string | null;
    href: string | null;
  }>;
};

function readCompletionAssessment(value: unknown): CompletionAssessmentPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const states = ["READY", "BLOCKED", "VERIFYING", "UNAVAILABLE", "STALE"];
  if (row.version !== 1 || typeof row.state !== "string" || !states.includes(row.state)) {
    return null;
  }
  const facts: CompletionAssessmentPayload["facts"] = Array.isArray(row.facts)
    ? row.facts.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const fact = item as Record<string, unknown>;
        const statuses = ["PASS", "FAIL", "VERIFYING", "UNAVAILABLE", "STALE"];
        if (
          typeof fact.key !== "string" ||
          typeof fact.label !== "string" ||
          typeof fact.summary !== "string" ||
          typeof fact.status !== "string" ||
          !statuses.includes(fact.status)
        ) {
          return [];
        }
        return [
          {
            key: fact.key,
            label: fact.label,
            summary: fact.summary,
            status: fact.status as CompletionFactStatus,
            detail: typeof fact.detail === "string" ? fact.detail : null,
            observedAt: typeof fact.observedAt === "string" ? fact.observedAt : null,
            nextRetryAt: typeof fact.nextRetryAt === "string" ? fact.nextRetryAt : null,
            diagnostic: typeof fact.diagnostic === "string" ? fact.diagnostic : null,
            href: typeof fact.href === "string" ? fact.href : null,
          },
        ];
      })
    : [];
  return {
    version: 1,
    state: row.state as CompletionAssessmentPayload["state"],
    evaluatedAt: typeof row.evaluatedAt === "string" ? row.evaluatedAt : new Date(0).toISOString(),
    facts,
  };
}

function completionNeedsRefresh(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (value.intent !== "COMPLETE") return false;
  const assessment = readCompletionAssessment(value.assessment);
  if (!assessment) return true;
  return Boolean(
    assessment?.facts.some((fact) => fact.key.startsWith("checks:") && fact.status !== "PASS"),
  );
}

function readCompletionTransitionPayload(payload: unknown): CompletionTransitionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.intent !== "COMPLETE" && value.intent !== "RECOVER") return null;
  const evidence: CompletionTransitionPayload["evidence"] = Array.isArray(value.evidence)
    ? value.evidence.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        if (typeof row.label !== "string" || typeof row.value !== "string") return [];
        return [
          {
            label: row.label,
            value: row.value,
            tone:
              row.tone === "SUCCESS" || row.tone === "WARNING" ? row.tone : ("NEUTRAL" as const),
          },
        ];
      })
    : [];
  return {
    intent: value.intent,
    sourceLabel: typeof value.sourceLabel === "string" ? value.sourceLabel : null,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : null,
    evidence,
    autoHeldReasons: Array.isArray(value.autoHeldReasons)
      ? value.autoHeldReasons.filter((reason): reason is string => typeof reason === "string")
      : [],
    assessment: readCompletionAssessment(value.assessment),
  };
}

function CompletionEvidenceSummary({
  completion,
  issueId,
  workspaceSlug,
  refreshing,
  onRefresh,
}: {
  completion: CompletionTransitionPayload;
  issueId?: string;
  workspaceSlug: string;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const assessment = completion.assessment;
  const [evidenceOpen, setEvidenceOpen] = useState(assessment?.state !== "READY");
  useEffect(() => {
    if (assessment && assessment.state !== "READY") setEvidenceOpen(true);
  }, [assessment]);
  const passingFacts = assessment?.facts.filter((fact) => fact.status === "PASS").length ?? 0;
  return (
    <div
      className="text-meta rounded-md border border-border bg-background/40 px-2.5 py-2"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">
          {completion.intent === "COMPLETE" ? "Ready-to-close evidence" : "Recovery options"}
        </span>
        {assessment && (
          <>
            <CompletionStateBadge state={assessment.state} />
            <span className="text-muted-foreground">
              {passingFacts}/{assessment.facts.length} passed · checked{" "}
              {relativeTime(assessment.evaluatedAt)}
            </span>
          </>
        )}
        {completion.sourceUrl && (
          <a
            href={completion.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground"
          >
            <GitPullRequest className="h-3 w-3" />
            {completion.sourceLabel ?? "View source"}
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
        {completion.intent === "RECOVER" && issueId && (
          <Link
            href={`/w/${workspaceSlug}/issues/${issueId}#github-links`}
            className="focus-ring inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground"
          >
            Link replacement PR
          </Link>
        )}
        {completion.intent === "COMPLETE" && onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="focus-ring ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-card/60 hover:text-foreground disabled:opacity-60"
            aria-label="Refresh completion evidence"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Queued" : "Refresh"}
          </button>
        )}
      </div>
      {assessment && assessment.facts.length > 0 ? (
        <details
          className="mt-1.5"
          open={evidenceOpen}
          onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            Evidence details
            {completion.autoHeldReasons.length > 0
              ? ` · ${completion.autoHeldReasons.length} hold${completion.autoHeldReasons.length === 1 ? "" : "s"}`
              : ""}
          </summary>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {assessment.facts.map((fact) => (
              <div
                key={fact.key}
                className="rounded border border-border/70 bg-card/40 px-2 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                    {fact.label}
                  </div>
                  <CompletionFactBadge status={fact.status} />
                </div>
                <div className="mt-0.5 text-foreground/90">{fact.summary}</div>
                {fact.observedAt && (
                  <div className="mt-0.5 text-muted-foreground">
                    Observed {relativeTime(fact.observedAt)}
                  </div>
                )}
                {fact.nextRetryAt && (
                  <div className="mt-0.5 text-muted-foreground">
                    Retry {relativeTime(fact.nextRetryAt)}
                  </div>
                )}
                {fact.diagnostic && (
                  <div className="mt-1 rounded border border-warning/20 bg-warning/[0.04] px-1.5 py-1 text-warning">
                    {fact.diagnostic}
                  </div>
                )}
              </div>
            ))}
          </div>
          {completion.autoHeldReasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-warning">
              {completion.autoHeldReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </details>
      ) : completion.evidence.length > 0 || completion.autoHeldReasons.length > 0 ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            View evidence
            {completion.autoHeldReasons.length > 0
              ? ` · ${completion.autoHeldReasons.length} auto-completion hold${completion.autoHeldReasons.length === 1 ? "" : "s"}`
              : ""}
          </summary>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {completion.evidence.map((item, index) => (
              <div
                key={`${item.label}-${index}`}
                className="rounded border border-border/70 bg-card/40 px-2 py-1.5"
              >
                <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  {item.label}
                </div>
                <div
                  className={
                    item.tone === "SUCCESS"
                      ? "text-ember"
                      : item.tone === "WARNING"
                        ? "text-warning"
                        : "text-foreground/80"
                  }
                >
                  {item.value}
                </div>
              </div>
            ))}
          </div>
          {completion.autoHeldReasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-warning">
              {completion.autoHeldReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </details>
      ) : null}
    </div>
  );
}

function CompletionStateBadge({ state }: { state: CompletionAssessmentPayload["state"] }) {
  const label =
    state === "READY"
      ? "Ready"
      : state === "VERIFYING"
        ? "Verifying"
        : state === "BLOCKED"
          ? "Blocked"
          : state === "STALE"
            ? "Stale"
            : "Unavailable";
  const className =
    state === "READY"
      ? "border-ember/30 bg-ember/10 text-ember"
      : state === "VERIFYING"
        ? "border-warning/30 bg-warning/10 text-warning"
        : state === "BLOCKED"
          ? "border-danger/30 bg-danger/10 text-danger"
          : "border-border bg-card/60 text-muted-foreground";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider ${className}`}
    >
      {label}
    </span>
  );
}

function CompletionFactBadge({ status }: { status: CompletionFactStatus }) {
  const label =
    status === "PASS"
      ? "Pass"
      : status === "FAIL"
        ? "Fail"
        : status === "VERIFYING"
          ? "Verifying"
          : status === "STALE"
            ? "Stale"
            : "Unavailable";
  const className =
    status === "PASS"
      ? "border-ember/30 bg-ember/10 text-ember"
      : status === "FAIL"
        ? "border-danger/30 bg-danger/10 text-danger"
        : status === "VERIFYING"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border bg-background/50 text-muted-foreground";
  return (
    <span
      className={`shrink-0 rounded border px-1 py-0.5 font-mono text-[0.5625rem] uppercase tracking-wider ${className}`}
    >
      {status === "VERIFYING" && (
        <Loader2 className="mr-1 inline h-2.5 w-2.5 motion-safe:animate-spin motion-reduce:animate-none" />
      )}
      {label}
    </span>
  );
}

type RuntimeToolGrantPayload = {
  mode: string;
  tools: string[];
  accessLevel: string;
  scopePath: string;
  reason: string | null;
};

function readRuntimeToolGrantPayload(payload: unknown): RuntimeToolGrantPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const tools = Array.isArray(p.tools)
    ? p.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const scopePath = typeof p.scopePath === "string" ? p.scopePath : "";
  return {
    mode: typeof p.mode === "string" ? p.mode : "REVIEW",
    tools,
    accessLevel: typeof p.accessLevel === "string" ? p.accessLevel : "READ_ONLY",
    scopePath,
    reason: typeof p.reason === "string" && p.reason.trim() ? p.reason : null,
  };
}

function RuntimeToolGrantSummary({ grant }: { grant: RuntimeToolGrantPayload }) {
  const access = grant.accessLevel === "READ_ONLY" ? "read-only" : "full";
  return (
    <div className="text-meta grid gap-2 rounded-md border border-border bg-background/40 p-2 sm:grid-cols-2">
      <div className="min-w-0">
        <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/80">
          Run
        </div>
        <div className="mt-0.5 text-foreground">
          {grant.mode.toLowerCase()} with {access} host tools
        </div>
      </div>
      <div className="min-w-0">
        <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/80">
          Scope
        </div>
        <div className="mt-0.5 truncate font-mono text-foreground" title={grant.scopePath}>
          {grant.scopePath || "runtime default"}
        </div>
      </div>
      <div className="min-w-0 sm:col-span-2">
        <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/80">
          Tools
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {grant.tools.length > 0 ? (
            grant.tools.map((tool) => (
              <span
                key={tool}
                className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-foreground/80"
              >
                {tool}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">No tools requested</span>
          )}
        </div>
      </div>
      {grant.reason && (
        <div className="min-w-0 sm:col-span-2">
          <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/80">
            Reason
          </div>
          <div className="mt-0.5 text-foreground/90">{grant.reason}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Map NotificationSeverity → border + bg + icon tone. INFO is the
 * neutral default; WARNING + ERROR/CRITICAL lift the visual weight.
 */
function severityToTone(severity: NotificationSeverity): {
  borderClass: string;
  bgClass: string;
  iconBgClass: string;
  icon: React.ReactNode;
} {
  switch (severity) {
    case "WARNING":
      return {
        borderClass: "border-l-warning",
        bgClass: "bg-warning/[0.04]",
        iconBgClass: "bg-warning/15",
        icon: <AlertTriangle className="h-3 w-3 text-warning" />,
      };
    case "ERROR":
    case "CRITICAL":
      return {
        borderClass: "border-l-danger",
        bgClass: "bg-danger/[0.04]",
        iconBgClass: "bg-danger/15",
        icon: <AlertOctagon className="h-3 w-3 text-danger" />,
      };
    case "SUCCESS":
      return {
        borderClass: "border-l-ember",
        bgClass: "bg-ember/[0.04]",
        iconBgClass: "bg-ember/15",
        icon: <Sparkles className="h-3 w-3 text-ember" />,
      };
    case "INFO":
    default:
      return {
        borderClass: "border-l-ember",
        bgClass: "bg-ember/[0.04]",
        iconBgClass: "bg-ember/15",
        icon: <Sparkles className="h-3 w-3 text-ember" />,
      };
  }
}

/**
 * Produce a short chip describing the dispatch shape. The MCP/router
 * already validated the payload — here we just render what's there.
 * For ids we fall back to a short prefix so the chip reads like
 * "Status: backlog…". A later iteration can resolve ids → human
 * names via a small batched query.
 */
function kindChipLabel(
  kind: ActionRequestKind,
  payload: unknown,
): { label: string; title: string } | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "FREE_FORM":
      return null;
    case "TRANSITION": {
      const id = typeof p.statusId === "string" ? p.statusId : "?";
      if (p.intent === "COMPLETE") {
        return { label: "ready to close", title: "Will mark the issue done" };
      }
      if (p.intent === "RECOVER") {
        return { label: "recovery", title: "Will return the issue to active work" };
      }
      return {
        label: `transition · ${id.slice(0, 6)}…`,
        title: `Will move issue to status ${id}`,
      };
    }
    case "SET_LABELS": {
      const add = Array.isArray(p.add) ? p.add.length : 0;
      const remove = Array.isArray(p.remove) ? p.remove.length : 0;
      return {
        label: `set labels · +${add}/-${remove}`,
        title: "Will adjust labels on the issue",
      };
    }
    case "ASSIGN": {
      const n = Array.isArray(p.userIds) ? p.userIds.length : 0;
      return {
        label: `assign · ${n} user${n === 1 ? "" : "s"}`,
        title: "Will assign the issue",
      };
    }
    case "ASSIGN_AGENT": {
      const id = typeof p.agentId === "string" ? p.agentId : "?";
      return {
        label: `assign agent · ${id.slice(0, 6)}…`,
        title: `Will assign agent ${id}`,
      };
    }
    case "ARCHIVE":
      return {
        label: "archive",
        title: "Will soft-delete the issue",
      };
    case "CLOSE_AS_DUPLICATE": {
      const id = typeof p.duplicateOfIssueId === "string" ? p.duplicateOfIssueId : "?";
      return {
        label: `dup of · ${id.slice(0, 6)}…`,
        title: `Will mark issue as duplicate of ${id}`,
      };
    }
    case "RUNTIME_TOOL_GRANT": {
      const mode = typeof p.mode === "string" ? p.mode.toLowerCase() : "review";
      const tools = Array.isArray(p.tools) ? p.tools.length : 0;
      return {
        label: `${mode} tools · ${tools}`,
        title: "Will grant a one-time runtime tool allowlist and rerun the agent",
      };
    }
    default:
      return null;
  }
}
