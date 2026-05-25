"use client";
import type { ReactNode } from "react";
import { Bot, FolderKanban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { presenceAvailability } from "@/lib/transport-display";
import { HoverPreviewPortal } from "@/components/ui/hover-preview-portal";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Hover-preview popover for an inline `KEY-NN` issue chip.
 *
 * Thin wrapper around the generic `<HoverPreviewPortal>` primitive
 * (which owns delay / portal / measure-and-flip). This file is the
 * issue-specific shape: tRPC `issue.summary` fetch + card layout.
 *
 * Card shape (rows top → bottom):
 *   1. status pill · key
 *   2. title (2-line clamp)
 *   3. priority glyph · project key (when set)
 *   4. assignees + assigned agent (when either present)
 *
 * No-op on touch (handled by portal primitive).
 */

const PRIORITY_GLYPH: Record<string, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};

const PRIORITY_LABEL: Record<string, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  NONE: "No priority",
};

const PRIORITY_TONE: Record<string, string> = {
  URGENT: "text-danger",
  HIGH: "text-warning",
  MEDIUM: "text-foreground/80",
  LOW: "text-muted-foreground",
  NONE: "text-muted-foreground/70",
};

export function IssueHoverPreview({
  issueKey,
  workspaceSlug,
  className,
  children,
}: {
  issueKey: string;
  /** Workspace slug for building the click-through href. Optional —
   *  when omitted, the wrapped child handles navigation itself. */
  workspaceSlug?: string;
  /** Optional override for the wrapper's classes — use when the parent
   *  layout (e.g. flex container) needs the wrapper to participate as
   *  a flex child (`flex-1 min-w-0` etc.). Defaults to `relative inline`. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <HoverPreviewPortal
      className={className}
      render={() => (
        <IssueHoverCard issueKey={issueKey} workspaceSlug={workspaceSlug} />
      )}
    >
      {children}
    </HoverPreviewPortal>
  );
}

function IssueHoverCard({
  issueKey,
  workspaceSlug,
}: {
  issueKey: string;
  workspaceSlug?: string;
}) {
  // 60s staleTime so re-hovering the same key in the same session is
  // free. Disable retry so a NOT_FOUND surfaces immediately as the
  // "Archived / not in this workspace" state without a refetch storm.
  const { data, isLoading, error } = trpc.issue.summary.useQuery(
    { key: issueKey },
    {
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 text-meta text-muted-foreground">
        <Spinner size="sm" />
        <span className="font-mono">{issueKey}</span>
      </div>
    );
  }

  if (error || !data) {
    // NOT_FOUND from the server covers: archived, soft-deleted,
    // cross-workspace, or simply missing. Single soft message either way.
    return (
      <div className="px-3 py-2.5">
        <div className="font-mono text-meta text-muted-foreground">
          {issueKey}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground/80">
          Issue not found
        </div>
      </div>
    );
  }

  const priorityKey = String(data.priority);
  const slug = workspaceSlug ?? data.workspaceSlug;

  return (
    <div className="px-3 py-2.5">
      {/* Row 1: status pill + key */}
      <div className="flex items-center gap-2">
        <Badge color={data.status.color}>{data.status.name}</Badge>
        <a
          href={`/w/${slug}/i/${data.key}`}
          className="ml-auto font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground"
        >
          {data.key}
        </a>
      </div>
      {/* Row 2: title */}
      <div className="mt-1.5 line-clamp-2 text-[0.8125rem] font-medium leading-snug text-foreground">
        {data.title}
      </div>
      {/* Row 3: priority + project */}
      <div className="mt-1.5 flex items-center gap-2 text-meta text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center gap-1",
            PRIORITY_TONE[priorityKey] ?? "text-muted-foreground",
          )}
          title={PRIORITY_LABEL[priorityKey] ?? priorityKey}
        >
          <span className="w-4 text-center font-mono">
            {PRIORITY_GLYPH[priorityKey] ?? "—"}
          </span>
          <span>{PRIORITY_LABEL[priorityKey] ?? priorityKey}</span>
        </span>
        {data.project && (
          <span
            className="inline-flex items-center gap-1 truncate"
            title={data.project.name}
          >
            <FolderKanban className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono text-[0.6875rem]">
              {data.project.key}
            </span>
          </span>
        )}
      </div>
      {/* Row 4: assignees + assigned agent */}
      {(data.assignees.length > 0 || data.assignedAgent) && (
        <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2">
          {data.assignees.length > 0 && (
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="flex -space-x-1.5">
                {data.assignees.slice(0, 3).map((a) => (
                  <Avatar
                    key={a.user.id}
                    name={a.user.name}
                    image={a.user.image}
                    size={18}
                    className="ring-2 ring-card"
                  />
                ))}
              </div>
              <span className="truncate text-meta text-muted-foreground">
                {data.assignees[0]?.user.name ?? "Assigned"}
                {data.assignees.length > 1
                  ? ` +${data.assignees.length - 1}`
                  : ""}
              </span>
            </div>
          )}
          {data.assignedAgent && (
            <span
              className="ml-auto inline-flex items-center gap-1 text-meta text-muted-foreground"
              title={`Agent: ${data.assignedAgent.name}`}
            >
              <AgentPresenceDot
                status={data.assignedAgent.status}
                size="sm"
                availability={presenceAvailability(data.assignedAgent)}
              />
              <Bot className="h-3 w-3" />
              <span className="font-mono text-[0.6875rem]">
                @{data.assignedAgent.profileKey}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
