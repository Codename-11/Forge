"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, RefreshCw, Wrench } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { formatChatContextSummary, useChatContext } from "@/hooks/use-chat-context";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { ChatMessageBubble, type ChatMessageRow } from "./chat-message";
import { ChatComposer, type MentionableAgent } from "./chat-composer";
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

/**
 * Pre-typing diagnostic — shown when the wake has been sent (or queued
 * / stalled) but the agent has NOT yet acknowledged the message.
 * Replaces the misleading "infinite thinking" animation the legacy
 * heuristic produced when an agent receiver was offline or the wake
 * delivery failed.
 */
function AgentWakeDiagnostic({
  state,
  agentName,
  wakeAttempts,
  lastWakeAt,
}: {
  state: "queued" | "wake-sent" | "stalled";
  agentName?: string;
  wakeAttempts: number;
  lastWakeAt: Date | string | null;
}) {
  const label =
    state === "queued"
      ? "Queued · waking…"
      : state === "wake-sent"
        ? `Wake sent · waiting for ${agentName ?? "agent"} to ack`
        : `${agentName ?? "Agent"} hasn't replied`;
  const sub =
    state === "stalled"
      ? `${wakeAttempts} wake attempt${wakeAttempts === 1 ? "" : "s"}${lastWakeAt ? ` · last ${relativeTime(lastWakeAt)}` : ""}. Retry wake or kick from the status rail.`
      : wakeAttempts > 0 && lastWakeAt
        ? `Last wake ${relativeTime(lastWakeAt)} (${wakeAttempts} attempt${wakeAttempts === 1 ? "" : "s"}).`
        : null;
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted/40 text-muted-foreground">
          <Bot className="h-3 w-3" />
        </span>
        <div
          className={cn(
            "rounded-md border bg-card/40 px-3 py-1.5 text-[0.6875rem]",
            state === "stalled"
              ? "border-amber-500/30 text-amber-700 dark:text-amber-300"
              : "border-border text-muted-foreground",
          )}
        >
          {label}
        </div>
      </div>
      {sub && <p className="text-meta pl-7 italic text-muted-foreground/60">{sub}</p>}
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

/** In-flight streaming bubble from /api/chat/stream (distinct from the
 * legacy MCP-driven draft bubble above, which is still used by the
 * dispatch path when Hermes streams via `chat.startDraft`). */
export type StreamToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  requiresConfirm: boolean;
  status: "pending" | "approved" | "declined" | "executed" | "error";
  summary?: string;
  result?: unknown;
};

