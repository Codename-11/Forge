"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { formatChatContextSummary, useChatContext } from "@/hooks/use-chat-context";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { ChatMessageBubble, type ChatMessageRow } from "./chat-message";
import { ChatComposer } from "./chat-composer";
import { uploadAttachmentFile } from "@/components/attachments/attachment-upload-client";
import { toast } from "sonner";
import { ChatMarkdown } from "./chat-markdown";
import type { SlashCommandContext } from "@/lib/chat-slash-commands";
import { AgentAvatar } from "@/components/agents/agent-avatar";

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
function AgentThinkingBubble({ stale, detail }: { stale: boolean; detail?: string }) {
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
        <p className="text-meta pl-7 italic text-muted-foreground/60">
          {detail ?? "Still thinking… inspect the Chat status rail for run and delivery details."}
        </p>
      )}
    </div>
  );
}

/** Streaming draft bubble — renders partial agent response with a blinking cursor. */
function AgentDraftBubble({ body, agentName }: { body: string; agentName?: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ember/15 text-ember">
        <Bot className="h-3 w-3" />
      </span>
      <div className="min-w-0 max-w-[85%] rounded-md border border-border bg-card/60 px-2 py-1.5 text-[0.75rem] text-foreground">
        {agentName && (
          <div className="mb-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {agentName}
          </div>
        )}
        {body ? (
          <div className="relative">
            <ChatMarkdown body={body} />
            {/* Pulsing cursor appended inline */}
            <span className="inline-block animate-pulse text-muted-foreground">▍</span>
          </div>
        ) : (
          // Empty draft — show three dots while waiting for first delta.
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
        )}
      </div>
    </div>
  );
}

