"use client";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Sparkles,
  AlertTriangle,
  AlertOctagon,
  XCircle,
  Loader2,
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
export interface ActionRequestCardProps {
  /** Comment row's id — the bound ActionRequest is fetched by this. */
  commentId: string;
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

export function ActionRequestCard({ commentId, canResolve, issueId }: ActionRequestCardProps) {
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
        utils.actionRequest.forComment.setData({ commentId }, {
          ...prev,
          status: "RESOLVED" as ActionRequestStatus,
          resolvedAt: new Date(),
          resolution: "Accepted",
        });
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
      // labels, assignment) materializes everywhere.
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      utils.actionRequest.forComment.invalidate({ commentId });
    },
  });

  const decline = trpc.actionRequest.decline.useMutation({
    onMutate: async () => {
      await utils.actionRequest.forComment.cancel({ commentId });
      const prev = utils.actionRequest.forComment.getData({ commentId });
      if (prev) {
        utils.actionRequest.forComment.setData({ commentId }, {
          ...prev,
          status: "REJECTED" as ActionRequestStatus,
          resolvedAt: new Date(),
          resolution: declineReason ? `Declined: ${declineReason}` : "Declined",
        });
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
  };
  visibleCanResolve: boolean;
  showDeclineReason: boolean;
  declineReason: string;
  onDeclineReasonChange: (v: string) => void;
  onAccept: () => void;
  onDecline: () => void;
  onCancelDecline: () => void;
  pending: boolean;
}) {
  const isOpen = request.status === "OPEN";
  const isResolved = request.status === "RESOLVED";
  const isRejected = request.status === "REJECTED";

  const tone = useMemo(() => severityToTone(request.severity), [request.severity]);
  const kindChip = useMemo(() => kindChipLabel(request.kind, request.payload), [
    request.kind,
    request.payload,
  ]);
  const requesterName = request.requestedByAgent
    ? `@${request.requestedByAgent.profileKey}`
    : request.requestedByUser?.handle
      ? `@${request.requestedByUser.handle}`
      : request.requestedByUser?.name ?? "system";

  return (
    <div
      role="article"
      aria-label={`Action request: ${request.title}`}
      className={[
        "rounded-md border-l-2 border-y border-r p-3",
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
          ) : tone.icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-meta">
            <span className="font-semibold text-foreground">{request.title}</span>
            <Badge
              color="#6366f1"
              className="font-mono text-[0.625rem] uppercase tracking-wider"
            >
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

          {isOpen && visibleCanResolve && !showDeclineReason && (
            <div className="flex gap-2 pt-1">
              <Button
                variant="ember"
                size="sm"
                onClick={onAccept}
                disabled={pending}
                aria-label="Accept this action request"
              >
                {pending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Accept
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onDecline}
                disabled={pending}
                aria-label="Decline this action request"
              >
                Decline
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
                placeholder="Reason (optional)"
                maxLength={2_000}
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-[0.8125rem]"
                aria-label="Decline reason"
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDecline}
                  disabled={pending}
                >
                  {pending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )}
                  Decline
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCancelDecline}
                  disabled={pending}
                >
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
      const id =
        typeof p.duplicateOfIssueId === "string" ? p.duplicateOfIssueId : "?";
      return {
        label: `dup of · ${id.slice(0, 6)}…`,
        title: `Will mark issue as duplicate of ${id}`,
      };
    }
    default:
      return null;
  }
}
