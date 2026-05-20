"use client";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Bot, FolderKanban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Hover-preview popover for an inline `KEY-NN` issue chip.
 *
 * Wraps any clickable child (typically the existing mono Link chip the
 * markdown renderer produces). On hover-in with a 350ms delay, fetches
 * `issue.summary({ key })` and renders a small card: status pill, key,
 * title, priority glyph, assignees + assigned agent, optional project.
 *
 * Designed to feel as fast as Linear's: the open delay is short, the
 * close delay is long enough that the operator can move the cursor
 * into the popover without flicker, and the hover persists while the
 * popover itself is hovered.
 *
 * No-op on touch devices (pointer-coarse media query) — the popover
 * surface is mouse-only.
 *
 * Positioning is hand-rolled: a fixed-position portal positioned
 * underneath the wrapped element, flipped up when there isn't enough
 * room below. No new deps; the existing UI primitive set covers it.
 */

const HOVER_OPEN_DELAY_MS = 350;
const HOVER_CLOSE_DELAY_MS = 150;
const POPOVER_GAP_PX = 4;
const POPOVER_WIDTH_PX = 280;

type Pos = { top: number; left: number; flipUp: boolean };

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
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const popoverId = useId();

  // Touch / coarse-pointer detection — popover is mouse-only.
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    setCoarsePointer(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCoarsePointer(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    if (coarsePointer) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (open) return;
    if (openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  }, [coarsePointer, open]);

  const scheduleClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (!open) return;
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [open]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Close on scroll / resize — popover is anchored to a measured
  // position, so any layout shift invalidates it. Cheaper to close
  // and let the operator re-hover than to keep re-measuring.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      clearTimers();
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, clearTimers]);

  // Position the popover relative to the wrapper. Measured after the
  // popover mounts so we know its actual height for the flip decision.
  useLayoutEffect(() => {
    if (!open || !wrapperRef.current) {
      setPos(null);
      return;
    }
    const wrap = wrapperRef.current.getBoundingClientRect();
    const popHeight = popoverRef.current?.getBoundingClientRect().height ?? 120;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const wantTop = wrap.bottom + POPOVER_GAP_PX;
    const wouldOverflowBottom = wantTop + popHeight > vpH - 8;
    const flipUp = wouldOverflowBottom && wrap.top - POPOVER_GAP_PX - popHeight > 8;
    let left = wrap.left;
    if (left + POPOVER_WIDTH_PX > vpW - 8) {
      left = Math.max(8, vpW - 8 - POPOVER_WIDTH_PX);
    }
    if (left < 8) left = 8;
    const top = flipUp
      ? Math.max(8, wrap.top - POPOVER_GAP_PX - popHeight)
      : wantTop;
    setPos({ top, left, flipUp });
  }, [open]);

  return (
    <span
      ref={wrapperRef}
      className={cn("relative inline", className)}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
    >
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              id={popoverId}
              role="tooltip"
              style={{
                position: "fixed",
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                width: POPOVER_WIDTH_PX,
                // Hide until measured to avoid a one-frame top-left flash.
                visibility: pos ? "visible" : "hidden",
              }}
              className={cn(
                "z-50 rounded-lg border border-border bg-card shadow-xl",
                "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100",
              )}
              onMouseEnter={() => {
                if (closeTimerRef.current !== null) {
                  window.clearTimeout(closeTimerRef.current);
                  closeTimerRef.current = null;
                }
              }}
              onMouseLeave={scheduleClose}
            >
              <IssueHoverCard
                issueKey={issueKey}
                workspaceSlug={workspaceSlug}
              />
            </div>,
            document.body,
          )
        : null}
    </span>
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
