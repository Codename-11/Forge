"use client";

/**
 * StepComments — inline per-step comment thread for the Plans surface.
 *
 * Renders a compact "{n} comments" trigger that expands into a
 * chronological thread + a composer textarea. Intentionally light on
 * chrome so it nests cleanly under an ExecutionStep row without
 * stealing visual weight from the step itself.
 *
 * Backed by:
 *   - `executionPlan.stepCommentList`   — chronological thread.
 *   - `executionPlan.stepCommentCreate` — composer submit.
 *   - `executionPlan.stepCommentDelete` — soft-delete button (author /
 *     workspace admin only; the server enforces).
 *
 * The component owns no auth state — author/admin visibility for the
 * delete button is decided lazily by attempting the mutation; the
 * server's FORBIDDEN response surfaces via `onError`. (Keeps the
 * component's prop surface to just `{ stepId }`, so Agent A's
 * integration is a one-liner.)
 */

import { useState } from "react";
import { ChevronRight, MessageSquare, Send, Trash2 } from "lucide-react";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";
import { Avatar } from "@/components/ui/avatar";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

interface StepCommentsProps {
  stepId: string;
  /**
   * Optional override for the initial expand state. Useful when a
   * parent surface (Agent A's plan page) wants to remember
   * per-step open state across renders. Defaults to collapsed.
   */
  initiallyOpen?: boolean;
}

function StepComments({ stepId, initiallyOpen = false }: StepCommentsProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const [draft, setDraft] = useState("");
  const utils = trpc.useUtils();

  // Only load the thread once the user expands. The header count is
  // populated by the list query's `items.length` after the first
  // expansion; before that we show a neutral "Comments" trigger so we
  // don't fire a query per step on plan load.
  const list = trpc.executionPlan.stepCommentList.useQuery(
    { stepId },
    { enabled: open },
  );

  const create = trpc.executionPlan.stepCommentCreate.useMutation({
    onSuccess: () => {
      setDraft("");
      utils.executionPlan.stepCommentList.invalidate({ stepId });
    },
  });

  const del = trpc.executionPlan.stepCommentDelete.useMutation({
    onSuccess: () => {
      utils.executionPlan.stepCommentList.invalidate({ stepId });
    },
  });

  const items = list.data?.items ?? [];
  const countLabel =
    open && list.data
      ? items.length === 0
        ? "No comments"
        : `${items.length} comment${items.length === 1 ? "" : "s"}`
      : "Comments";

  return (
    <div className="mt-2 rounded-md border border-border/60 bg-card/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5",
          "text-meta text-muted-foreground transition-colors hover:bg-subtle/50",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        aria-expanded={open}
        aria-controls={`step-comments-${stepId}`}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <MessageSquare className="h-3 w-3" />
        <span>{countLabel}</span>
      </button>

      <div
        id={`step-comments-${stepId}`}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0">
          <div className="border-t border-border/60 px-2.5 py-2">
            {list.isLoading && open && (
              <p className="text-meta text-muted-foreground">Loading…</p>
            )}

            {open && !list.isLoading && items.length === 0 && (
              <p className="text-meta text-muted-foreground">
                No comments yet — be the first to weigh in.
              </p>
            )}

            {items.length > 0 && (
              <ul className="space-y-2.5">
                {items.map((c) => {
                  const isAgent = Boolean(c.authoringAgent);
                  const displayName =
                    c.authoringAgent?.name ?? c.author.name ?? "Unknown";
                  return (
                    <li key={c.id} className="flex gap-2">
                      <Avatar
                        name={displayName}
                        image={isAgent ? null : c.author.image}
                        size={20}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-meta">
                          <span className="font-medium text-foreground">
                            {displayName}
                          </span>
                          {isAgent && (
                            <span className="rounded-sm bg-subtle px-1 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                              agent
                            </span>
                          )}
                          <span className="text-muted-foreground">
                            {relativeTime(c.createdAt)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              del.mutate({ commentId: c.id })
                            }
                            className={cn(
                              "ml-auto rounded p-0.5 text-muted-foreground/60",
                              "transition-colors hover:bg-subtle hover:text-destructive",
                            )}
                            aria-label="Delete comment"
                            title="Delete (author or admin)"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="text-foreground/85">
                          <ChatMarkdown body={c.body} />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Composer — always rendered when the thread is open. */}
            <form
              className="mt-2.5 flex items-end gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const body = draft.trim();
                if (!body || create.isPending) return;
                create.mutate({ stepId, body });
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add a comment…"
                rows={1}
                className={cn(
                  "min-h-7 w-full resize-none rounded-md border border-border/60 bg-card",
                  "px-2 py-1 text-[0.75rem] leading-snug text-foreground",
                  "placeholder:text-muted-foreground/60",
                  "focus:border-ring focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
                onKeyDown={(e) => {
                  if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === "Enter" &&
                    draft.trim()
                  ) {
                    e.preventDefault();
                    create.mutate({ stepId, body: draft.trim() });
                  }
                }}
              />
              <button
                type="submit"
                disabled={!draft.trim() || create.isPending}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/60",
                  "bg-card px-2 text-meta text-foreground transition-colors",
                  "hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50",
                )}
                aria-label="Post comment"
              >
                <Send className="h-3 w-3" />
                <span>Post</span>
              </button>
            </form>
            {create.error && (
              <p className="mt-1 text-meta text-destructive">
                {create.error.message}
              </p>
            )}
            {del.error && (
              <p className="mt-1 text-meta text-destructive">
                {del.error.message}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default StepComments;
export { StepComments };
export type { StepCommentsProps };
