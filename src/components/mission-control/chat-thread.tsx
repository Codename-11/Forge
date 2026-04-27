"use client";
import { useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { useChatContext } from "@/hooks/use-chat-context";
import { ChatMessageBubble, type ChatMessageRow } from "./chat-message";
import { ChatComposer } from "./chat-composer";

/**
 * Active chat thread between the operator and one agent. Polls via
 * realtime SSE — every CHAT_MESSAGE_POSTED on this thread invalidates
 * the message list.
 */
export function ChatThreadView({ agentId }: { agentId: string }) {
  const utils = trpc.useUtils();
  // Mutation that upserts + loads. Returns thread + agent + messages.
  const threadM = trpc.chat.thread.useMutation();
  // Run on mount whenever agentId changes.
  useEffect(() => {
    threadM.mutate({ agentId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const data = threadM.data;
  const threadId = data?.thread.id;
  const agent = data?.agent;
  const messages = useMemo(() => data?.messages ?? [], [data?.messages]);

  // Realtime — invalidate on chat events for this thread.
  useRealtime((evt) => {
    if (evt.subjectType !== "chat-thread") return;
    if (evt.subjectId !== threadId) return;
    if (!threadId) return;
    // Refetch by re-running the mutation. Simplest path; cheap.
    threadM.mutate({ agentId });
  });

  const sendM = trpc.chat.send.useMutation({
    onSuccess: () => {
      threadM.mutate({ agentId });
      void utils.chat.threads.invalidate();
    },
  });

  const ctx = useChatContext();
  const handleSend = (body: string) => {
    sendM.mutate({
      agentId,
      body,
      context: {
        route: ctx.route,
        slug: ctx.slug,
        issueId: ctx.issueId,
        selectedIds: ctx.selectedIds,
        pinnedRunIds: ctx.pinnedRunIds,
        liveRunIds: ctx.liveRunIds,
        visibleEntities: ctx.visibleEntities,
      },
    });
  };

  // Auto-scroll to bottom on new messages.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const messageRows: ChatMessageRow[] = useMemo(
    () =>
      messages.map((m) => ({
        id: m.id,
        role: m.role as ChatMessageRow["role"],
        body: m.body,
        createdAt: m.createdAt,
      })),
    [messages],
  );

  return (
    <div className="flex h-full flex-col">
      {agent && (
        <div className="flex items-center gap-2 border-b border-border/70 bg-card/40 px-3 py-1.5">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ember/15 font-mono text-[0.625rem] uppercase text-ember">
            {agent.profileKey.slice(0, 2)}
          </span>
          <span className="text-[0.75rem] font-medium text-foreground">{agent.name}</span>
          <span className="text-[0.625rem] text-muted-foreground">
            @{agent.profileKey}
          </span>
          <span
            className={
              agent.status === "ONLINE"
                ? "ml-auto h-1.5 w-1.5 rounded-full bg-emerald-500"
                : agent.status === "BUSY"
                ? "ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-ember"
                : "ml-auto h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
            }
            title={agent.status}
          />
        </div>
      )}
      <div ref={scrollerRef} className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {messageRows.length === 0 && (
          <div className="px-2 py-6 text-center text-[0.6875rem] text-muted-foreground">
            {agent
              ? `No messages yet. Say hi to ${agent.name}.`
              : "Loading…"}
          </div>
        )}
        {messageRows.map((m) => (
          <ChatMessageBubble key={m.id} msg={m} agentName={agent?.name} />
        ))}
        {sendM.isPending && (
          <ChatMessageBubble
            msg={{
              id: "_pending",
              role: "USER",
              body: sendM.variables?.body ?? "",
              createdAt: new Date(),
              isDraft: true,
            }}
          />
        )}
      </div>
      <ChatComposer
        onSend={handleSend}
        disabled={sendM.isPending}
        placeholder={agent ? `Message ${agent.name}…` : "Message agent…"}
      />
    </div>
  );
}
