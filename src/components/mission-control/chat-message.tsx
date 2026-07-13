"use client";
import { type ReactNode } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  Clock,
  Copy,
  GitFork,
  Loader2,
  PencilLine,
  RefreshCw,
  RotateCcw,
  User as UserIcon,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { ChatMarkdown } from "./chat-markdown";
import { ChatWorkTrace } from "./chat-work-trace";
import { readStreamedSnapshot, type StreamedSnapshot } from "./chat-ui-state";
import {
  AttachmentChip,
  AttachmentThumb,
  isImageMime,
  type AttachmentChipData,
} from "@/components/attachments/attachment-chip";
import { PromoteToArtifactButton } from "@/components/capture/promote-to-artifact-button";

export interface ChatMessageRow {
  id: string;
  role: "USER" | "AGENT" | "SYSTEM";
  body: string;
  createdAt: Date | string;
  /** Set on streaming drafts that haven't committed yet. */
  isDraft?: boolean;
  /**
   * Discord-style delivery receipt timestamps for USER messages. Returned
   * verbatim by the chat router (no `select`, so they're always present on
   * persisted rows). `dispatchedAt` = handed to the server / fan-out;
   * `acknowledgedAt` / `outputStartedAt` = the agent picked it up and
   * began drafting (our "Read" signal).
   */
  dispatchedAt?: Date | string | null;
  acknowledgedAt?: Date | string | null;
  outputStartedAt?: Date | string | null;
  /**
   * Optimistic-only send state for an in-flight USER bubble (`id` starts
   * with `_`): "queued" (waiting its turn) → "sending" (muted, spinner) →
   * "sent" (confirmed by the stream response) → "read" (stream `meta`
   * acknowledged the turn) → "failed" (offer Retry, preserve the text +
   * attachments). Persisted rows leave this undefined and derive their
   * receipt from the timestamp columns.
   */
  sendState?: "queued" | "sending" | "sent" | "read" | "failed";
  /** Optional detail for a recovered/failed optimistic row. */
  sendError?: string;
  /**
   * Rehydration blob for messages produced by /api/chat/stream — the
   * server stashes `thinking` and `tool_use` here on `contextSnapshot`
   * so a page reload can re-render the same expandable sections.
   */
  contextSnapshot?: unknown;
}

/**
 * Whether the storage layer currently allows `chat-message` as an
 * `Attachment.targetType`. Stream BA owns the allowlist; once they add it
 * to `ALLOWED_TARGET_TYPES` in `src/server/services/storage.ts` flip this
 * to `true` (or replace with a runtime check). Until then the
 * `AttachmentRow` block below is a no-op — calling
 * `attachment.list({ targetType: "chat-message" })` would otherwise throw
 * a Zod validation error before the query even left the client.
 */
const CHAT_MESSAGE_ATTACHMENTS_ENABLED = true;

