"use client";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Activity } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";
import { AgentRunStrip } from "@/components/issue-detail/agent-run-strip";
import { usePasteUpload } from "@/components/attachments/use-paste-upload";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

/**
 * Main column of the issue detail page — description (inline-editable)
 * and the comment stream + composer. Separated from the page shell so
 * the sticky right rail can sit alongside without forcing a rerender of
 * the description when the rail's tab changes.
 */

type Comment = {
  id: string;
  body: string;
  createdAt: Date | string;
  /**
   * Comment kind. STATUS comments are pinned above the thread and
   * surfaced as the rolling agent run status (one per run, upserted
   * via `comments.upsertStatus`). BODY comments render in the regular
   * chronological list.
   */
  kind?: "BODY" | "STATUS";
  /** Last update time (server-side `updatedAt`). Drives "updated Ns ago" on STATUS pins. */
  updatedAt?: Date | string;
  /** Compact step label rendered next to STATUS pins. Always null on BODY. */
  currentStep?: string | null;
  author: { id: string; name: string | null; image: string | null };
  /**
   * When set, the comment was authored via an API key linked to this agent
   * (e.g. Victor / Mizu). Overrides the human author in the byline.
   */
  authoringAgent?: {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
  } | null;
};

export function IssueMain({
  issueId,
  description,
  comments,
  onDescriptionSave,
}: {
  issueId: string;
  description: string | null;
  comments: Comment[];
  onDescriptionSave: (next: string | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <AgentRunStrip issueId={issueId} />
      <DescriptionBlock
        issueId={issueId}
        description={description}
        onSave={onDescriptionSave}
      />
      <Comments issueId={issueId} comments={comments} />
    </div>
  );
}

function DescriptionBlock({
  issueId,
  description,
  onSave,
}: {
  issueId: string;
  description: string | null;
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(description ?? "");
  const [editing, setEditing] = useState(false);

  // Keep draft in sync when the server sends a fresh description and we're
  // not currently editing it. Avoids trampling in-flight edits.
  useEffect(() => {
    if (!editing) setDraft(description ?? "");
  }, [description, editing]);

  const paste = usePasteUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });

  return (
    <section>
      <SectionLabel>Description</SectionLabel>
      {editing ? (
        <div className="space-y-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={paste.onPaste}
            rows={8}
            placeholder="Description (Markdown-flavored). Paste screenshots to attach."
            className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
          />
          <div className="flex gap-2">
            <Button
              variant="ember"
              size="sm"
              onClick={() => {
                onSave(draft.trim() || null);
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(description ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <article
          className="prose prose-sm max-w-none cursor-text rounded-md px-1 py-0.5 text-[0.8125rem] leading-relaxed text-foreground/90 hover:bg-subtle/40"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {description ? (
            <MarkdownWithAttachments body={description} />
          ) : (
            <span className="text-muted-foreground">
              No description. Click to add.
            </span>
          )}
        </article>
      )}
    </section>
  );
}

function Comments({
  issueId,
  comments,
}: {
  issueId: string;
  comments: Comment[];
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState("");

  const createComment = trpc.comment.create.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      setDraft("");
    },
    onError: (e) => toast.error(e.message),
  });

  const paste = usePasteUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });

  // STATUS comments live separately from the chronological thread. We
  // surface the latest STATUS per-agent at the top so the issue page's
  // "what is this agent doing right now" answer is impossible to miss
  // — even when the run has stalled and the live strip is gone, the
  // last status the agent posted is still visible.
  const statusComments = comments.filter((c) => c.kind === "STATUS");
  const bodyComments = comments.filter((c) => c.kind !== "STATUS");
  return (
    <section>
      <SectionLabel>Comments {bodyComments.length > 0 && <Count>{bodyComments.length}</Count>}</SectionLabel>
      <div className="space-y-3">
        {statusComments.map((c) => (
          <StatusCommentPin key={c.id} comment={c} />
        ))}
        {bodyComments.length === 0 && statusComments.length === 0 && (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        )}
        {bodyComments.map((c) => {
          // Agent-authored comments show the agent name in the byline and a
          // small indigo "agent" chip. Human comments render as before.
          const isAgent = Boolean(c.authoringAgent);
          const displayName = c.authoringAgent?.name ?? c.author.name;
          return (
            <div key={c.id} className="flex gap-2.5">
              <Avatar
                name={displayName}
                image={isAgent ? null : c.author.image}
                size={22}
              />
              <div className="min-w-0 flex-1 rounded-md border border-border bg-card/40 p-2.5">
                <div className="flex items-center gap-2 text-meta">
                  <span className="font-medium">{displayName}</span>
                  {isAgent && (
                    // Indigo `agent` chip mirrors the `linkedAgent` badge on
                    // the ApiKey row in settings/access so the visual
                    // language for "this action was an agent" stays
                    // consistent across the app.
                    <Badge
                      color="#6366f1"
                      className="font-mono text-[0.6875rem] uppercase tracking-wider"
                    >
                      agent
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    {relativeTime(c.createdAt)}
                  </span>
                </div>
                <MarkdownWithAttachments
                  body={c.body}
                  className="mt-1 text-[0.8125rem]"
                />
              </div>
            </div>
          );
        })}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          createComment.mutate({ issueId, body: draft.trim() });
        }}
        className="mt-4 space-y-2"
      >
        <textarea
          placeholder="Leave a comment… (paste screenshots to attach)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={paste.onPaste}
          rows={2}
          className="focus-ring w-full rounded-md border border-input bg-background p-2 text-[0.8125rem]"
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={!draft.trim() || createComment.isPending}
          >
            Comment
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Pinned rendering for a single STATUS comment. Visually distinguished
 * from BODY comments: warm ember left-rail, "live status" eyebrow,
 * "updated Ns ago" so a stale status feels stale. The body itself goes
 * through `MarkdownWithAttachments` so issue refs / mentions / attachments
 * still render the same way as in BODY comments.
 */
function StatusCommentPin({ comment }: { comment: Comment }) {
  const isAgent = Boolean(comment.authoringAgent);
  const displayName = comment.authoringAgent?.name ?? comment.author.name;
  const updated = comment.updatedAt ?? comment.createdAt;
  return (
    <div className="flex gap-2.5">
      <Avatar
        name={displayName}
        image={isAgent ? null : comment.author.image}
        size={22}
      />
      <div className="min-w-0 flex-1 rounded-md border-l-2 border-l-ember border-y border-r border-border bg-ember/5 p-2.5">
        <div className="flex items-center gap-2 text-meta">
          <Activity className="h-3 w-3 text-ember" />
          <span className="font-medium">{displayName}</span>
          {isAgent && (
            <Badge
              color="#d97706"
              className="font-mono text-[0.6875rem] uppercase tracking-wider"
            >
              live status
            </Badge>
          )}
          {comment.currentStep && (
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              · {comment.currentStep}
            </span>
          )}
          <span className="ml-auto text-muted-foreground">
            updated {relativeTime(updated)}
          </span>
        </div>
        <MarkdownWithAttachments
          body={comment.body}
          className="mt-1 text-[0.8125rem]"
        />
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[0.6875rem] text-muted-foreground">
      {children}
    </span>
  );
}
