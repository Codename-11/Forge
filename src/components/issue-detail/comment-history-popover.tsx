"use client";
import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";
import { cn, relativeTime } from "@/lib/utils";

/**
 * `CommentHistoryPopover` — the "(edited)" trigger that sits next to an
 * edited comment's timestamp. Clicking expands a small panel with each
 * past revision stacked chronologically (newest-first), so the operator
 * can scrub what was said before without leaving the issue page.
 *
 * Data source: `trpc.comment.history({ commentId })`. The server route
 * is shipped by the server-primitives agent alongside the
 * `Comment.editedAt` + `Comment.revisions` columns. Until that merge
 * lands we still want this UI to *compile* — and at runtime to fail
 * quietly rather than throw — so the tRPC call uses a feature-detect
 * cast and the panel renders a graceful "history not available yet"
 * fallback if the procedure errors at request time.
 */

interface HistoryRevision {
  body: string;
  ts: string | Date;
}

// tRPC's proxy returns a callable shape for *any* property access, so
// `trpc.comment.history.useQuery(...)` resolves at the type level once
// the server-primitives slice ships the procedure. While that procedure
// is still on a feature branch the type isn't there yet — these two
// shims keep the call site looking ordinary without leaking `any`
// everywhere.
type CommentHistoryQuery = (
  input: { commentId: string },
  opts: { enabled: boolean; retry: boolean; staleTime: number },
) => {
  data?: { revisions: HistoryRevision[] } | null;
  error?: { message: string } | null;
  isLoading?: boolean;
};

function useCommentHistory(commentId: string, enabled: boolean) {
  // The cast bypasses the missing-procedure type error while the
  // server slice is merging. At runtime tRPC's proxy is always defined,
  // and a missing route surfaces as a `result.error` rather than a
  // throw — which the panel below catches and renders as a fallback.
  const historyHook = (
    trpc.comment as unknown as {
      history?: { useQuery: CommentHistoryQuery };
    }
  ).history;
  const useQueryFn: CommentHistoryQuery =
    historyHook?.useQuery ?? (((): never => {
      throw new Error("comment.history not available");
    }) as unknown as CommentHistoryQuery);
  // Hook ordering note: `historyHook` is determined per-render but the
  // tRPC client builds the proxy once at module load, so the call below
  // is invoked unconditionally and the hook count stays stable.
  return useQueryFn(
    { commentId },
    { enabled, retry: false, staleTime: 30_000 },
  );
}

export function CommentHistoryPopover({
  commentId,
  editedAt,
}: {
  commentId: string;
  editedAt: Date | string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const result = useCommentHistory(commentId, open);
  const data = result?.data;
  const error = result?.error;
  const isLoading = result?.isLoading;

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "inline-flex items-center gap-0.5 rounded text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline",
          open && "text-foreground underline",
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Edited ${relativeTime(editedAt)}`}
      >
        <History className="h-3 w-3" aria-hidden />
        <span>edited</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Comment edit history"
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-full z-30 mt-1 max-h-[24rem] w-[22rem] overflow-y-auto rounded-md border border-border bg-card p-3 shadow-md"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
              Edit history
            </span>
            <span className="text-meta text-muted-foreground/70">
              last edit {relativeTime(editedAt)}
            </span>
          </div>
          {isLoading ? (
            <div className="text-meta text-muted-foreground">Loading…</div>
          ) : error ? (
            <FallbackNote
              text={`Couldn't load history: ${error.message ?? "unknown error"}`}
            />
          ) : !data || data.revisions.length === 0 ? (
            <FallbackNote text="No prior revisions recorded." />
          ) : (
            <ol className="space-y-2">
              {[...data.revisions]
                .sort(
                  (a, b) =>
                    new Date(b.ts).getTime() - new Date(a.ts).getTime(),
                )
                .map((rev, idx) => (
                  <li
                    key={`${typeof rev.ts === "string" ? rev.ts : rev.ts.toISOString()}-${idx}`}
                    className="rounded border border-border/60 bg-background/40 p-2"
                  >
                    <div className="mb-1 flex items-center justify-between text-meta text-muted-foreground/70">
                      <span>
                        {idx === 0
                          ? "Previous version"
                          : `Version −${idx + 1}`}
                      </span>
                      <span>{relativeTime(rev.ts)}</span>
                    </div>
                    <MarkdownWithAttachments
                      body={rev.body ?? ""}
                      className="text-[0.75rem] text-foreground/85"
                    />
                  </li>
                ))}
            </ol>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Read-only "(edited Xm ago)" marker used when the server doesn't yet
 * expose `comment.history`. Same look as the popover trigger sans the
 * click affordance, so the comment surface stays consistent across the
 * intermediate "field shipped, history route not yet" window.
 */
export function EditedFallbackLink({
  editedAt,
}: {
  editedAt: Date | string;
}) {
  return (
    <span
      title={`Edited ${relativeTime(editedAt)}`}
      className="inline-flex items-center gap-0.5 text-muted-foreground/80"
    >
      <History className="h-3 w-3" aria-hidden />
      <span>edited {relativeTime(editedAt)}</span>
    </span>
  );
}

function FallbackNote({ text }: { text: string }) {
  return <p className="text-meta italic text-muted-foreground">{text}</p>;
}
