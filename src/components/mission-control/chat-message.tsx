"use client";
import { useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  User as UserIcon,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { ChatMarkdown } from "./chat-markdown";
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
   * "sent" (confirmed by the stream's `meta` event, un-mutes) → "failed"
   * (offer Retry, preserve the text + attachments). Persisted rows leave
   * this undefined and derive their receipt from the timestamp columns.
   */
  sendState?: "queued" | "sending" | "sent" | "failed";
  /**
   * Rehydration blob for messages produced by /api/chat/stream — the
   * server stashes `thinking` and `tool_use` here on `contextSnapshot`
   * so a page reload can re-render the same expandable sections.
   */
  contextSnapshot?: unknown;
}

interface RehydratedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "declined" | "executed" | "error";
  summary?: string;
  result?: unknown;
}

interface StreamedSnapshot {
  thinking?: string;
  tool_calls?: RehydratedToolCall[];
  elapsedMs?: number;
}

function readStreamedSnapshot(value: unknown): StreamedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.streamed !== true) return null;
  const out: StreamedSnapshot = {};
  if (typeof obj.thinking === "string") out.thinking = obj.thinking;
  // Canonical Phase 0 shape: contextSnapshot.tool_calls = [...].
  // Older messages may carry `tool_use` instead; read both so rehydration
  // doesn't regress for past chats.
  const rawTools = Array.isArray(obj.tool_calls)
    ? obj.tool_calls
    : Array.isArray(obj.tool_use)
      ? obj.tool_use
      : null;
  if (rawTools) {
    out.tool_calls = rawTools
      .filter((b): b is Record<string, unknown> =>
        Boolean(b && typeof b === "object" && "id" in b && "name" in b),
      )
      .map((b) => {
        const status =
          typeof b.status === "string" &&
          ["pending", "approved", "declined", "executed", "error"].includes(
            b.status,
          )
            ? (b.status as RehydratedToolCall["status"])
            : "executed";
        return {
          id: String(b.id),
          name: String(b.name),
          args: (b.args ?? {}) as Record<string, unknown>,
          status,
          summary: typeof b.summary === "string" ? b.summary : undefined,
          result: b.result,
        };
      });
  }
  if (typeof obj.elapsedMs === "number") out.elapsedMs = obj.elapsedMs;
  return out;
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
        <span className="flex items-center gap-1 text-destructive">
          <AlertCircle className="h-3 w-3" />
          Failed to send
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-0.5 inline-flex items-center gap-0.5 rounded border border-destructive/40 px-1 py-0 text-[0.5625rem] hover:bg-destructive/10"
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
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
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
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      Sending…
    </span>
  );
}

