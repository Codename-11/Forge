"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Activity, Bot } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";
import { AgentRunStrip } from "@/components/issue-detail/agent-run-strip";
import { usePasteUpload } from "@/components/attachments/use-paste-upload";
import { useDropUpload } from "@/components/attachments/use-drop-upload";
import { DropOverlay } from "@/components/attachments/drop-overlay";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import {
  parseSlashCommands,
  SLASH_COMMAND_HINT,
  type SlashCommand,
} from "@/lib/slash-commands";
import {
  SlashAutocomplete,
  useSlashAutocomplete,
} from "@/components/slash-autocomplete";

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
  run?: {
    id: string;
    status: "ACTIVE" | "COMPLETED" | "ABANDONED" | "STALLED";
    finishedAt: Date | string | null;
  } | null;
};

function timestampMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function commentTimelineMs(comment: Comment): number {
  // STATUS comments are rolling run updates: their meaningful timeline
  // position is the last update, not the row creation time. BODY comments
  // stay at creation time so edited comments don't jump around.
  if (comment.kind === "STATUS") return timestampMs(comment.updatedAt ?? comment.createdAt);
  return timestampMs(comment.createdAt);
}

function isPinnedStatusComment(comment: Comment): boolean {
  if (comment.kind !== "STATUS") return false;
  // Pin only live/problem run status. Completed/abandoned status rows are
  // historical summaries and belong in the chronological conversation.
  if (!comment.run) return true;
  return comment.run.status === "ACTIVE" || comment.run.status === "STALLED";
}

/**
 * Agent comments often start with a one-line provenance tag like
 *
 *   [forge-cli daemon on hostname] Picked up assignment…
 *   _(forge-cli daemon on hostname)_
 *
 * Extract that into a small metadata line above the body so the body
 * itself stays focused on the substance. We accept either a leading
 * `[…]` bracket prefix on the first non-empty line, an italic underscore
 * line `_(…)_`, or a literal `> _runtime: …_` blockquote — agents have
 * been writing all three flavours in the wild.
 *
 * Returns the (possibly empty) provenance string and the cleaned body.
 * Designed to be cheap: only runs the regex on the first ~120 characters.
 */