type DraftBubble = {
  draftId: string;
  agentId: string;
  body: string;
  startedAt: number;
};

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
  const { data: diagnostics } = trpc.chat.threadDiagnostics.useQuery(
    { threadId: threadId ?? "" },
    { enabled: Boolean(threadId), staleTime: 10_000 },
  );
  // Fetch full agent data (includes runtimeMode + lastHeartbeatAt) separately.
  const { data: agentFull } = trpc.agent.byId.useQuery(
    { id: agentId },
    { enabled: Boolean(agentId), staleTime: 10_000 },
  );
  // Use agentFull for rich presence fields, fall back to thread data for basics.
  const agent = agentFull ?? data?.agent;
  const messages = useMemo(() => data?.messages ?? [], [data?.messages]);

  // ---------- Local (cosmetic) messages from slash commands ----------
  const [localMessages, setLocalMessages] = useState<ChatMessageRow[]>([]);
  const localIdRef = useRef(0);

  const appendLocal = (body: string) => {
    const id = `_local_${++localIdRef.current}`;
    setLocalMessages((prev) => [...prev, { id, role: "SYSTEM", body, createdAt: new Date() }]);
  };

  const clearLocal = () => {
    setLocalMessages([]);
  };

  // ---------- Streaming draft bubble ----------
  const [draft, setDraft] = useState<DraftBubble | null>(null);

  // Realtime — invalidate on chat events for this thread.
  useRealtime((evt) => {
    if (!threadId) return;

    // Streaming draft events.
    if (evt.subjectType === "chat-thread-stream" && evt.subjectId === threadId) {
      const p = evt.payload as {
        phase: string;
        draftId: string;
        delta?: string;
        messageId?: string;
      };
      if (p.phase === "started") {
        setDraft({
          draftId: p.draftId,
          agentId,
          body: "",
          startedAt: Date.now(),
        });
      } else if (p.phase === "delta" && p.delta) {
        setDraft((d) => (d && d.draftId === p.draftId ? { ...d, body: d.body + p.delta } : d));
      } else if (p.phase === "finalized") {
        // Hold draft visible briefly while the persisted message lands.
        setTimeout(() => {
          setDraft((d) => (d && d.draftId === p.draftId ? null : d));
        }, 800);
      }
      return;
    }

    // Regular chat message posted — refetch.
    if (evt.subjectType !== "chat-thread") return;
    if (evt.subjectId !== threadId) return;
    // Refetch by re-running the mutation. Simplest path; cheap.
    threadM.mutate({ agentId });
  });

  const sendM = trpc.chat.send.useMutation({
    onSuccess: () => {
      threadM.mutate({ agentId });
      void utils.chat.threads.invalidate();
    },
  });
  const createPendingM = trpc.chat.createPendingMessage.useMutation();
  const dispatchM = trpc.chat.dispatchMessage.useMutation({
    onSuccess: () => {
      threadM.mutate({ agentId });
      void utils.chat.threads.invalidate();
    },
  });
  const initUploadM = trpc.attachment.initUpload.useMutation();
  const finalizeM = trpc.attachment.finalize.useMutation();
  const [pendingDraft, setPendingDraft] = useState<{ body: string; files: string[] } | null>(null);

  const ctx = useChatContext();
  const workspace = useMaybeWorkspace();

  const currentContext = useMemo(
    () => ({
      route: ctx.route,
      slug: ctx.slug,
      issueId: ctx.issueId,
      selectedIds: ctx.selectedIds,
      pinnedRunIds: ctx.pinnedRunIds,
      liveRunIds: ctx.liveRunIds,
      visibleEntities: ctx.visibleEntities,
    }),
    [
      ctx.route,
      ctx.slug,
      ctx.issueId,
      ctx.selectedIds,
      ctx.pinnedRunIds,
      ctx.liveRunIds,
      ctx.visibleEntities,
    ],
  );

  const contextSummary = useMemo(() => formatChatContextSummary(currentContext), [currentContext]);

  const handleSend = async (body: string, files: File[] = []) => {
    setPendingDraft({ body, files: files.map((f) => f.name || "attachment") });
    try {
      if (files.length === 0) {
        await sendM.mutateAsync({
          agentId,
          body,
          context: currentContext,
        });
        return;
      }

      const pending = await createPendingM.mutateAsync({
        agentId,
        body,
        context: currentContext,
      });
      for (const file of files) {
        await uploadAttachmentFile({
          file,
          targetType: "chat-message",
          targetId: pending.messageId,
          initUpload: initUploadM.mutateAsync,
          finalize: finalizeM.mutateAsync,
        });
      }
      await utils.attachment.list.invalidate({
        targetType: "chat-message",
        targetId: pending.messageId,
      });
      await dispatchM.mutateAsync({ messageId: pending.messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send chat attachments";
      toast.error(message);
      throw err;
    } finally {
      setPendingDraft(null);
    }
  };

  // Build slash-command context — stable reference via useMemo.
  // Prefer agentFull (has all fields); fall back to basic agent shape for
  // id/name/profileKey/status/role which are available from data.agent.
  const slashContext: SlashCommandContext | undefined = useMemo(() => {
    if (!agent || !threadId || !workspace) return undefined;
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        profileKey: agent.profileKey,
        runtimeMode: agentFull?.runtimeMode ?? "PERSISTENT",
        status: agent.status ?? "OFFLINE",
        lastHeartbeatAt: agentFull?.lastHeartbeatAt ?? null,
        capabilities: agentFull?.capabilities ?? [],
        role: agent.role ?? "",
      },
      thread: { id: threadId },
      workspaceSlug: workspace.slug,
      appendLocal,
      clearLocal,
      sendPrompt: handleSend,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, agentFull?.runtimeMode, agentFull?.status, threadId, workspace?.slug]);

  // Auto-scroll to bottom on new messages.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, localMessages.length, draft?.body]);

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

  // Merged display rows: persisted + local SYSTEM messages interleaved.
  // Local messages appear after the last persisted message.
  const displayRows: ChatMessageRow[] = useMemo(
    () => [...messageRows, ...localMessages],
    [messageRows, localMessages],
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
  // Don't show the static three-dot bubble when a draft is active.
  const lastMessage = displayRows[displayRows.length - 1];
  const lastPersistedMessage = messageRows[messageRows.length - 1];
  const lastMessageIsUser = lastPersistedMessage?.role === "USER";
  const lastMessageAge = lastPersistedMessage
    ? Date.now() - new Date(lastPersistedMessage.createdAt).getTime()
    : Infinity;
  // Also show while send is in flight (the draft bubble is present but not committed).
  const composerBusy =
    sendM.isPending ||
    createPendingM.isPending ||
    initUploadM.isPending ||
    finalizeM.isPending ||
    dispatchM.isPending;
  const showThinking =
    !composerBusy &&
    !draft && // suppress static bubble when draft stream is active
    lastMessageIsUser &&
    lastMessageAge < 300_000; // 5 min
  const thinkingIsStale = showThinking && lastMessageAge >= 60_000;
  const thinkingDetail = diagnostics?.lastRun
    ? diagnostics.lastRun.status === "ACTIVE"
      ? `Still active: ${diagnostics.lastRun.currentStep ?? "running"}`
      : `Run ${diagnostics.lastRun.status.toLowerCase()} · inspect status rail.`
    : diagnostics?.lastDelivery?.status === "FAILED"
      ? "Webhook delivery failed; retry is available in the status rail."
      : "No run/delivery record found yet; inspect agent status.";

  // Suppress unused var warning — lastMessage is used for list rendering logic.
  void lastMessage;

  return (
    <div className="flex h-full flex-col">
      {agent && (
        <div className="flex items-center gap-2 border-b border-border/70 bg-card/40 px-3 py-1.5">
          <AgentAvatar agent={agent} size="xs" shape="circle" active />
          <span className="text-[0.75rem] font-medium text-foreground">{agent.name}</span>
          <span className="text-[0.625rem] text-muted-foreground">@{agent.profileKey}</span>

          {/* Runtime mode badge */}
          <span
            className={cn(
              "rounded border px-1 py-0 text-[0.5625rem] uppercase tracking-wider text-muted-foreground",
              isEphemeral ? "border-amber-500/30 bg-subtle/40" : "border-border bg-subtle/40",
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
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ember" title="busy" />
            ) : (
              <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                offline
                {lastHeartbeatAt ? ` · last seen ${relativeTime(lastHeartbeatAt)}` : ""}
              </span>
            )}
          </span>
        </div>
      )}
      <div ref={scrollerRef} className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {displayRows.length === 0 && (
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
        {displayRows.map((m) => (
          <ChatMessageBubble key={m.id} msg={m} agentName={agent?.name} />
        ))}
        {composerBusy && pendingDraft && (
          <ChatMessageBubble
            msg={{
              id: "_pending",
              role: "USER",
              body:
                pendingDraft.body ||
                (pendingDraft.files.length > 0
                  ? pendingDraft.files.map((name) => `📎 ${name}`).join("\n")
                  : ""),
              createdAt: new Date(),
              isDraft: true,
            }}
          />
        )}
        {/* Draft bubble — shows while agent is streaming. Replaces static thinking bubble. */}
        {draft ? (
          <AgentDraftBubble body={draft.body} agentName={agent?.name} />
        ) : (
          showThinking && <AgentThinkingBubble stale={thinkingIsStale} detail={thinkingDetail} />
        )}
      </div>
      <ChatComposer
        onSend={handleSend}
        disabled={composerBusy}
        isPending={composerBusy}
        placeholder={composerPlaceholder}
        banner={composerBanner}
        slashContext={slashContext}
        contextSummary={contextSummary}
      />
    </div>
  );
}