export function ChatMessageBubble({
  msg,
  agentName,
  onRetry,
  onCancel,
}: {
  msg: ChatMessageRow;
  agentName?: string;
  /** Retry a failed optimistic send (only used by USER bubbles). */
  onRetry?: () => void;
  /** Cancel a queued / sending / failed optimistic send (USER bubbles). */
  onCancel?: () => void;
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
      <div className="my-0.5 rounded-md border border-border/50 bg-subtle/30 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground">
        {isRichBody ? (
          <ChatMarkdown body={msg.body} className="text-muted-foreground" />
        ) : (
          <span>{msg.body}</span>
        )}
      </div>
    );
  }
  return (
    <div className={cn("flex items-start gap-2", isUser && "flex-row-reverse")}>
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
          isUser
            ? "bg-subtle text-foreground"
            : "border border-border bg-card/60 text-foreground",
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
            {msg.isDraft && <span className="ml-1 inline-block animate-pulse">▍</span>}
          </div>
        ) : msg.isDraft ? (
          // M5 (design spec): while the agent draft streams, render the
          // partial text with the ember sweep + blinking caret. On
          // finalize the bubble re-renders down the branch below with
          // ChatMarkdown, so the persisted text is real `--foreground`
          // and stays selectable (the `.forge-streaming` clip is gone).
          <div className="forge-streaming forge-streaming-cursor whitespace-pre-wrap break-words">
            {msg.body}
          </div>
        ) : (
          <>
            <StreamedRehydration snapshot={readStreamedSnapshot(msg.contextSnapshot)} />
            <ChatMarkdown body={msg.body} />
          </>
        )}
        {!msg.isDraft && <ChatMessageAttachments messageId={msg.id} />}
        <div className="mt-0.5 flex items-center justify-between gap-2 text-[0.5625rem] text-muted-foreground/60">
          {isUser ? (
            <MessageReceipt msg={msg} onRetry={onRetry} onCancel={onCancel} />
          ) : !msg.isDraft && !msg.id.startsWith("_") ? (
            <PromoteToArtifactButton
              sourceType="chat-message"
              sourceId={msg.id}
              defaultTitle={msg.body.slice(0, 60)}
              size="icon"
            />
          ) : (
            <span />
          )}
          <span>{relativeTime(msg.createdAt)}</span>
        </div>
      </div>
    </div>
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
    CHAT_MESSAGE_ATTACHMENTS_ENABLED &&
    typeof messageId === "string" &&
    !messageId.startsWith("_");
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
            <AttachmentThumb
              key={a.id}
              attachment={a}
              attachments={rows}
              target={target}
            />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-1">
          {others.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              attachments={rows}
              target={target}
            />
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
function StreamedRehydration({ snapshot }: { snapshot: StreamedSnapshot | null }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  if (!snapshot) return null;
  const hasThinking = Boolean(snapshot.thinking);
  const tools = snapshot.tool_calls ?? [];
  if (!hasThinking && tools.length === 0) return null;
  const elapsed = snapshot.elapsedMs
    ? (snapshot.elapsedMs / 1000).toFixed(1)
    : null;
  return (
    <div className="mb-1.5 space-y-1.5">
      {hasThinking && (
        <>
          <button
            type="button"
            onClick={() => setThinkingOpen((v) => !v)}
            className="flex w-full items-center gap-1 rounded border border-border/60 bg-subtle/30 px-1.5 py-1 text-left text-[0.6875rem] text-muted-foreground hover:bg-subtle/50"
          >
            {thinkingOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span className="font-mono">
              {elapsed ? `Thought for ${elapsed}s` : "Thinking"}
            </span>
          </button>
          {thinkingOpen && snapshot.thinking && (
            <div className="rounded border border-border/40 bg-background/40 px-2 py-1.5 text-[0.6875rem] italic text-muted-foreground">
              <ChatMarkdown body={snapshot.thinking} className="text-muted-foreground" />
            </div>
          )}
        </>
      )}
      {tools.map((tb) => (
        <ToolCallCard key={tb.id} call={tb} />
      ))}
    </div>
  );
}

function ToolCallCard({ call }: { call: RehydratedToolCall }) {
  const [open, setOpen] = useState(false);
  const json = useMemo(() => {
    try {
      return JSON.stringify(call.args, null, 2);
    } catch {
      return String(call.args);
    }
  }, [call.args]);
  let statusLabel: string;
  switch (call.status) {
    case "executed":
      statusLabel = "done";
      break;
    case "declined":
      statusLabel = "declined";
      break;
    case "error":
      statusLabel = "error";
      break;
    case "approved":
      statusLabel = "approved";
      break;
    case "pending":
    default:
      statusLabel = "pending";
      break;
  }
  return (
    <div className="rounded border border-border/60 bg-subtle/30 text-[0.6875rem]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Wrench className="h-3 w-3 text-ember" />
        <span className="font-mono text-foreground">{call.name}</span>
        <span
          className={cn(
            "ml-auto text-[0.5625rem] uppercase tracking-wider",
            call.status === "error" || call.status === "declined"
              ? "text-destructive"
              : "text-muted-foreground/70",
          )}
        >
          {statusLabel}
        </span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-border/40 px-2 py-1.5">
          <ChatMarkdown body={"```json\n" + json + "\n```"} />
          {call.summary && (
            <p
              className={cn(
                "text-[0.625rem]",
                call.status === "executed"
                  ? "text-foreground"
                  : call.status === "error" || call.status === "declined"
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
            >
              <span className="mr-1 font-mono">
                {call.status === "executed" ? "ok" : call.status}
              </span>
              {call.summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