function relativeTime(input: Date | string): string {
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

/**
 * Discord-style delivery receipt for the operator's own (USER) messages.
 *
 *   Sending…  — optimistic, not yet confirmed by the server (spinner)
 *   Sent      — persisted + dispatched, agent hasn't picked it up (✓)
 *   Read      — agent acknowledged / began drafting (✓✓, ember)
 *
 * Agent + system messages don't get a receipt (only a timestamp).
 */
function MessageReceipt({
  msg,
  onRetry,
  onCancel,
}: {
  msg: ChatMessageRow;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  const cancelBtn = onCancel ? (
    <button
      type="button"
      onClick={onCancel}
      title="Cancel"
      className="ml-0.5 inline-flex items-center gap-0.5 rounded border border-border/60 px-1 py-0 text-[0.5625rem] hover:bg-subtle/60 hover:text-foreground"
    >
      <X className="h-2.5 w-2.5" />
      Cancel
    </button>
  ) : null;

  const isOptimistic = msg.id.startsWith("_");
  if (isOptimistic) {
    if (msg.sendState === "failed") {
      return (
        <span className="text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          <span title={msg.sendError ?? "Failed to send"}>{msg.sendError ?? "Failed to send"}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="border-destructive/40 hover:bg-destructive/10 ml-0.5 inline-flex items-center gap-0.5 rounded border px-1 py-0 text-[0.5625rem]"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              Retry
            </button>
          )}
          {cancelBtn}
        </span>
      );
    }
    if (msg.sendState === "sent") {
      return (
        <span className="flex items-center gap-0.5 text-muted-foreground/70">
          <Check className="h-3 w-3" />
          Sent
        </span>
      );
    }
    if (msg.sendState === "read") {
      return (
        <span className="flex items-center gap-0.5 text-ember/80">
          <CheckCheck className="h-3 w-3" />
          Read
        </span>
      );
    }
    if (msg.sendState === "queued") {
      return (
        <span className="flex items-center gap-1 text-muted-foreground/60">
          <Clock className="h-2.5 w-2.5" />
          Queued
          {cancelBtn}
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1 text-muted-foreground/60">
        <Loader2 className="h-2.5 w-2.5 motion-safe:animate-spin" />
        Sending…
        {cancelBtn}
      </span>
    );
  }
  const acked = msg.acknowledgedAt ?? msg.outputStartedAt;
  if (acked) {
    return (
      <span
        className="flex items-center gap-0.5 text-ember/80"
        title={`Read ${relativeTime(acked)}`}
      >
        <CheckCheck className="h-3 w-3" />
        Read
      </span>
    );
  }
  if (msg.dispatchedAt) {
    return (
      <span className="flex items-center gap-0.5 text-muted-foreground/70" title="Delivered">
        <Check className="h-3 w-3" />
        Sent
      </span>
    );
  }
  // Persisted but no dispatch marker yet (rare race) — treat as in-flight.
  return (
    <span className="flex items-center gap-1 text-muted-foreground/60">
      <Loader2 className="h-2.5 w-2.5 motion-safe:animate-spin" />
      Sending…
    </span>
  );
}

export function ChatMessageBubble({
  msg,
  agentName,
  onRetry,
  onCancel,
  onEditMessage,
  onResendMessage,
  onRegenerateFromMessage,
  onForkFromMessage,
}: {
  msg: ChatMessageRow;
  agentName?: string;
  /** Retry a failed optimistic send (only used by USER bubbles). */
  onRetry?: () => void;
  /** Cancel a queued / sending / failed optimistic send (USER bubbles). */
  onCancel?: () => void;
  /** Fill the composer with this message for editing. */
  onEditMessage?: (body: string) => void;
  /** Send this user message again as a new turn. */
  onResendMessage?: (body: string) => void;
  /** Regenerate the nearest preceding user turn for an agent response. */
  onRegenerateFromMessage?: () => void;
  /** Create a new conversation containing history through this message. */
  onForkFromMessage?: () => void;
}) {
  const isUser = msg.role === "USER";
  const isSystem = msg.role === "SYSTEM";
  if (isSystem) {
    // Use markdown rendering for local slash-command output (multi-line, bold, etc.)
    const isRichBody =
      msg.body.includes("**") ||
      msg.body.includes("###") ||
      msg.body.includes("- ") ||
      msg.body.includes("_");
    return (
      <div
        className="my-0.5 rounded-md border border-border/50 bg-subtle/30 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground"
        data-testid="chat-message-system"
      >
        {isRichBody ? (
          <ChatMarkdown body={msg.body} className="text-muted-foreground" />
        ) : (
          <span>{msg.body}</span>
        )}
      </div>
    );
  }
  const snapshot = !isUser ? readStreamedSnapshot(msg.contextSnapshot) : null;
  const renderedBody = !isUser && !msg.body.trim() ? (snapshot?.partialText ?? "") : msg.body;
  const persisted = !msg.isDraft && !msg.id.startsWith("_");
  const hasCopyableBody = renderedBody.trim().length > 0;
  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(renderedBody);
      toast.success("Message copied");
    } catch {
      toast.error("Could not copy message");
    }
  };
  const actionButtons =
    persisted && hasCopyableBody ? (
      <span className="inline-flex items-center gap-0.5">
        <MessageActionButton title="Copy message" onClick={copyBody}>
          <Copy className="h-3 w-3" />
        </MessageActionButton>
        {isUser && onEditMessage && (
          <MessageActionButton
            title="Edit in composer"
            testId="chat-message-action-edit"
            onClick={() => onEditMessage(msg.body)}
          >
            <PencilLine className="h-3 w-3" />
          </MessageActionButton>
        )}
        {isUser && onResendMessage && (
          <MessageActionButton
            title="Send again"
            testId="chat-message-action-resend"
            onClick={() => onResendMessage(msg.body)}
          >
            <RefreshCw className="h-3 w-3" />
          </MessageActionButton>
        )}
        {!isUser && onRegenerateFromMessage && (
          <MessageActionButton
            title="Regenerate response"
            testId="chat-message-action-regenerate"
            onClick={onRegenerateFromMessage}
          >
            <RotateCcw className="h-3 w-3" />
          </MessageActionButton>
        )}
        {onForkFromMessage && (
          <MessageActionButton
            title="Fork conversation from here"
            testId="chat-message-action-fork"
            onClick={onForkFromMessage}
          >
            <GitFork className="h-3 w-3" />
          </MessageActionButton>
        )}
      </span>
    ) : null;
  return (
    <div
      className={cn("flex items-start gap-2", isUser && "flex-row-reverse")}
      data-testid={`chat-message-${msg.role.toLowerCase()}`}
    >
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-subtle text-muted-foreground" : "bg-ember/15 text-ember",
        )}
      >
        {isUser ? <UserIcon className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </span>
      <div
        className={cn(
          "min-w-0 max-w-[85%] rounded-md px-2 py-1.5 text-[0.75rem]",
          isUser ? "bg-subtle text-foreground" : "border border-border bg-card/60 text-foreground",
          msg.isDraft && "opacity-70",
        )}
      >
        {!isUser && agentName && (
          <div className="mb-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {agentName}
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">
            {msg.body}
            {msg.isDraft && <span className="forge-breath ml-1 inline-block">▍</span>}
          </div>
        ) : msg.isDraft || snapshot?.running ? (
          // M5 (design spec): while the agent draft streams, render the
          // partial text with the ember sweep + blinking caret. On
          // finalize the bubble re-renders down the branch below with
          // ChatMarkdown, so the persisted text is real `--foreground`
          // and stays selectable (the `.forge-streaming` clip is gone).
          <>
            <StreamedRehydration snapshot={snapshot} live />
            {renderedBody ? (
              <div className="forge-streaming forge-streaming-cursor whitespace-pre-wrap break-words">
                {renderedBody}
              </div>
            ) : (
              <span className="text-meta text-muted-foreground">Preparing response…</span>
            )}
          </>
        ) : (
          <>
            <StreamedRehydration snapshot={snapshot} />
            {renderedBody && <ChatMarkdown body={renderedBody} />}
          </>
        )}
        {!msg.isDraft && <ChatMessageAttachments messageId={msg.id} />}
        <div className="mt-0.5 flex items-center justify-between gap-2 text-[0.5625rem] text-muted-foreground/60">
          <span className="inline-flex min-w-0 items-center gap-1">
            {isUser ? (
              <MessageReceipt msg={msg} onRetry={onRetry} onCancel={onCancel} />
            ) : persisted ? (
              <PromoteToArtifactButton
                sourceType="chat-message"
                sourceId={msg.id}
                defaultTitle={renderedBody.slice(0, 60)}
                size="icon"
              />
            ) : (
              <span />
            )}
            {actionButtons}
          </span>
          <span>{relativeTime(msg.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

function MessageActionButton({
  title,
  testId,
  onClick,
  children,
}: {
  title: string;
  testId?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testId}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded border border-border/50 bg-background/40 text-muted-foreground transition-colors hover:border-ember/40 hover:bg-ember/10 hover:text-foreground"
    >
      {children}
    </button>
  );
}

/**
 * Per-bubble attachment fetcher. Skipped entirely when
 * `chat-message` is not in the storage allowlist (Stream BA hasn't
 * landed yet) — `enabled: false` keeps the query from firing.
 *
 * Pulls attachments lazily one-call-per-visible-bubble for v1.
 * That's fine for typical chat threads; debatch later if it gets noisy.
 */
function ChatMessageAttachments({ messageId }: { messageId: string }) {
  // Local-only id check guard — never let synthetic ids
  // (`_pending`, `_local_…`) hit the server.
  const isPersisted =
    CHAT_MESSAGE_ATTACHMENTS_ENABLED && typeof messageId === "string" && !messageId.startsWith("_");
  const { data } = trpc.attachment.list.useQuery(
    { targetType: "chat-message", targetId: messageId },
    {
      enabled: isPersisted,
      staleTime: 60_000,
      retry: false,
    },
  );
  const rows = (data ?? []) as AttachmentChipData[];
  if (rows.length === 0) return null;
  const target = { type: "chat-message", id: messageId };
  const images = rows.filter((a) => isImageMime(a.mimeType));
  const others = rows.filter((a) => !isImageMime(a.mimeType));
  return (
    <div className="mt-1.5 space-y-1.5" data-testid="chat-message-attachments">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((a) => (
            <AttachmentThumb key={a.id} attachment={a} attachments={rows} target={target} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-1">
          {others.map((a) => (
            <AttachmentChip key={a.id} attachment={a} attachments={rows} target={target} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Rehydration block for persisted streamed AGENT messages. Renders the
 * collapsible thinking section and the tool-use intent cards above the
 * markdown body, matching the in-flight `AgentStreamBubble` layout.
 */
function StreamedRehydration({
  snapshot,
  live = false,
}: {
  snapshot: StreamedSnapshot | null;
  live?: boolean;
}) {
  if (!snapshot) return null;
  const hasThinking = Boolean(snapshot.thinking);
  const tools = snapshot.toolCalls;
  const stateNotice = snapshot.stopped
    ? "Stopped by operator"
    : snapshot.error
      ? snapshot.error
      : null;
  if (!hasThinking && tools.length === 0 && !stateNotice) return null;
  return (
    <div className="mb-1.5 space-y-1.5">
      <ChatWorkTrace
        thinking={snapshot.thinking}
        tools={tools}
        elapsedMs={snapshot.elapsedMs}
        live={live}
      />
      {stateNotice && (
        <div
          className={cn(
            "text-meta flex items-center gap-1 rounded border px-1.5 py-1",
            snapshot.error
              ? "border-danger/30 bg-danger/5 text-danger"
              : "border-border/60 bg-subtle/30 text-muted-foreground",
          )}
          role={snapshot.error ? "alert" : "status"}
        >
          {snapshot.error ? <AlertCircle className="h-3 w-3" /> : <X className="h-3 w-3" />}
          <span>{stateNotice}</span>
        </div>
      )}
    </div>
  );
}
