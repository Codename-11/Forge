"use client";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";
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
  author: { id: string; name: string | null; image: string | null };
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
          className="prose prose-sm max-w-none cursor-text rounded-md px-1 py-0.5 text-[13px] leading-relaxed text-foreground/90 hover:bg-subtle/40"
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

  return (
    <section>
      <SectionLabel>Comments {comments.length > 0 && <Count>{comments.length}</Count>}</SectionLabel>
      <div className="space-y-3">
        {comments.length === 0 && (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        )}
        {comments.map((c) => (
          <div key={c.id} className="flex gap-2.5">
            <Avatar name={c.author.name} image={c.author.image} size={22} />
            <div className="min-w-0 flex-1 rounded-md border border-border bg-card/40 p-2.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-medium">{c.author.name}</span>
                <span className="text-muted-foreground">
                  {relativeTime(c.createdAt)}
                </span>
              </div>
              <MarkdownWithAttachments
                body={c.body}
                className="mt-1 text-[13px]"
              />
            </div>
          </div>
        ))}
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
          className="focus-ring w-full rounded-md border border-input bg-background p-2 text-[13px]"
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

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}
