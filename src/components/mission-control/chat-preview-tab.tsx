"use client";

import Link from "next/link";
import { Bot, MessageSquare, SquareArrowOutUpRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import {
  chatSessionClassBadgeClass,
  chatSessionClassLabel,
} from "@/lib/chat-session-classification";

function conversationTitle(thread: {
  title?: string | null;
  isDefault?: boolean | null;
  agent: { name: string };
  latestMessage?: { body: string | null } | null;
}): string {
  const title = thread.title?.trim();
  if (title) return title;
  if (thread.isDefault) return `Chat with ${thread.agent.name}`;
  const body = thread.latestMessage?.body?.replace(/\s+/g, " ").trim();
  if (body) return body.length > 64 ? `${body.slice(0, 61)}...` : body;
  return "Untitled conversation";
}

export function ChatPreviewTab({ slug }: { slug: string }) {
  const { data: threads, isLoading } = trpc.chat.threads.useQuery(undefined, {
    staleTime: 30_000,
  });
  const rows = (threads ?? []).slice(0, 8);

  if (isLoading) {
    return <div className="text-meta px-3 py-4 text-muted-foreground">Loading chats…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <div className="text-meta text-foreground/80">No agent chats yet.</div>
        <Link
          href={`/w/${slug}/chat`}
          className="focus-ring inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] text-foreground/80 hover:border-ember/40 hover:text-foreground"
        >
          Open chat
          <SquareArrowOutUpRight className="h-3 w-3" />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-1.5">
          {rows.map((thread) => {
            const latest = thread.latestMessage;
            return (
              <Link
                key={thread.id}
                href={`/w/${slug}/chat?thread=${encodeURIComponent(thread.id)}`}
                className="group flex min-w-0 gap-2 rounded-md border border-border bg-card/40 px-2.5 py-2 hover:border-ember/40"
              >
                <span
                  className={cn(
                    "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border",
                    latest?.role === "AGENT"
                      ? "border-ember/30 bg-ember/10 text-ember"
                      : "border-border bg-subtle text-muted-foreground",
                  )}
                >
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[0.75rem] font-medium">
                      {conversationTitle(thread)}
                    </span>
                    <span className="text-id shrink-0 text-muted-foreground">
                      @{thread.agent.profileKey}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "mt-1 inline-flex rounded-full border px-1 py-0 text-[0.5rem] uppercase tracking-wider",
                      chatSessionClassBadgeClass(thread.sessionClass),
                    )}
                  >
                    {chatSessionClassLabel(thread.sessionClass)}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-meta text-muted-foreground">
                    {latest?.body ?? "No messages yet."}
                  </span>
                </span>
                <span className="shrink-0 pt-0.5 text-meta tabular-nums text-muted-foreground">
                  {thread.lastMessageAt ? relativeTime(thread.lastMessageAt) : "new"}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-2 text-meta">
        <span className="min-w-0 truncate text-muted-foreground">
          Recent agent replies and open threads
        </span>
        <Link
          href={`/w/${slug}/chat`}
          className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] text-foreground/80 hover:border-ember/40 hover:text-foreground"
        >
          Full chat
          <SquareArrowOutUpRight className="h-3 w-3" />
        </Link>
      </footer>
    </div>
  );
}
