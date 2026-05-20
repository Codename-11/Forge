"use client";
import { useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, User as UserIcon, Wrench } from "lucide-react";
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
   * Rehydration blob for messages produced by /api/chat/stream — the
   * server stashes `thinking` and `tool_use` here on `contextSnapshot`
   * so a page reload can re-render the same expandable sections.
   */
  contextSnapshot?: unknown;
}

interface StreamedSnapshot {
  thinking?: string;
  tool_use?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  elapsedMs?: number;
}

function readStreamedSnapshot(value: unknown): StreamedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.streamed !== true) return null;
  const out: StreamedSnapshot = {};
  if (typeof obj.thinking === "string") out.thinking = obj.thinking;
  if (Array.isArray(obj.tool_use)) {
    out.tool_use = obj.tool_use.filter(
      (b): b is { id: string; name: string; args: Record<string, unknown> } =>
        Boolean(b && typeof b === "object" && "id" in b && "name" in b),
    );
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

export function ChatMessageBubble({
  msg,
  agentName,
}: {
  msg: ChatMessageRow;
  agentName?: string;
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
        ) : (
          <>
            <StreamedRehydration snapshot={readStreamedSnapshot(msg.contextSnapshot)} />
            <ChatMarkdown body={msg.body} />
          </>
        )}
        {!msg.isDraft && <ChatMessageAttachments messageId={msg.id} />}
        <div className="mt-0.5 flex items-center justify-between gap-2 text-[0.5625rem] text-muted-foreground/60">
          {!isUser && !msg.isDraft && !msg.id.startsWith("_") ? (
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
  const tools = snapshot.tool_use ?? [];
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
        <ToolUseCard key={tb.id} name={tb.name} args={tb.args} />
      ))}
    </div>
  );
}

function ToolUseCard({
  name,
  args,
}: {
  name: string;
  args: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const json = useMemo(() => {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }, [args]);
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
        <span className="font-mono text-foreground">{name}</span>
        <span className="ml-auto text-[0.5625rem] uppercase tracking-wider text-muted-foreground/70">
          tool intent
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40 px-2 py-1.5">
          <ChatMarkdown body={"```json\n" + json + "\n```"} />
          <p className="mt-1 text-[0.5625rem] italic text-muted-foreground/60">
            (display only — v2 will let you run it)
          </p>
        </div>
      )}
    </div>
  );
}
