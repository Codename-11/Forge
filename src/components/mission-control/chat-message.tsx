"use client";
import { Bot, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { ChatMarkdown } from "./chat-markdown";
import {
  AttachmentChip,
  AttachmentThumb,
  isImageMime,
  type AttachmentChipData,
} from "@/components/attachments/attachment-chip";

export interface ChatMessageRow {
  id: string;
  role: "USER" | "AGENT" | "SYSTEM";
  body: string;
  createdAt: Date | string;
  /** Set on streaming drafts that haven't committed yet. */
  isDraft?: boolean;
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
          <ChatMarkdown body={msg.body} />
        )}
        {!msg.isDraft && <ChatMessageAttachments messageId={msg.id} />}
        <div className="mt-0.5 text-right text-[0.5625rem] text-muted-foreground/60">
          {relativeTime(msg.createdAt)}
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
    <div className="mt-1.5 space-y-1.5">
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