type StreamBubble = {
  messageId: string | null;
  body: string;
  thinking: string;
  toolCalls: StreamToolCall[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Original prompt — kept so the Retry button can re-fire it. */
  lastPrompt: string;
};

/**
 * Streaming bubble UI. Shows a collapsible thinking section, the live
 * content, and one card per tool_use intent. Writes pause the loop with
 * an Approve/Decline confirm card.
 */
function AgentStreamBubble({
  bubble,
  agentName,
  onRetry,
  onApprove,
  onDecline,
}: {
  bubble: StreamBubble;
  agentName?: string;
  onRetry?: () => void;
  onApprove?: (callId: string) => void;
  onDecline?: (callId: string) => void;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const elapsedSec = bubble.finishedAt
    ? ((bubble.finishedAt - bubble.startedAt) / 1000).toFixed(1)
    : null;
  const isLive = bubble.finishedAt === null && !bubble.error;
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ember/15 text-ember">
        <Bot className="h-3 w-3" />
      </span>
      <div className="min-w-0 max-w-[85%] space-y-1.5 rounded-md border border-border bg-card/60 px-2 py-1.5 text-[0.75rem] text-foreground">
        {agentName && (
          <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {agentName}
          </div>
        )}

        {bubble.thinking && (
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
              {isLive
                ? "Thinking…"
                : elapsedSec
                  ? `Thought for ${elapsedSec}s`
                  : "Thinking"}
            </span>
          </button>
        )}
        {bubble.thinking && thinkingOpen && (
          <div className="rounded border border-border/40 bg-background/40 px-2 py-1.5 text-[0.6875rem] italic text-muted-foreground">
            <ChatMarkdown body={bubble.thinking} className="text-muted-foreground" />
          </div>
        )}

        {bubble.body ? (
          <div className="relative">
            <ChatMarkdown body={bubble.body} />
            {isLive && <span className="inline-block animate-pulse text-muted-foreground">▍</span>}
          </div>
        ) : isLive ? (
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
        ) : null}

        {bubble.toolCalls.length > 0 && (
          <div className="space-y-1">
            {bubble.toolCalls.map((tb) => (
              <ToolCallCard
                key={tb.id}
                call={tb}
                onApprove={onApprove}
                onDecline={onDecline}
              />
            ))}
          </div>
        )}

        {bubble.error && (
          <div className="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-1.5 py-1 text-[0.6875rem] text-amber-700 dark:text-amber-300">
            <span className="truncate">{bubble.error}</span>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] hover:bg-amber-500/20"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Live tool-call card. Renders started → confirm → executed/error states,
 * surfacing an Approve / Decline pair for write-class tools that need
 * operator sign-off before the loop resumes.
 */
function ToolCallCard({
  call,
  onApprove,
  onDecline,
}: {
  call: StreamToolCall;
  onApprove?: (callId: string) => void;
  onDecline?: (callId: string) => void;
}) {
  const [open, setOpen] = useState(call.status === "pending" && call.requiresConfirm);
  const json = useMemo(() => {
    try {
      return JSON.stringify(call.args, null, 2);
    } catch {
      return String(call.args);
    }
  }, [call.args]);

  const awaitingConfirm = call.status === "pending" && call.requiresConfirm;
  const running = call.status === "pending" || call.status === "approved";

  let statusLabel: string;
  switch (call.status) {
    case "pending":
      statusLabel = awaitingConfirm ? "awaiting approval" : "running…";
      break;
    case "approved":
      statusLabel = "running…";
      break;
    case "declined":
      statusLabel = "declined";
      break;
    case "executed":
      statusLabel = "done";
      break;
    case "error":
      statusLabel = "error";
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
        <div className="space-y-1.5 border-t border-border/40 px-2 py-1.5">
          <ChatMarkdown body={"```json\n" + json + "\n```"} />
          {awaitingConfirm && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onApprove?.(call.id)}
                className="rounded border border-ember/40 bg-ember/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-ember hover:bg-ember/25"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => onDecline?.(call.id)}
                className="rounded border border-border bg-card/40 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:text-foreground"
              >
                Decline
              </button>
            </div>
          )}
          {running && !awaitingConfirm && (
            <p className="text-[0.5625rem] italic text-muted-foreground/60">
              Running tool…
            </p>
          )}
          {(call.status === "executed" || call.status === "error" || call.status === "declined") &&
            call.summary && (
              <p
                className={cn(
                  "text-[0.625rem]",
                  call.status === "executed"
                    ? "text-foreground"
                    : "text-destructive",
                )}
              >
                <span className="mr-1 font-mono">
                  {call.status === "executed" ? "ok" : "fail"}
                </span>
                {call.summary}
              </p>
            )}
        </div>
      )}
    </div>
  );
}

interface SuggestedPrompt {
  label: string;
  body: string;
}

/**
 * Contextual prompt suggestions for an empty thread. We build a small,
 * route-aware grid (3-4 items) so the operator has somewhere to land.
 * Returns concrete prompt bodies — they fill the composer, not auto-send.
 */
