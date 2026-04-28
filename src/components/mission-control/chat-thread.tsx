"use client";
import { useEffect, useMemo, useRef } from "react";
import { Bot } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { useChatContext } from "@/hooks/use-chat-context";
import { cn } from "@/lib/utils";
import { ChatMessageBubble, type ChatMessageRow } from "./chat-message";
import { ChatComposer } from "./chat-composer";
import { ChatMarkdown } from "./chat-markdown";

/**
 * Active chat thread between the operator and one agent. Polls via
 * realtime SSE — every CHAT_MESSAGE_POSTED on this thread invalidates
 * the message list.
 *
 * Header shows runtimeMode badge and honest presence state:
 *   - PERSISTENT + ONLINE/BUSY → emerald/ember dot
 *   - PERSISTENT + OFFLINE     → grey dot + "offline · last seen Xm ago"
 *   - EPHEMERAL  + any         → "session" badge + last-seen
 *
 * Composer placeholder and banner also adapt to presence.
 */

function relativeTime(input: Date | string | null | undefined): string {
  if (!input) return "unknown";
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Three-dot typing indicator rendered like an agent bubble. */
function AgentThinkingBubble({ stale }: { stale: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ember/15 text-ember">
          <Bot className="h-3 w-3" />
        </span>
        <div className="rounded-md border border-border bg-card/60 px-3 py-2">
          <span className="flex gap-1">
            <span
              className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground"
              style={{ animationDelay: "300ms" }}
            />
          </span>
        </div>
      </div>
      {stale && (
        <p className="pl-7 text-meta italic text-muted-foreground/60">
          Still thinking… or take a different path? Check the agent&apos;s status in Mission
          Control.
        </p>
      )}
    </div>
  );
}

const EMPTY_STATE_BODY = `No messages yet.

{agentName} can: read your current page, look up issues + comments,
and take actions on your behalf. Try:
- "what am I assigned right now?"
- "summarize this issue" (if you're on an issue page)
- "@victor draft a status comment for AXI-31"`;

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
  // Fetch full agent data (includes runtimeMode + lastHeartbeatAt) separately.
  const { data: agentFull } = trpc.agent.byId.useQuery(
    { id: agentId },
    { enabled: Boolean(agentId), staleTime: 10_000 },
  );
  // Use agentFull for rich presence fields, fall back to thread data for basics.
  const agent = agentFull ?? data?.agent;
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

  // ---------- Presence-aware derived values ----------
  const mode = agentFull ? (agentFull.runtimeMode ?? "PERSISTENT") : "PERSISTENT";
  const lastHeartbeatAt = agentFull?.lastHeartbeatAt ?? null;
  const isEphemeral = mode === "EPHEMERAL";
  const status = agent?.status ?? "OFFLINE";
  const isPersistentOnline = !isEphemeral && status === "ONLINE";
  const isPersistentBusy = !isEphemeral && status === "BUSY";
  const isPersistentOffline = !isEphemeral && status === "OFFLINE";

  // Composer placeholder copy
  let composerPlaceholder = agent ? `Message ${agent.name}…` : "Message agent…";
  if (agent) {
    if (isPersistentOffline) {
      composerPlaceholder = `Message ${agent.name}… (offline — will reply when back)`;
    } else if (isEphemeral) {
      composerPlaceholder = `Message ${agent.name}… (async — replies on next session)`;
    }
  }

  // Banner for offline/ephemeral agents
  let composerBanner: string | undefined;
  if (agent) {
    if (isPersistentOffline) {
      composerBanner = `${agent.name} is offline. Your message will be queued and delivered on next heartbeat.`;
    } else if (isEphemeral) {
      composerBanner = `${agent.name} runs as a session — replies arrive when the session is active.`;
    }
  }

  // ---------- Thinking indicator logic ----------
  // Show when last message is USER and was sent within the last 60s.
  const lastMessage = messageRows[messageRows.length - 1];
  const lastMessageIsUser = lastMessage?.role === "USER";
  const lastMessageAge = lastMessage
    ? Date.now() - new Date(lastMessage.createdAt).getTime()
    : Infinity;
  // Also show while send is in flight (the draft bubble is present but not committed).
  const showThinking =
    !sendM.isPending && lastMessageIsUser && lastMessageAge < 300_000; // 5 min
  const thinkingIsStale = showThinking && lastMessageAge >= 60_000;

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

          {/* Runtime mode badge */}
          <span
            className={cn(
              "rounded border px-1 py-0 text-[0.5625rem] uppercase tracking-wider text-muted-foreground",
              isEphemeral
                ? "border-amber-500/30 bg-subtle/40"
                : "border-border bg-subtle/40",
            )}
          >
            {isEphemeral ? "session-only" : "persistent"}
          </span>

          {/* Presence indicator */}
          <span className="ml-auto flex items-center gap-1.5">
            {isEphemeral ? (
              <span className="text-[0.625rem] text-muted-foreground">
                {lastHeartbeatAt
                  ? `session · ${relativeTime(lastHeartbeatAt)}`
                  : "session · no heartbeat"}
              </span>
            ) : isPersistentOnline ? (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title="online" />
            ) : isPersistentBusy ? (
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-ember"
                title="busy"
              />
            ) : (
              <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                offline
                {lastHeartbeatAt
                  ? ` · last seen ${relativeTime(lastHeartbeatAt)}`
                  : ""}
              </span>
            )}
          </span>
        </div>
      )}
      <div ref={scrollerRef} className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {messageRows.length === 0 && (
          <div className="px-2 py-4 text-[0.6875rem] text-muted-foreground">
            {agent ? (
              <ChatMarkdown
                body={EMPTY_STATE_BODY.replace("{agentName}", agent.name)}
                className="text-muted-foreground"
              />
            ) : (
              "Loading…"
            )}
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
        {showThinking && <AgentThinkingBubble stale={thinkingIsStale} />}
      </div>
      <ChatComposer
        onSend={handleSend}
        disabled={sendM.isPending}
        isPending={sendM.isPending}
        placeholder={composerPlaceholder}
        banner={composerBanner}
      />
    </div>
  );
}
