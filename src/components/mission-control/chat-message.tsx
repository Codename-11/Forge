"use client";
import { Bot, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatMarkdown } from "./chat-markdown";

export interface ChatMessageRow {
  id: string;
  role: "USER" | "AGENT" | "SYSTEM";
  body: string;
  createdAt: Date | string;
  /** Set on streaming drafts that haven't committed yet. */
  isDraft?: boolean;
}

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
        <div className="mt-0.5 text-right text-[0.5625rem] text-muted-foreground/60">
          {relativeTime(msg.createdAt)}
        </div>
      </div>
    </div>
  );
}