function buildSuggestedPrompts(
  agentName: string | undefined,
  route: string | undefined,
  issueId: string | undefined,
): SuggestedPrompt[] {
  const name = agentName ?? "the agent";
  const out: SuggestedPrompt[] = [];
  out.push({
    label: "What's assigned to me?",
    body: `What issues are assigned to me right now? Group by status.`,
  });
  if (issueId) {
    out.push({
      label: "Summarize this issue",
      body: `Summarize the issue I'm currently viewing — status, blockers, recent activity.`,
    });
  } else if (route && route.startsWith("/w/")) {
    out.push({
      label: "Open issue from chat",
      body: `Open the most recent issue I touched and summarize where it left off.`,
    });
  } else {
    out.push({
      label: "Open issue from chat",
      body: `What's the most urgent thing on my plate right now? Open it for me.`,
    });
  }
  out.push({
    label: "Triage my queue",
    body: `Walk through my unassigned queue and suggest who to assign each issue to.`,
  });
  out.push({
    label: "What did I miss?",
    body: `What changed since my last session, ${name}? Recent comments and runs.`,
  });
  return out;
}

export function ChatThreadView({
  agentId,
  threadId: selectedThreadId,
  autoFocus = false,
}: {
  agentId: string;
  threadId?: string | null;
  /** Focus the composer textarea on mount (used when the Chat tab becomes active). */
  autoFocus?: boolean;
}) {
  const utils = trpc.useUtils();
  // Mutation that upserts + loads the default DM. Returns thread + agent + messages.
  const threadM = trpc.chat.thread.useMutation();
  const selectedThreadQ = trpc.chat.getThread.useQuery(
    { threadId: selectedThreadId ?? "" },
    { enabled: Boolean(selectedThreadId), staleTime: 10_000 },
  );
  // Run on mount whenever agentId changes and no concrete thread is selected.
  useEffect(() => {
    if (!selectedThreadId) threadM.mutate({ agentId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, selectedThreadId]);

  const data = selectedThreadId && selectedThreadQ.data
    ? { thread: selectedThreadQ.data, agent: selectedThreadQ.data.agent, messages: selectedThreadQ.data.messages }
    : threadM.data;
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

  // ---------- Streaming draft bubble (legacy MCP path) ----------
  const [draft, setDraft] = useState<DraftBubble | null>(null);

  // ---------- Direct streaming bubble (new /api/chat/stream path) ----------
  // Distinct from `draft` above so the two paths can co-exist while we
  // migrate. `streamBubble === null` means no active stream; non-null
  // means we're either mid-stream or just finished (held briefly while
  // the persisted AGENT message refetches).
  const [streamBubble, setStreamBubble] = useState<StreamBubble | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);

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
    if (selectedThreadId) {
      void utils.chat.getThread.invalidate({ threadId: selectedThreadId });
    } else {
      threadM.mutate({ agentId });
    }
  });

  const sendM = trpc.chat.send.useMutation({
    onSuccess: () => {
      if (selectedThreadId) void utils.chat.getThread.invalidate({ threadId: selectedThreadId });
      else threadM.mutate({ agentId });
      void utils.chat.threads.invalidate();
    },
  });
  const createPendingM = trpc.chat.createPendingMessage.useMutation();
  const dispatchM = trpc.chat.dispatchMessage.useMutation({
    onSuccess: () => {
      if (selectedThreadId) void utils.chat.getThread.invalidate({ threadId: selectedThreadId });
      else threadM.mutate({ agentId });
      void utils.chat.threads.invalidate();
    },
  });
  const initUploadM = trpc.attachment.initUpload.useMutation();
  const finalizeM = trpc.attachment.finalize.useMutation();
  const compactM = trpc.chat.compactThread.useMutation({
    onSuccess: () => void utils.chat.threads.invalidate(),
  });
  const [pendingDraft, setPendingDraft] = useState<{ body: string; files: string[] } | null>(null);
  const [fillRequest, setFillRequest] = useState<{ body: string; nonce: number } | null>(null);

  const ctx = useChatContext();
  const workspace = useMaybeWorkspace();

  const { data: workspaceAgents } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: Boolean(workspace), staleTime: 60_000 },
  );
  const mentionableAgents = useMemo<MentionableAgent[]>(
    () => (workspaceAgents ?? []).map((a) => ({ profileKey: a.profileKey, name: a.name })),
    [workspaceAgents],
  );

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

  /**
   * Run a streamed reply against /api/chat/stream. Parses SSE event blocks
   * inline; updates `streamBubble` for every delta so React paints the
   * partial response. Resolves once the server emits `done` or `error`.
   *
   * The dispatch path is NOT invoked — the route persists the USER row
   * with `streamed: true` and audit.ts short-circuits the webhook fan-out
   * for that case (see audit.ts branch (d)).
   */
  const runStreamingSend = useCallback(
    async (targetThreadId: string, body: string) => {
      // Cancel any in-flight stream before starting a new one.
      streamAbortRef.current?.abort();
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;

      setStreamBubble({
        messageId: null,
        body: "",
        thinking: "",
        toolCalls: [],
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        lastPrompt: body,
      });
      setIsStreaming(true);

      let res: Response;
      try {
        res = await fetch("/api/chat/stream", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: targetThreadId, body }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "Network error";
        setStreamBubble((b) =>
          b ? { ...b, error: msg, finishedAt: Date.now() } : b,
        );
        setIsStreaming(false);
        return;
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const msg = text || `Stream request failed (${res.status})`;
        setStreamBubble((b) =>
          b ? { ...b, error: msg, finishedAt: Date.now() } : b,
        );
        setIsStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";

      const handleEvent = (event: string, data: string) => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "meta") {
          const { messageId } = parsed as { messageId?: string };
          if (messageId) {
            setStreamBubble((b) => (b ? { ...b, messageId } : b));
          }
        } else if (event === "content") {
          const { delta } = parsed as { delta?: string };
          if (typeof delta === "string") {
            setStreamBubble((b) => (b ? { ...b, body: b.body + delta } : b));
          }
        } else if (event === "thinking") {
          const { delta } = parsed as { delta?: string };
          if (typeof delta === "string") {
            setStreamBubble((b) =>
              b ? { ...b, thinking: b.thinking + delta } : b,
            );
          }
        } else if (event === "tool_use") {
          // Legacy fallback — only fires when the loop never surfaced a
          // tool through the started→[confirm]→result canonical path.
          const tb = parsed as {
            id?: string;
            name?: string;
            args?: Record<string, unknown>;
          };
          if (tb.id && tb.name) {
            setStreamBubble((b) =>
              b
                ? {
                    ...b,
                    toolCalls: [
                      ...b.toolCalls,
                      {
                        id: tb.id!,
                        name: tb.name!,
                        args: tb.args ?? {},
                        requiresConfirm: false,
                        status: "executed",
                        summary: "(intent only — not executed)",
                      },
                    ],
                  }
                : b,
            );
          }
        } else if (event === "tool_call_started") {
          const tb = parsed as {
            id?: string;
            name?: string;
            args?: Record<string, unknown>;
            requiresConfirm?: boolean;
          };
          if (tb.id && tb.name) {
            setStreamBubble((b) => {
              if (!b) return b;
              const existing = b.toolCalls.find((c) => c.id === tb.id);
              if (existing) return b;
              return {
                ...b,
                toolCalls: [
                  ...b.toolCalls,
                  {
                    id: tb.id!,
                    name: tb.name!,
                    args: tb.args ?? {},
                    requiresConfirm: Boolean(tb.requiresConfirm),
                    status: "pending",
                  },
                ],
              };
            });
          }
        } else if (event === "tool_confirm") {
          const tb = parsed as {
            id?: string;
            name?: string;
            args?: Record<string, unknown>;
          };
          if (tb.id && tb.name) {
            setStreamBubble((b) => {
              if (!b) return b;
              const existing = b.toolCalls.find((c) => c.id === tb.id);
              if (existing) {
                return {
                  ...b,
                  toolCalls: b.toolCalls.map((c) =>
                    c.id === tb.id
                      ? { ...c, requiresConfirm: true, status: "pending" }
                      : c,
                  ),
                };
              }
              return {
                ...b,
                toolCalls: [
                  ...b.toolCalls,
                  {
                    id: tb.id!,
                    name: tb.name!,
                    args: tb.args ?? {},
                    requiresConfirm: true,
                    status: "pending",
                  },
                ],
              };
            });
          }
        } else if (event === "tool_result") {
          const tr = parsed as {
            id?: string;
            ok?: boolean;
            summary?: string;
            result?: unknown;
          };
          if (tr.id) {
            setStreamBubble((b) => {
              if (!b) return b;
              return {
                ...b,
                toolCalls: b.toolCalls.map((c) =>
                  c.id === tr.id
                    ? {
                        ...c,
                        status:
                          tr.ok === false
                            ? c.status === "declined"
                              ? "declined"
                              : "error"
                            : "executed",
                        summary: tr.summary,
                        result: tr.result,
                      }
                    : c,
                ),
              };
            });
          }
        } else if (event === "error") {
          const { message } = parsed as { message?: string };
          setStreamBubble((b) =>
            b
              ? {
                  ...b,
                  error: message ?? "Stream error",
                  finishedAt: b.finishedAt ?? Date.now(),
                }
              : b,
          );
        } else if (event === "done") {
          setStreamBubble((b) =>
            b ? { ...b, finishedAt: Date.now() } : b,
          );
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          // SSE separator is a blank line — split on it and parse complete
          // events. Whatever's after the last blank line gets carried to
          // the next iteration.
          let sepIdx = pending.indexOf("\n\n");
          while (sepIdx !== -1) {
            const block = pending.slice(0, sepIdx);
            pending = pending.slice(sepIdx + 2);
            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) continue;
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim());
              }
            }
            if (dataLines.length > 0) {
              handleEvent(eventName, dataLines.join("\n"));
            }
            sepIdx = pending.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          const msg = err instanceof Error ? err.message : "Stream interrupted";
          setStreamBubble((b) =>
            b
              ? { ...b, error: msg, finishedAt: b.finishedAt ?? Date.now() }
              : b,
          );
        }
      } finally {
        setIsStreaming(false);
        if (streamAbortRef.current === ctrl) streamAbortRef.current = null;
      }

      // Trigger a refetch so the persisted AGENT row replaces the bubble.
      // We hold the bubble visible briefly so the swap doesn't flicker.
      if (selectedThreadId) {
        void utils.chat.getThread.invalidate({ threadId: selectedThreadId });
      } else {
        threadM.mutate({ agentId });
      }
      void utils.chat.threads.invalidate();
      setTimeout(() => {
        // Only clear if not replaced by a newer stream.
        setStreamBubble((b) => (b && b.finishedAt ? null : b));
      }, 800);
    },
    // utils + threadM are stable refs from trpc; the linter doesn't know.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, selectedThreadId],
  );

  // Abort any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  const respondToTool = useCallback(
    async (callId: string, approved: boolean) => {
      setStreamBubble((b) => {
        if (!b) return b;
        return {
          ...b,
          toolCalls: b.toolCalls.map((c) =>
            c.id === callId
              ? { ...c, status: approved ? "approved" : "declined" }
              : c,
          ),
        };
      });
      try {
        const res = await fetch("/api/chat/tool/approve", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId, approved }),
        });
        if (!res.ok) {
          toast.error(`Approval response failed (${res.status})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Approval failed";
        toast.error(msg);
      }
    },
    [],
  );

  const handleSend = async (body: string, files: File[] = []) => {
    setPendingDraft({ body, files: files.map((f) => f.name || "attachment") });
    try {
      // Streaming path: text-only, requires a resolved threadId.
      if (files.length === 0 && threadId) {
        // Persist the USER row visually right away — runStreamingSend will
        // do the actual server write; the invalidate after `done` brings
        // the canonical row back. setPendingDraft drives the placeholder
        // bubble so the user sees their message instantly.
        await runStreamingSend(threadId, body);
        return;
      }
      if (files.length === 0) {
        // No resolved threadId yet (initial mount race) — fall back to
        // chat.send so the thread gets created server-side.
        await sendM.mutateAsync({
          agentId,
          threadId: selectedThreadId ?? undefined,
          body,
          context: currentContext,
        });
        return;
      }

      const pending = await createPendingM.mutateAsync({
        agentId,
        threadId: selectedThreadId ?? undefined,
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
      compactThread: async () => {
        if (!threadId) return;
        await compactM.mutateAsync({ threadId });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, agentFull?.runtimeMode, agentFull?.status, threadId, workspace?.slug]);

  // Auto-scroll to bottom on new messages.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, localMessages.length, draft?.body, streamBubble?.body]);

  const messageRows: ChatMessageRow[] = useMemo(
    () =>
      messages.map((m) => ({
        id: m.id,
        role: m.role as ChatMessageRow["role"],
        body: m.body,
        createdAt: m.createdAt,
        // Streaming path stashes thinking/tool_use blocks in
        // `contextSnapshot`. Forward whatever the router returns —
        // `chat-message.tsx` guards against missing/unrelated shapes.
        contextSnapshot:
          (m as { contextSnapshot?: unknown }).contextSnapshot ?? undefined,
      })),
    [messages],
  );

  // While a stream is in-flight (or held briefly after `done`), the
  // persisted AGENT row with the same messageId may also be in
  // `messageRows`. Suppress it so we don't show two copies of the same
  // reply during the swap window.
  const suppressedMessageId = streamBubble?.messageId ?? null;
  const visibleMessageRows = useMemo(
    () =>
      suppressedMessageId
        ? messageRows.filter((m) => m.id !== suppressedMessageId)
        : messageRows,
    [messageRows, suppressedMessageId],
  );

  // Merged display rows: persisted + local SYSTEM messages interleaved.
  // Local messages appear after the last persisted message.
  const displayRows: ChatMessageRow[] = useMemo(
    () => [...visibleMessageRows, ...localMessages],
    [visibleMessageRows, localMessages],
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

  // ---------- Thinking indicator logic (canonical dispatch state) ----------
  // Driven by `diagnostics.dispatchState` rather than a clock-only
  // heuristic, so the chat panel transitions from "wake sent" →
  // "acknowledged" → "running" the moment Hermes acks the inbox row
  // (or starts streaming a draft). Falls back to the legacy
  // "lastMessageIsUser + age" check only when diagnostics haven't
  // hydrated yet so the first render isn't blank.
  const lastMessage = displayRows[displayRows.length - 1];
  const lastPersistedMessage = messageRows[messageRows.length - 1];
  const lastMessageIsUser = lastPersistedMessage?.role === "USER";
  const lastMessageAge = lastPersistedMessage
    ? Date.now() - new Date(lastPersistedMessage.createdAt).getTime()
    : Infinity;
  const composerBusy =
    sendM.isPending ||
    createPendingM.isPending ||
    initUploadM.isPending ||
    finalizeM.isPending ||
    dispatchM.isPending ||
    isStreaming;
  const dispatchState = diagnostics?.dispatchState ?? null;
  // Canonical: show the typing bubble only when canonical state says
  // the agent is acknowledged/running. Wake-sent/queued get a
  // diagnostic line instead of the misleading typing animation.
  // When diagnostics haven't loaded yet, fall back to the old age
  // heuristic so the first paint is sensible.
  const canonicalKnown = dispatchState !== null;
  const canonicalShowsThinking =
    canonicalKnown &&
    (dispatchState === "acknowledged" || dispatchState === "running");
  const fallbackShowsThinking =
    !canonicalKnown && lastMessageIsUser && lastMessageAge < 300_000;
  const showThinking =
    !composerBusy &&
    !draft &&
    (canonicalShowsThinking || fallbackShowsThinking);
  const thinkingIsStale = canonicalKnown
    ? dispatchState === "stalled"
    : showThinking && lastMessageAge >= 60_000;
  const thinkingDetail =
    canonicalKnown
      ? dispatchState === "wake-sent"
        ? `Wake delivered · waiting for ${agent?.name ?? "agent"} to ack.`
        : dispatchState === "queued"
          ? "Queued · waking…"
          : dispatchState === "stalled"
            ? `${agent?.name ?? "Agent"} hasn't replied. Retry wake or kick from the status rail.`
            : dispatchState === "acknowledged"
              ? `${agent?.name ?? "Agent"} acknowledged the message · drafting…`
              : diagnostics?.lastRun?.status === "ACTIVE"
                ? `Still active: ${diagnostics.lastRun.currentStep ?? "running"}`
                : undefined
      : diagnostics?.lastRun
        ? diagnostics.lastRun.status === "ACTIVE"
          ? `Still active: ${diagnostics.lastRun.currentStep ?? "running"}`
          : `Run ${diagnostics.lastRun.status.toLowerCase()} · inspect status rail.`
        : diagnostics?.lastDelivery?.status === "FAILED"
          ? "Webhook delivery failed; retry is available in the status rail."
          : "No run/delivery record found yet; inspect agent status.";

  // Show a pre-typing diagnostic rail when the wake was sent but the
  // agent hasn't acknowledged yet — replaces the misleading
  // "infinite thinking" animation that the original heuristic produced.
  const showWakeDiagnostic =
    !composerBusy &&
    !draft &&
    !showThinking &&
    canonicalKnown &&
    (dispatchState === "queued" ||
      dispatchState === "wake-sent" ||
      dispatchState === "stalled");

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
              <div className="space-y-3">
                <p className="text-meta text-foreground/90">
                  Talk to <span className="font-medium">{agent.name}</span>. They can read your
                  current page, look up issues, and take actions on your behalf.
                </p>
                <div
                  className="grid grid-cols-2 gap-1.5"
                  data-testid="chat-suggested-prompts"
                >
                  {buildSuggestedPrompts(agent.name, ctx.route, ctx.issueId).map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() =>
                        setFillRequest((prev) => ({
                          body: p.body,
                          nonce: (prev?.nonce ?? 0) + 1,
                        }))
                      }
                      className="rounded-md border border-border/70 bg-card/40 px-2 py-1.5 text-left text-[0.6875rem] text-foreground/90 transition-colors hover:border-ember/40 hover:bg-ember/10"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="text-meta italic text-muted-foreground/60">
                  Type <span className="font-mono">/</span> for commands ·{" "}
                  <span className="font-mono">@</span> to mention another agent.
                </p>
              </div>
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
        {/* Streaming bubble (new /api/chat/stream path). Takes precedence
            over the legacy MCP draft + thinking/wake diagnostics so the
            direct streaming UI is what the operator sees while the model
            is actively responding. */}
        {streamBubble ? (
          <AgentStreamBubble
            bubble={streamBubble}
            agentName={agent?.name}
            onRetry={
              streamBubble.error && threadId
                ? () => {
                    const prompt = streamBubble.lastPrompt;
                    setStreamBubble(null);
                    void runStreamingSend(threadId, prompt);
                  }
                : undefined
            }
            onApprove={(callId) => void respondToTool(callId, true)}
            onDecline={(callId) => void respondToTool(callId, false)}
          />
        ) : draft ? (
          <AgentDraftBubble body={draft.body} agentName={agent?.name} />
        ) : showThinking ? (
          <AgentThinkingBubble stale={thinkingIsStale} detail={thinkingDetail} />
        ) : showWakeDiagnostic ? (
          <AgentWakeDiagnostic
            state={
              dispatchState as "queued" | "wake-sent" | "stalled"
            }
            agentName={agent?.name}
            wakeAttempts={diagnostics?.latestUserMessage?.wakeAttempts ?? 0}
            lastWakeAt={diagnostics?.latestUserMessage?.lastWakeAt ?? null}
          />
        ) : null}
      </div>
      <ChatComposer
        onSend={handleSend}
        disabled={composerBusy}
        isPending={composerBusy}
        placeholder={composerPlaceholder}
        banner={composerBanner}
        slashContext={slashContext}
        contextSummary={contextSummary}
        autoFocus={autoFocus}
        threadId={threadId}
        mentionableAgents={mentionableAgents}
        fillRequest={fillRequest ?? undefined}
      />
    </div>
  );
}