function splitProvenance(body: string): { provenance: string | null; rest: string } {
  if (!body) return { provenance: null, rest: body };
  // Skip leading blank lines.
  const trimmed = body.replace(/^\s+/, "");
  // [bracket] prefix on the first line
  const bracketMatch = trimmed.match(/^\[([^\]\n]{1,160})\]\s*(?:\.|\—|-)?\s*/);
  if (bracketMatch) {
    return {
      provenance: bracketMatch[1].trim(),
      rest: trimmed.slice(bracketMatch[0].length).trimStart(),
    };
  }
  // _(italic provenance)_ first line
  const italicMatch = trimmed.match(/^_\(([^\n)]{1,160})\)_\s*\n?/);
  if (italicMatch) {
    return {
      provenance: italicMatch[1].trim(),
      rest: trimmed.slice(italicMatch[0].length).trimStart(),
    };
  }
  return { provenance: null, rest: body };
}

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
  const drop = useDropUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });

  return (
    <section>
      <SectionLabel>Description</SectionLabel>
      {editing ? (
        <div
          className="relative space-y-2"
          onDragEnter={drop.onDragEnter}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          onDrop={drop.onDrop}
        >
          <DropOverlay active={drop.isOver} label="Drop to attach to description" />
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={paste.onPaste}
            rows={8}
            placeholder="Description (Markdown-flavored). Paste or drop files to attach."
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Pending commands are stashed here when we fire `createComment` so
  // the success callback can dispatch `applyCommands` once the
  // comment is persisted. `useState` keeps it in scope across renders
  // without re-fetching the form's draft.
  const [pendingCommands, setPendingCommands] = useState<SlashCommand[]>([]);

  // Autocomplete: fires on top-of-body slash lines, inserts stubs on
  // Enter / Tab / click. Same surface as QuickCreate; helps discover
  // the seven command keywords without remembering them.
  const slash = useSlashAutocomplete({
    value: draft,
    onChange: (next) => setDraft(next),
    textareaRef: composerRef,
  });

  const applyCommandsM = trpc.issue.applyCommands.useMutation({
    onSuccess: ({ results }) => {
      const skipped = results.filter((r) => r.status === "skipped");
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.length} command${skipped.length === 1 ? "" : "s"} skipped: ${skipped
            .map((s) => `/${s.kind}${s.reason ? ` (${s.reason})` : ""}`)
            .join(", ")}`,
        );
      } else if (results.length > 0) {
        toast.success(
          `Applied ${results.length} command${results.length === 1 ? "" : "s"}.`,
        );
      }
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      utils.issue.watchers.invalidate({ issueId });
    },
    onError: (e) => toast.error(`Slash commands: ${e.message}`),
  });

  const createComment = trpc.comment.create.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      if (pendingCommands.length > 0) {
        applyCommandsM.mutate({ issueId, commands: pendingCommands });
        setPendingCommands([]);
      }
      setDraft("");
    },
    onError: (e) => toast.error(e.message),
  });

  // Live preview: do we have any leading slash commands? Drives the
  // hint chip below the textarea.
  const hasCommands = draft.trim().startsWith("/");

  const paste = usePasteUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });
  const drop = useDropUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });

  // STATUS comments are rolling agent-run updates. Active/stalled status is
  // pinned as the "right now" answer; terminal status rows are historical and
  // render in the normal timeline using updatedAt as their effective time.
  const pinnedStatusComments = comments
    .filter(isPinnedStatusComment)
    .sort((a, b) => commentTimelineMs(b) - commentTimelineMs(a));
  const timelineComments = comments
    .filter((c) => !isPinnedStatusComment(c))
    .sort((a, b) => commentTimelineMs(a) - commentTimelineMs(b));
  return (
    <section>
      <SectionLabel>Comments {timelineComments.length > 0 && <Count>{timelineComments.length}</Count>}</SectionLabel>
      <div className="space-y-3">
        {pinnedStatusComments.map((c) => (
          <StatusCommentPin key={c.id} comment={c} />
        ))}
        {timelineComments.length === 0 && pinnedStatusComments.length === 0 && (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        )}
        {timelineComments.map((c) => (
          <TimelineCommentCard key={c.id} comment={c} />
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          // Parse leading slash commands. Anything in a fenced code
          // block at the top is preserved verbatim. Cleaned body is
          // what gets posted; commands fire as a separate mutation.
          const { strippedBody, commands } = parseSlashCommands(draft);
          const body = strippedBody.trim();
          if (!body && commands.length === 0) return;
          if (!body && commands.length > 0) {
            // Pure command line — apply, no comment posted.
            applyCommandsM.mutate({ issueId, commands });
            setDraft("");
            return;
          }
          // Stash commands so the create-comment success callback
          // applies them once the comment is persisted.
          setPendingCommands(commands);
          createComment.mutate({ issueId, body });
        }}
        className="relative mt-4 space-y-2"
        onDragEnter={drop.onDragEnter}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <DropOverlay active={drop.isOver} label="Drop to attach to comment" />
        <div className="relative">
          <textarea
            ref={composerRef}
            placeholder="Leave a comment… (paste or drop files to attach)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={paste.onPaste}
            onKeyDown={(e) => {
              // Let autocomplete consume nav / Enter / Tab / Escape
              // when the dropdown is open. The form's submit button
              // still drives explicit submission via click.
              slash.onKeyDown(e);
            }}
            {...slash.bind}
            rows={2}
            className="focus-ring w-full rounded-md border border-input bg-background p-2 text-[0.8125rem]"
          />
          {slash.visible && <SlashAutocomplete {...slash.dropdownProps} />}
        </div>
        {hasCommands && (
          <div className="text-meta text-muted-foreground">
            {SLASH_COMMAND_HINT}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={
              (!draft.trim()) ||
              createComment.isPending ||
              applyCommandsM.isPending
            }
          >
            Comment
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Regular timeline comment card. Distinguishes:
 *   - Human authors             — paper-toned card, monogram avatar.
 *   - Agent authors             — Bot glyph avatar in ember tint, indigo
 *                                  "agent" chip, optional `@profileKey`
 *                                  byline. Provenance (e.g. forge-cli
 *                                  daemon hostname) lifts out into a
 *                                  small italic subtitle line so the
 *                                  body stays clean.
 *   - Historical STATUS rows    — soft ember card with "ran status" chip
 *                                  and an `updated Ns ago` timestamp.
 */
function TimelineCommentCard({ comment }: { comment: Comment }) {
  const isAgent = Boolean(comment.authoringAgent);
  const isStatus = comment.kind === "STATUS";
  const displayName = comment.authoringAgent?.name ?? comment.author.name;
  const { provenance, rest } = useMemo(
    () => (isAgent ? splitProvenance(comment.body) : { provenance: null, rest: comment.body }),
    [comment.body, isAgent],
  );
  return (
    <div className="flex gap-2.5">
      <CommentAvatar
        name={displayName}
        image={isAgent ? null : comment.author.image}
        isAgent={isAgent}
      />
      <div
        className={`min-w-0 flex-1 rounded-md border p-2.5 ${
          isStatus
            ? "border-ember/40 bg-ember/[0.04]"
            : isAgent
              ? "border-border bg-card/50"
              : "border-border bg-card/40"
        }`}
      >
        <div className="flex flex-wrap items-center gap-1.5 text-meta">
          <span className="font-medium text-foreground">{displayName}</span>
          {isAgent && comment.authoringAgent && (
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              @{comment.authoringAgent.profileKey}
            </span>
          )}
          {isStatus ? (
            <Badge
              color="#d97706"
              className="font-mono text-[0.6875rem] uppercase tracking-wider"
            >
              ran status
            </Badge>
          ) : (
            isAgent && (
              // Indigo `agent` chip mirrors the `linkedAgent` badge on
              // the ApiKey row in settings/access so "this action was
              // an agent" stays visually consistent across the app.
              <Badge
                color="#6366f1"
                className="font-mono text-[0.6875rem] uppercase tracking-wider"
              >
                agent
              </Badge>
            )
          )}
          <span className="text-muted-foreground">
            {relativeTime(isStatus ? (comment.updatedAt ?? comment.createdAt) : comment.createdAt)}
          </span>
        </div>
        {provenance && (
          <div className="mt-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/80">
            {provenance}
          </div>
        )}
        <MarkdownWithAttachments
          body={rest}
          className="mt-1.5 text-[0.8125rem] text-foreground/90"
        />
      </div>
    </div>
  );
}

/**
 * Avatar component for comment cards. Agent comments get a small bot
 * glyph in the warm ember tint; humans get the standard monogram
 * avatar. Keeps the byline consistent across both surfaces (timeline
 * comments and status pins).
 */
function CommentAvatar({
  name,
  image,
  isAgent,
}: {
  name: string | null;
  image: string | null;
  isAgent: boolean;
}) {
  if (isAgent) {
    return (
      <span
        aria-label={name ?? "agent"}
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-ember/15 text-ember"
      >
        <Bot className="h-3 w-3" />
      </span>
    );
  }
  return <Avatar name={name} image={image} size={22} />;
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
  const { provenance, rest } = useMemo(
    () => (isAgent ? splitProvenance(comment.body) : { provenance: null, rest: comment.body }),
    [comment.body, isAgent],
  );
  return (
    <div className="flex gap-2.5">
      <CommentAvatar
        name={displayName}
        image={isAgent ? null : comment.author.image}
        isAgent={isAgent}
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
        {provenance && (
          <div className="mt-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/80">
            {provenance}
          </div>
        )}
        <MarkdownWithAttachments
          body={rest}
          className="mt-1.5 text-[0.8125rem] text-foreground/90"
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
