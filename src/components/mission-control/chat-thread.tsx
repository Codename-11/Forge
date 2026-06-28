"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  CheckCheck,
  Layers,
  PlugZap,
  RefreshCw,
  Settings2,
  Square,
  Wrench,
} from "lucide-react";
import type { AgentProvider } from "@prisma/client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { formatChatContextSummary, useChatContext } from "@/hooks/use-chat-context";
import { useChatThreadReadMarker } from "@/hooks/use-chat-read-state";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { ChatMessageBubble, type ChatMessageRow } from "./chat-message";
import {
  ChatComposer,
  type ComposerContextItem,
  type MentionableAgent,
  type MentionablePerson,
} from "./chat-composer";
import { uploadAttachmentFile } from "@/components/attachments/attachment-upload-client";
import { toast } from "sonner";
import { ChatMarkdown } from "./chat-markdown";
import { ChatWorkTrace, type ChatTraceToolCall } from "./chat-work-trace";
import type { SlashCommandContext } from "@/lib/chat-slash-commands";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { Combobox } from "@/components/ui/combobox";
import { TransportChip } from "@/components/agents/transport-chip";
import { agentAvailabilityModel, presenceAvailability } from "@/lib/transport-display";

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

function normalizeChatBodyForMatch(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

type TurnPhase =
  | "idle"
  | "queued"
  | "delivered"
  | "read"
  | "thinking"
  | "running"
  | "completed"
  | "stalled"
  | "failed";

type TurnStatusView = {
  phase: TurnPhase;
  label: string;
  detail: string;
  tone: "muted" | "info" | "success" | "warning" | "danger";
  waitingMs: number | null;
} | null;

function turnProgressIndex(phase: TurnPhase, hasToolActivity: boolean, hasReplyText: boolean) {
  if (phase === "failed" || phase === "stalled") return 2;
  if (phase === "completed") return 4;
  if (hasReplyText) return 4;
  if (hasToolActivity) return 3;
  if (phase === "thinking" || phase === "running") return 2;
  if (phase === "read") return 1;
  if (phase === "delivered") return 0;
  return 0;
}

function ChatTurnProgress({
  status,
  isLive,
  streamBubble,
  supportsTools,
}: {
  status: TurnStatusView;
  isLive: boolean;
  streamBubble: StreamBubble | null;
  supportsTools: boolean;
}) {
  const visible = isLive || (status && status.phase !== "idle" && status.phase !== "completed");
  if (!visible) return null;
  const hasToolActivity = Boolean(streamBubble?.toolCalls.length);
  const hasReplyText = Boolean(streamBubble?.body.trim());
  const activeIndex = turnProgressIndex(status?.phase ?? "thinking", hasToolActivity, hasReplyText);
  const steps = [
    { key: "delivered", label: "Delivered", icon: Check },
    { key: "read", label: "Read", icon: CheckCheck },
    { key: "thinking", label: status?.phase === "running" ? "Running" : "Thinking", icon: Bot },
    { key: "tools", label: "Tools", icon: Wrench, optional: !supportsTools && !hasToolActivity },
    { key: "reply", label: "Reply", icon: Bot },
  ];
  const tone =
    status?.tone === "danger"
      ? "border-danger/30 bg-danger/10 text-danger"
      : status?.tone === "warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-border/60 bg-card/35 text-muted-foreground";
  return (
    <div className={cn("border-b px-3 py-1.5", tone)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-foreground">
            <Bot className="h-3 w-3 text-ember" />
            <span>{status?.label ?? (isLive ? "Thinking" : "Working")}</span>
            {streamBubble?.thinking && (
              <span className="rounded border border-border/60 bg-background/60 px-1 py-0 font-mono text-[0.5625rem] text-muted-foreground">
                thinking
              </span>
            )}
            {hasToolActivity && (
              <span className="rounded border border-ember/30 bg-ember/10 px-1 py-0 font-mono text-[0.5625rem] text-ember">
                {streamBubble?.toolCalls.length} tool
                {streamBubble?.toolCalls.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {status?.detail && (
            <div className="text-meta mt-0.5 truncate text-muted-foreground/75">
              {status.detail}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {steps
            .filter((step) => !step.optional)
            .map((step, idx) => {
              const Icon = step.icon;
              const done = idx < activeIndex || status?.phase === "completed";
              const active = idx === activeIndex && status?.phase !== "completed";
              return (
                <span
                  key={step.key}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[0.5625rem] uppercase tracking-wider",
                    done
                      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : active
                        ? "border-ember/35 bg-ember/10 text-ember"
                        : "border-border/50 bg-background/40 text-muted-foreground/55",
                  )}
                  title={step.label}
                >
                  <Icon className={cn("h-3 w-3", active && isLive && "animate-pulse")} />
                  <span className="hidden sm:inline">{step.label}</span>
                </span>
              );
            })}
        </div>
      </div>
    </div>
  );
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

/**
 * Sentinel used as `streamBubble.error` when the operator clicked Stop.
 * Distinct from real stream errors so the bubble renders a quiet
 * "(stopped)" indicator instead of the amber Retry rail.
 */
const STREAM_STOP_SENTINEL = "__forge_stream_stopped__";

const ALWAYS_ALLOW_KEY = (threadId: string, toolName: string) =>
  `forge.chat.alwaysAllow.${threadId}.${toolName}`;

function isAlwaysAllowed(threadId: string, toolName: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ALWAYS_ALLOW_KEY(threadId, toolName)) === "1";
  } catch {
    return false;
  }
}

function rememberAlwaysAllowed(threadId: string, toolName: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ALWAYS_ALLOW_KEY(threadId, toolName), "1");
  } catch {
    /* localStorage may be blocked — silently degrade to per-call confirm */
  }
}

/** In-flight streaming bubble from /api/chat/stream (distinct from the
 * legacy MCP-driven draft bubble above, which is still used by the
 * dispatch path when Hermes streams via `chat.startDraft`). */
export type StreamToolCall = ChatTraceToolCall & {
  requiresConfirm: boolean;
};

type StreamBubble = {
  messageId: string | null;
  runExternalId: string | null;
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
 * Streaming bubble UI. Shows the compact work trace, live content, and
 * approval controls for write-class tools that pause the loop.
 */
function AgentStreamBubble({
  bubble,
  agentName,
  onRetry,
  onStop,
  onApprove,
  onDecline,
  threadId,
}: {
  bubble: StreamBubble;
  agentName?: string;
  onRetry?: () => void;
  onStop?: () => void;
  onApprove?: (callId: string, alwaysAllow?: boolean) => void;
  onDecline?: (callId: string) => void;
  threadId?: string;
}) {
  const isLive = bubble.finishedAt === null && !bubble.error;
  const wasStopped = bubble.error === STREAM_STOP_SENTINEL;
  const elapsedMs = bubble.finishedAt ? bubble.finishedAt - bubble.startedAt : null;
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ember/15 text-ember">
        <Bot className="h-3 w-3" />
      </span>
      <div className="min-w-0 max-w-[85%] space-y-1.5 rounded-md border border-border bg-card/60 px-2 py-1.5 text-[0.75rem] text-foreground">
        {agentName && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {agentName}
              {wasStopped && (
                <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">
                  (stopped)
                </span>
              )}
            </span>
            {isLive && onStop && (
              <button
                type="button"
                onClick={onStop}
                title="Stop generating"
                className="inline-flex h-4 w-4 items-center justify-center rounded border border-border bg-card/40 text-muted-foreground hover:text-foreground"
              >
                <Square className="h-2.5 w-2.5" fill="currentColor" />
              </button>
            )}
          </div>
        )}

        <ChatWorkTrace
          thinking={bubble.thinking}
          tools={bubble.toolCalls}
          elapsedMs={elapsedMs}
          live={isLive}
          threadId={threadId}
          onApprove={onApprove}
          onDecline={onDecline}
        />

        {bubble.body ? (
          isLive ? (
            // While streaming, render the raw text with the M5 ember-sweep
            // shimmer + trailing ember caret (forge-streaming-cursor).
            // Markdown parsing waits until the body commits — `background-
            // clip:text` needs plain text to clip the gradient fill, and the
            // persisted bubble re-renders as real, selectable markdown via
            // the realtime refetch.
            <div className="forge-streaming forge-streaming-cursor whitespace-pre-wrap break-words">
              {bubble.body}
            </div>
          ) : (
            <ChatMarkdown body={bubble.body} />
          )
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

        {bubble.error && !wasStopped && (
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

interface SuggestedPrompt {
  label: string;
  body: string;
}

type ChatSendContext = {
  route?: string;
  slug?: string;
  issueId?: string;
  selectedIds?: string[];
  pinnedRunIds?: string[];
  liveRunIds?: string[];
  visibleEntities?: Array<{ kind: string; ids: string[] }>;
};

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

/**
 * Per-thread provider/model override popover. Anchored to a gear icon
 * in the chat header. Two controls:
 *   - Provider select — "use agent default" | HERMES | CLAUDE | CODEX | CUSTOM.
 *   - Model text input — debounced commit (500ms).
 *
 * Both are optional; clearing either reverts to the agent / provider
 * default at the next stream call. Active overrides surface as a small
 * "via <provider>" pill next to the agent name (rendered by the header,
 * not here).
 */
function ProviderOverridePopover({
  threadId,
  providerOverride,
  modelOverride,
  yoloModeOverride,
  runtimeYoloDefault,
  defaultProvider,
}: {
  threadId: string;
  providerOverride: AgentProvider | null;
  modelOverride: string | null;
  yoloModeOverride: boolean | null;
  runtimeYoloDefault: boolean;
  defaultProvider: AgentProvider;
}) {
  const utils = trpc.useUtils();
  const setOverrideM = trpc.chat.setOverride.useMutation({
    onSuccess: () => {
      void utils.chat.getThread.invalidate({ threadId });
      void utils.chat.threads.invalidate();
    },
  });
  const [open, setOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState(modelOverride ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setModelDraft(modelOverride ?? "");
  }, [modelOverride]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-chat-override-popover]")) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const commitModel = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      const normalised = trimmed.length > 0 ? trimmed : null;
      if (normalised === (modelOverride ?? null)) return;
      setOverrideM.mutate({ threadId, model: normalised });
    },
    [modelOverride, threadId, setOverrideM],
  );

  const onModelChange = (next: string) => {
    setModelDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitModel(next), 500);
  };

  const onProviderChange = (next: string) => {
    const value = next === "" ? null : (next as AgentProvider);
    setOverrideM.mutate({ threadId, provider: value });
  };

  const onYoloChange = (next: string) => {
    const value = next === "inherit" ? null : next === "on";
    setOverrideM.mutate({ threadId, yoloMode: value });
  };

  const overridesActive =
    providerOverride !== null ||
    (modelOverride !== null && modelOverride.length > 0) ||
    yoloModeOverride !== null;

  return (
    <div data-chat-override-popover className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Thread settings"
        className={cn(
          "inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-card/40 text-muted-foreground hover:text-foreground",
          overridesActive && "text-ember",
        )}
      >
        <Settings2 className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-20 w-64 space-y-2 rounded-md border border-border bg-card/95 p-2 text-[0.6875rem] shadow-lg backdrop-blur">
          <div className="space-y-1">
            <label className="block text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Provider override
            </label>
            <Combobox
              value={providerOverride ?? null}
              onChange={(v) => onProviderChange(v ?? "")}
              options={[
                { value: "HERMES", label: "HERMES" },
                { value: "CLAUDE", label: "CLAUDE" },
                { value: "CODEX", label: "CODEX" },
                { value: "CUSTOM", label: "CUSTOM" },
              ]}
              allowNone
              noneLabel={`Use agent default (${defaultProvider})`}
              placeholder={`Use agent default (${defaultProvider})`}
              ariaLabel="Provider override"
              matchTriggerWidth
              className="w-full"
            />
            <p className="text-[0.5625rem] italic text-muted-foreground/60">
              Routes this thread to the chosen platform&apos;s configured chat backend — it does not
              fall back to another. A provider with no chat model (a pull/act CLI, or an unset API
              key) returns a &ldquo;no chat model configured&rdquo; notice rather than answering as
              a different platform.
            </p>
          </div>
          <div className="space-y-1">
            <label className="block text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Model override
            </label>
            <input
              type="text"
              value={modelDraft}
              onChange={(e) => onModelChange(e.target.value)}
              onBlur={() => commitModel(modelDraft)}
              placeholder="e.g. claude-opus-4-5"
              className="w-full rounded border border-border bg-background/60 px-1.5 py-1 font-mono text-[0.6875rem] text-foreground focus:outline-none focus:ring-1 focus:ring-ember/40"
            />
            <p className="text-[0.5625rem] italic text-muted-foreground/60">
              Leave blank to use the provider default.
            </p>
          </div>
          <div className="space-y-1">
            <label className="block text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              YOLO mode
            </label>
            <Combobox
              value={
                yoloModeOverride === null ? "inherit" : yoloModeOverride ? "on" : "off"
              }
              onChange={(v) => onYoloChange(v ?? "inherit")}
              options={[
                {
                  value: "inherit",
                  label: `Inherit runtime default (${runtimeYoloDefault ? "on" : "off"})`,
                },
                { value: "on", label: "Force on" },
                { value: "off", label: "Force off" },
              ]}
              ariaLabel="YOLO mode"
              matchTriggerWidth
              className="w-full"
            />
            <p className="text-[0.5625rem] italic text-muted-foreground/60">
              Codex uses full-access/no-approval turn policy; Hermes approvals are auto-approved.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function runtimeConfigYoloDefault(agent: unknown): boolean {
  const runtime = (agent as { runtime?: { config?: unknown } | null } | null)?.runtime;
  const config = runtime?.config;
  return !!(
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    (config as Record<string, unknown>).yoloMode === true
  );
}

export function ChatThreadView({
  agentId,
  threadId: selectedThreadId,
  initialDraft,
  autoFocus = false,
  onThreadCreated,
}: {
  agentId: string;
  threadId?: string | null;
  /** Optional one-shot composer seed from a deep link. Never auto-sends. */
  initialDraft?: string | null;
  /** Focus the composer textarea on mount (used when the Chat tab becomes active). */
  autoFocus?: boolean;
  /** Called when this surface creates a new conversation, e.g. `/new`. */
  onThreadCreated?: (threadId: string, agentId: string) => void;
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

  const data =
    selectedThreadId && selectedThreadQ.data
      ? {
          thread: selectedThreadQ.data,
          agent: selectedThreadQ.data.agent,
          messages: selectedThreadQ.data.messages,
        }
      : threadM.data;
  const threadId = data?.thread.id;
  const providerOverride =
    (data?.thread as { providerOverride?: AgentProvider | null } | undefined)?.providerOverride ??
    null;
  const modelOverride =
    (data?.thread as { modelOverride?: string | null } | undefined)?.modelOverride ?? null;
  const yoloModeOverride =
    (data?.thread as { yoloModeOverride?: boolean | null } | undefined)?.yoloModeOverride ?? null;
  const { data: diagnostics } = trpc.chat.threadDiagnostics.useQuery(
    { threadId: threadId ?? "" },
    { enabled: Boolean(threadId), staleTime: 10_000 },
  );
  // Fetch full agent data (includes runtimeMode + lastHeartbeatAt) separately.
  const { data: agentFull } = trpc.agent.byId.useQuery(
    { id: agentId },
    { enabled: Boolean(agentId), staleTime: 10_000 },
  );
  // Will a chat turn actually reach a model? Drives the pre-send steering
  // banner so a pull/act CLI connection (or an agent with no configured
  // model) points the operator at attaching a chat-capable runtime instead
  // of presenting an input that can only error.
  const { data: readiness } = trpc.chat.chatReadiness.useQuery(
    { agentId, threadId: threadId ?? undefined },
    { enabled: Boolean(agentId), staleTime: 30_000 },
  );
  // Use agentFull for rich presence fields, fall back to thread data for basics.
  const agent = agentFull ?? data?.agent;
  const runtimeYoloDefault = runtimeConfigYoloDefault(agentFull);
  const effectiveYoloMode = yoloModeOverride ?? runtimeYoloDefault;
  const messages = useMemo(() => data?.messages ?? [], [data?.messages]);
  const latestVisibleMessageAt = messages.at(-1)?.createdAt ?? null;

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
  const streamBubbleRef = useRef<StreamBubble | null>(null);
  streamBubbleRef.current = streamBubble;
  const [isStreaming, setIsStreaming] = useState(false);
  const [localReadReceipts, setLocalReadReceipts] = useState<Record<string, string>>({});
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
  const clearThreadM = trpc.chat.clearThread.useMutation({
    onSuccess: async () => {
      if (threadId) await utils.chat.getThread.invalidate({ threadId });
      await utils.chat.threadDiagnostics.invalidate();
      await utils.chat.threads.invalidate();
    },
  });
  const createConversationM = trpc.chat.createConversation.useMutation({
    onSuccess: async () => {
      await utils.chat.threads.invalidate();
    },
  });
  const forkThreadM = trpc.chat.forkThread.useMutation({
    onSuccess: async (result) => {
      toast.success("Conversation forked");
      await utils.chat.threads.invalidate();
      await utils.chat.getThread.invalidate({ threadId: result.thread.id });
      onThreadCreated?.(result.thread.id, result.agent.id);
    },
    onError: (err) => toast.error(err.message),
  });
  // Backs the `/engine` slash command — switches this agent's chat engine.
  const setEngineM = trpc.agent.update.useMutation({
    onSuccess: () => void utils.agent.byId.invalidate({ id: agentId }),
  });
  // Outbound queue. Submitting never blocks on the in-flight send — the
  // message leaves the composer immediately and joins the queue, which
  // drains FIFO (one stream at a time). Per-item status:
  //   queued  — waiting its turn (muted, "Queued", cancelable)
  //   sending — being streamed now (muted, "Sending…", cancelable)
  //   sent    — server persisted it (response accepted; meta supplies row id)
  //   read    — stream meta acknowledged the turn before refetch catches up
  //   failed  — the send never reached the server; survives with Retry +
  //             Cancel, blocks the queue behind it until resolved.
  // `rawFiles` is kept so retry / deferred sends can re-upload.
  type Outbound = {
    id: string;
    body: string;
    context: ChatSendContext;
    createdAt: number;
    rawFiles: File[];
    displayFiles: string[];
    status: "queued" | "sending" | "sent" | "read" | "failed";
    /** Persisted USER ChatMessage id once the stream route acknowledges it. */
    serverMessageId?: string;
  };
  const [outbox, setOutbox] = useState<Outbound[]>([]);
  const outboxRef = useRef<Outbound[]>([]);
  outboxRef.current = outbox;
  const sendingRef = useRef(false);
  const queueIdRef = useRef(0);
  const markOutbox = useCallback(
    (id: string, status: Outbound["status"], serverMessageId?: string) => {
      setOutbox((q) =>
        q.map((m) =>
          m.id === id
            ? {
                ...m,
                status,
                ...(serverMessageId ? { serverMessageId } : {}),
              }
            : m,
        ),
      );
    },
    [],
  );
  const removeOutbox = useCallback((id: string) => {
    setOutbox((q) => q.filter((m) => m.id !== id));
  }, []);
  const [fillRequest, setFillRequest] = useState<{ body: string; nonce: number } | null>(null);

  const ctx = useChatContext();
  const workspace = useMaybeWorkspace();
  const pathname = usePathname();

  useChatThreadReadMarker({
    slug: workspace?.slug,
    threadId,
    latestMessageAt: latestVisibleMessageAt,
  });

  // Detect the canvas the operator is currently viewing. URL shape is
  // `/w/{slug}/canvas/{canvasId}`. The id is passed to /api/chat/stream
  // so the agent's system prompt sees the canvas state and can act on it.
  const canvasIdFromRoute = useMemo(() => {
    if (!pathname) return null;
    const match = pathname.match(/\/w\/[^/]+\/canvas\/([^/?#]+)/);
    return match?.[1] ?? null;
  }, [pathname]);
  const { data: boundCanvas } = trpc.canvas.get.useQuery(
    { id: canvasIdFromRoute ?? "" },
    {
      enabled: Boolean(canvasIdFromRoute),
      staleTime: 30_000,
    },
  );
  // Stable ref so runStreamingSend doesn't have to depend on canvasId
  // and re-bind on every navigation.
  const canvasIdRef = useRef<string | null>(null);
  canvasIdRef.current = canvasIdFromRoute;

  const { data: workspaceAgents } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: Boolean(workspace), staleTime: 60_000 },
  );
  const { data: workspaceMembers } = trpc.workspace.members.useQuery(undefined, {
    enabled: Boolean(workspace),
    staleTime: 60_000,
  });
  const mentionableAgents = useMemo<MentionableAgent[]>(
    () =>
      (workspaceAgents ?? []).map((a) => ({
        profileKey: a.profileKey,
        name: a.name,
        status: a.status,
        avatar: a.avatar ?? null,
        lastHeartbeatAt: a.lastHeartbeatAt ?? null,
        availability: presenceAvailability(a),
      })),
    [workspaceAgents],
  );
  const mentionablePeople = useMemo<MentionablePerson[]>(
    () =>
      (workspaceMembers ?? [])
        .filter((m) => m.user.handle)
        .map((m) => ({
          handle: (m.user.handle ?? "").toLowerCase(),
          name: m.user.name ?? m.user.email ?? m.user.handle ?? "user",
          image: m.user.image ?? null,
          email: m.user.email ?? null,
        })),
    [workspaceMembers],
  );

  const currentContext = useMemo<ChatSendContext>(
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

  const [excludedContextKeys, setExcludedContextKeys] = useState<Set<string>>(() => new Set());
  const contextItems = useMemo<ComposerContextItem[]>(() => {
    const items: ComposerContextItem[] = [];
    if (currentContext.route) {
      items.push({
        key: "route",
        label: `route:${currentContext.route.replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")}`,
        included: !excludedContextKeys.has("route"),
      });
    }
    if (currentContext.issueId) {
      items.push({
        key: "issueId",
        label: `issue:${currentContext.issueId}`,
        included: !excludedContextKeys.has("issueId"),
      });
    }
    if (currentContext.selectedIds?.length) {
      items.push({
        key: "selectedIds",
        label: `selected:${currentContext.selectedIds.length}`,
        included: !excludedContextKeys.has("selectedIds"),
      });
    }
    const visibleCount =
      currentContext.visibleEntities?.reduce((sum, entity) => sum + entity.ids.length, 0) ?? 0;
    if (visibleCount) {
      items.push({
        key: "visibleEntities",
        label: `visible:${visibleCount}`,
        included: !excludedContextKeys.has("visibleEntities"),
      });
    }
    if (currentContext.pinnedRunIds?.length) {
      items.push({
        key: "pinnedRunIds",
        label: `pinned-runs:${currentContext.pinnedRunIds.length}`,
        included: !excludedContextKeys.has("pinnedRunIds"),
      });
    }
    if (currentContext.liveRunIds?.length) {
      items.push({
        key: "liveRunIds",
        label: `live-runs:${currentContext.liveRunIds.length}`,
        included: !excludedContextKeys.has("liveRunIds"),
      });
    }
    if (currentContext.slug) {
      items.push({
        key: "slug",
        label: `workspace:${currentContext.slug}`,
        included: !excludedContextKeys.has("slug"),
      });
    }
    return items;
  }, [currentContext, excludedContextKeys]);
  useEffect(() => {
    const validKeys = new Set(contextItems.map((item) => item.key));
    setExcludedContextKeys((prev) => {
      const next = new Set([...prev].filter((key) => validKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [contextItems]);
  const toggleContextItem = useCallback((key: string) => {
    setExcludedContextKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const sendContext = useMemo<ChatSendContext>(
    () => ({
      route: excludedContextKeys.has("route") ? undefined : currentContext.route,
      slug: excludedContextKeys.has("slug") ? undefined : currentContext.slug,
      issueId: excludedContextKeys.has("issueId") ? undefined : currentContext.issueId,
      selectedIds: excludedContextKeys.has("selectedIds") ? undefined : currentContext.selectedIds,
      pinnedRunIds: excludedContextKeys.has("pinnedRunIds")
        ? undefined
        : currentContext.pinnedRunIds,
      liveRunIds: excludedContextKeys.has("liveRunIds") ? undefined : currentContext.liveRunIds,
      visibleEntities: excludedContextKeys.has("visibleEntities")
        ? undefined
        : currentContext.visibleEntities,
    }),
    [currentContext, excludedContextKeys],
  );
  const contextSummary = useMemo(() => formatChatContextSummary(sendContext), [sendContext]);

  /**
   * Run a streamed reply against /api/chat/stream. Parses SSE event blocks
   * inline; updates `streamBubble` for every delta so React paints the
   * partial response. Resolves once the server emits `done` or `error`.
   *
   * Forge-owned runs/completions stream the reply directly. Dispatch-backed
   * agents get the same persisted USER row, but the route closes after the
   * wake handoff so the daemon/runtime can answer via chat drafts.
   */
  const runStreamingSend = useCallback(
    async (
      targetThreadId: string,
      body: string,
      opts?: {
        attachmentIds?: string[];
        pendingMessageId?: string;
        outboxId?: string;
        context?: ChatSendContext;
      },
    ) => {
      const outboxId = opts?.outboxId;
      // Cancel any in-flight stream before starting a new one.
      streamAbortRef.current?.abort();
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;

      const initialStreamBubble = (): StreamBubble => ({
        messageId: null,
        runExternalId: null,
        body: "",
        thinking: "",
        toolCalls: [],
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        lastPrompt: body,
      });
      setStreamBubble(null);
      setIsStreaming(true);

      // Whether the server accepted the send (HTTP response received OK).
      // The route persists the USER row in a transaction *before* it returns
      // the stream, so a 2xx response is a reliable "delivered" signal —
      // independent of when (or whether) the `meta` SSE event reaches us.
      // Decides where a failure surfaces: before acceptance the *send*
      // failed (Failed+Retry on the user bubble); after acceptance the
      // message was sent and only the agent *reply* failed (Retry on the
      // agent bubble).
      let serverAccepted = false;
      let aborted = false;
      const refreshThread = () => {
        void utils.chat.getThread.invalidate({ threadId: targetThreadId });
        void utils.chat.threads.invalidate();
      };
      const failSend = (message: string) => {
        if (serverAccepted) {
          setStreamBubble((b) => {
            const base = b ?? initialStreamBubble();
            return { ...base, error: message, finishedAt: base.finishedAt ?? Date.now() };
          });
        } else {
          if (outboxId) markOutbox(outboxId, "failed");
          setStreamBubble(null);
        }
      };

      let res: Response;
      try {
        res = await fetch("/api/chat/stream", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: targetThreadId,
            body,
            canvasId: canvasIdRef.current ?? undefined,
            context: opts?.context ?? {},
            attachments: opts?.attachmentIds,
            pendingMessageId: opts?.pendingMessageId,
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (ctrl.signal.aborted) {
          // Canceled before the request returned. The message has no
          // confirmed server receipt, so drop the optimistic bubble; the
          // operator can send again if needed.
          if (outboxId) removeOutbox(outboxId);
          setStreamBubble(null);
          setIsStreaming(false);
          return;
        }
        const msg = err instanceof Error ? err.message : "Network error";
        failSend(msg);
        setIsStreaming(false);
        return;
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const msg = text || `Stream request failed (${res.status})`;
        failSend(msg);
        setIsStreaming(false);
        return;
      }

      // Response accepted → the USER row is persisted. Flip the receipt to
      // "Sent" now, without waiting for the `meta` SSE event (which can be
      // delayed by a slow/hanging agent or proxy buffering).
      serverAccepted = true;
      if (outboxId) markOutbox(outboxId, "sent");
      refreshThread();

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
          const { messageId, userMessageId, acknowledgedAt, outputStartedAt } = parsed as {
            messageId?: string;
            userMessageId?: string;
            acknowledgedAt?: string;
            outputStartedAt?: string;
          };
          const runExternalId =
            typeof (parsed as { runExternalId?: unknown }).runExternalId === "string"
              ? (parsed as { runExternalId: string }).runExternalId
              : undefined;
          const dispatchOnly = (parsed as { dispatch?: boolean }).dispatch === true;
          if (messageId) {
            setStreamBubble((b) => ({
              ...(b ?? initialStreamBubble()),
              messageId,
              ...(runExternalId ? { runExternalId } : {}),
            }));
          } else if (runExternalId) {
            setStreamBubble((b) => ({ ...(b ?? initialStreamBubble()), runExternalId }));
          } else if (dispatchOnly) {
            setStreamBubble(null);
          }
          if (outboxId && userMessageId) {
            markOutbox(
              outboxId,
              acknowledgedAt || outputStartedAt ? "read" : "sent",
              userMessageId,
            );
          }
          if (userMessageId && (acknowledgedAt || outputStartedAt)) {
            const readAt = acknowledgedAt ?? outputStartedAt ?? new Date().toISOString();
            setLocalReadReceipts((prev) => ({ ...prev, [userMessageId]: readAt }));
          }
          refreshThread();
          // Receipt already flipped to "Sent" on response acceptance; meta
          // also carries the persisted USER id so the optimistic bubble can
          // disappear as soon as the real row refetches.
        } else if (event === "content") {
          const { delta } = parsed as { delta?: string };
          if (typeof delta === "string") {
            setStreamBubble((b) => {
              const base = b ?? initialStreamBubble();
              return { ...base, body: base.body + delta };
            });
          }
        } else if (event === "thinking") {
          const { delta } = parsed as { delta?: string };
          if (typeof delta === "string") {
            setStreamBubble((b) => {
              const base = b ?? initialStreamBubble();
              return { ...base, thinking: base.thinking + delta };
            });
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
            setStreamBubble((b) => ({
              ...(b ?? initialStreamBubble()),
              toolCalls: [
                ...(b?.toolCalls ?? []),
                {
                  id: tb.id!,
                  name: tb.name!,
                  args: tb.args ?? {},
                  requiresConfirm: false,
                  status: "executed",
                  summary: "(intent only — not executed)",
                },
              ],
            }));
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
              const base = b ?? initialStreamBubble();
              const existing = base.toolCalls.find((c) => c.id === tb.id);
              if (existing) return base;
              return {
                ...base,
                toolCalls: [
                  ...base.toolCalls,
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
              const base = b ?? initialStreamBubble();
              const existing = base.toolCalls.find((c) => c.id === tb.id);
              if (existing) {
                return {
                  ...base,
                  toolCalls: base.toolCalls.map((c) =>
                    c.id === tb.id ? { ...c, requiresConfirm: true, status: "pending" } : c,
                  ),
                };
              }
              return {
                ...base,
                toolCalls: [
                  ...base.toolCalls,
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
            if (isAlwaysAllowed(targetThreadId, tb.name)) {
              void respondToToolRef.current?.(tb.id, true);
            }
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
              const base = b ?? initialStreamBubble();
              return {
                ...base,
                toolCalls: base.toolCalls.map((c) =>
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
          failSend(message ?? "Stream error");
        } else if (event === "done") {
          setStreamBubble((b) => (b ? { ...b, finishedAt: Date.now() } : b));
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
        if (ctrl.signal.aborted) {
          aborted = true;
          setStreamBubble((b) =>
            b
              ? {
                  ...b,
                  error: STREAM_STOP_SENTINEL,
                  finishedAt: b.finishedAt ?? Date.now(),
                }
              : b,
          );
        } else {
          const msg = err instanceof Error ? err.message : "Stream interrupted";
          failSend(msg);
        }
      } finally {
        setIsStreaming(false);
        if (streamAbortRef.current === ctrl) streamAbortRef.current = null;
      }

      // Resolve the optimistic outbox bubble. If the server accepted the
      // send, drop it — the refetched persisted row (with its real receipt)
      // takes over. If it was canceled before reaching the server, drop it
      // too. A pre-acceptance *failure* is left as "failed" (failSend kept
      // it) so the operator can Retry.
      if (outboxId) {
        if (serverAccepted || aborted) {
          removeOutbox(outboxId);
          if (aborted && !serverAccepted) setStreamBubble(null);
        }
      }

      // Trigger a refetch so the persisted AGENT row replaces the bubble.
      // We hold the bubble visible briefly so the swap doesn't flicker.
      refreshThread();
      setTimeout(() => {
        // Clear the finished bubble so the persisted AGENT row takes over —
        // BUT keep it when it carries a real error. An errored reply has no
        // persisted row to swap in, so dropping it would make the amber
        // "no chat model configured / stream failed" banner vanish a beat
        // after it appears (the bug operators hit when messaging a provider
        // with no chat backend). The banner must persist until the operator
        // resolves it (Retry) or sends another message, which replaces the
        // bubble at the top of runStreamingSend. A user-initiated Stop
        // (STREAM_STOP_SENTINEL) is not an error and still clears.
        setStreamBubble((b) =>
          b && b.finishedAt && (!b.error || b.error === STREAM_STOP_SENTINEL) ? null : b,
        );
      }, 800);
    },
    // utils + threadM are stable refs from trpc; the linter doesn't know.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, selectedThreadId],
  );

  const stopActiveStream = useCallback(() => {
    const active = streamBubbleRef.current;
    if (threadId && active?.messageId) {
      void fetch("/api/chat/stream/stop", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, messageId: active.messageId }),
      }).catch(() => {
        /* The local stream still detaches below; status rail/logs carry failures. */
      });
    }
    streamAbortRef.current?.abort();
  }, [threadId]);

  // Abort any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  const respondToTool = useCallback(
    async (callId: string, approved: boolean, alwaysAllow?: boolean) => {
      let toolName: string | null = null;
      setStreamBubble((b) => {
        if (!b) return b;
        return {
          ...b,
          toolCalls: b.toolCalls.map((c) => {
            if (c.id === callId) {
              toolName = c.name;
              return { ...c, status: approved ? "approved" : "declined" };
            }
            return c;
          }),
        };
      });
      if (approved && alwaysAllow && toolName && threadId) {
        rememberAlwaysAllowed(threadId, toolName);
      }
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
    [threadId],
  );
  // Held in a ref so the SSE handler inside runStreamingSend can reach the
  // latest closure without re-binding the callback on every threadId tick.
  const respondToToolRef = useRef(respondToTool);
  respondToToolRef.current = respondToTool;

  // Send a single outbox item. The streaming path hands ownership of the
  // item's lifecycle (sent / failed / removed) to `runStreamingSend` via
  // `outboxId`; the no-threadId fallback resolves it here.
  const sendOne = async (item: Outbound) => {
    const { id, body, context, rawFiles: files } = item;
    try {
      // Streaming path with optional attachments. Uploads target the
      // *pending* message id we create first; the streaming route then
      // re-targets those attachment rows at the real USER ChatMessage it
      // persists (see `attachments.updateMany` in route.ts).
      if (threadId) {
        const attachmentIds: string[] = [];
        let pendingMessageId: string | undefined;
        if (files.length > 0) {
          const pending = await createPendingM.mutateAsync({
            agentId,
            threadId: selectedThreadId ?? undefined,
            body,
            context,
          });
          pendingMessageId = pending.messageId;
          for (const file of files) {
            const { attachmentId } = await uploadAttachmentFile({
              file,
              targetType: "chat-message",
              targetId: pending.messageId,
              initUpload: initUploadM.mutateAsync,
              finalize: finalizeM.mutateAsync,
            });
            attachmentIds.push(attachmentId);
          }
          await utils.attachment.list.invalidate({
            targetType: "chat-message",
            targetId: pending.messageId,
          });
        }
        await runStreamingSend(threadId, body, {
          attachmentIds,
          pendingMessageId,
          outboxId: id,
          context,
        });
        return;
      }

      // No resolved threadId yet (initial mount race) — legacy non-stream
      // fallback so the message still lands.
      if (files.length === 0) {
        await sendM.mutateAsync({
          agentId,
          threadId: selectedThreadId ?? undefined,
          body,
          context,
        });
      } else {
        const pending = await createPendingM.mutateAsync({
          agentId,
          threadId: selectedThreadId ?? undefined,
          body,
          context,
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
      }
      // Fallback succeeded → drop the optimistic bubble; the refetch shows
      // the persisted row.
      removeOutbox(id);
    } catch (err) {
      // Upload / pending-row failure (pre-send). Leave the bubble as
      // Failed+Retry instead of throwing — the composer already cleared and
      // the queued item (with rawFiles) owns the retry.
      const message = err instanceof Error ? err.message : "Failed to send message";
      toast.error(message);
      markOutbox(id, "failed");
    }
  };

  // Drain the outbox FIFO, one stream at a time. A "failed" item at the head
  // of the still-pending set blocks the queue until the operator retries or
  // cancels it (so messages never go out of order). Re-entrancy is guarded
  // by `sendingRef`; the `outbox` effect below re-kicks on every change.
  const processQueue = async () => {
    if (sendingRef.current) return;
    const next = outboxRef.current.find((m) => m.status === "queued" || m.status === "failed");
    if (!next || next.status === "failed") return;
    sendingRef.current = true;
    markOutbox(next.id, "sending");
    try {
      await sendOne(next);
    } finally {
      sendingRef.current = false;
      void processQueueRef.current?.();
    }
  };
  const processQueueRef = useRef(processQueue);
  processQueueRef.current = processQueue;
  useEffect(() => {
    void processQueueRef.current?.();
  }, [outbox]);

  // Composer onSend: never blocks. The message leaves the input immediately
  // and joins the queue; the processor sends it when its turn comes.
  const handleSend = (body: string, files: File[] = []) => {
    const id = `_q_${++queueIdRef.current}`;
    setOutbox((q) => [
      ...q,
      {
        id,
        body,
        context: sendContext,
        createdAt: Date.now(),
        rawFiles: files,
        displayFiles: files.map((f) => f.name || "attachment"),
        status: "queued",
      },
    ]);
  };

  const retryOutbox = (item: Outbound) => {
    setStreamBubble(null);
    markOutbox(item.id, "queued");
  };
  const cancelOutbox = (item: Outbound) => {
    if (item.status === "sending") {
      // Ask the runtime to stop, then detach this browser stream locally.
      // Passive browser disconnects do not stop provider work server-side.
      stopActiveStream();
    } else {
      removeOutbox(item.id);
    }
  };
  const renderOutbound = (m: Outbound) => (
    <ChatMessageBubble
      key={m.id}
      msg={{
        id: m.id,
        role: "USER",
        body:
          m.body ||
          (m.displayFiles.length > 0 ? m.displayFiles.map((name) => `📎 ${name}`).join("\n") : ""),
        createdAt: new Date(m.createdAt),
        // Muted while queued/sending; un-mutes once the server confirms.
        isDraft: m.status === "queued" || m.status === "sending",
        sendState: m.status,
      }}
      onRetry={m.status === "failed" ? () => retryOutbox(m) : undefined}
      onCancel={
        m.status === "queued" || m.status === "sending" || m.status === "failed"
          ? () => cancelOutbox(m)
          : undefined
      }
    />
  );

  // Build slash-command context — stable reference via useMemo.
  // Prefer agentFull (has all fields); fall back to basic agent shape for
  // id/name/profileKey/status/role which are available from data.agent.
  const agentRunEngine =
    (agentFull as { runEngine?: string | null } | undefined)?.runEngine ?? null;
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
      currentEngine:
        agentRunEngine ??
        (readiness?.mode === "runs" || readiness?.mode === "dispatch"
          ? "runs (default)"
          : agentFull?.provider === "HERMES"
            ? "runs (default)"
            : "completions (default)"),
      provider: agentFull?.provider ?? null,
      transport: readiness ? { mode: readiness.mode, label: readiness.transportLabel } : null,
      appendLocal,
      notify: (message) => toast.success(message),
      clearLocal,
      clearThread: async () => {
        if (!threadId) return;
        await clearThreadM.mutateAsync({ threadId });
      },
      newConversation: async (options) => {
        const result = await createConversationM.mutateAsync({ agentId });
        const prompt = options?.prompt?.trim();
        if (prompt) {
          await sendM.mutateAsync({
            agentId,
            threadId: result.thread.id,
            body: prompt,
            context: sendContext,
          });
        }
        onThreadCreated?.(result.thread.id, result.agent.id);
      },
      sendPrompt: handleSend,
      compactThread: async () => {
        if (!threadId) return;
        await compactM.mutateAsync({ threadId });
      },
      setEngine: async (engine) => {
        await setEngineM.mutateAsync({ id: agent.id, runEngine: engine });
      },
      hermesInfo: async (resource) => {
        try {
          const r = await utils.ai.hermesInfo.fetch({
            resource,
            agentProfileKey: agent.profileKey,
          });
          return r.markdown;
        } catch (e) {
          return `_Couldn't fetch Hermes ${resource}: ${e instanceof Error ? e.message : "error"}._`;
        }
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agent?.id,
    agentFull?.runtimeMode,
    agentFull?.status,
    agentRunEngine,
    agentFull?.provider,
    readiness?.mode,
    readiness?.transportLabel,
    sendContext,
    threadId,
    workspace?.slug,
  ]);

  // Auto-scroll to bottom on new messages.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, localMessages.length, outbox.length, draft?.body, streamBubble?.body]);

  const messageRows: ChatMessageRow[] = useMemo(
    () =>
      messages.map((m) => {
        const localReadAt = localReadReceipts[m.id] ?? null;
        return {
          id: m.id,
          role: m.role as ChatMessageRow["role"],
          body: m.body,
          createdAt: m.createdAt,
          // Delivery-receipt timestamps (USER messages only render them).
          dispatchedAt: (m as { dispatchedAt?: Date | string | null }).dispatchedAt ?? null,
          acknowledgedAt:
            (m as { acknowledgedAt?: Date | string | null }).acknowledgedAt ?? localReadAt,
          outputStartedAt:
            (m as { outputStartedAt?: Date | string | null }).outputStartedAt ?? localReadAt,
          // Streaming path stashes thinking/tool_use blocks in
          // `contextSnapshot`. Forward whatever the router returns —
          // `chat-message.tsx` guards against missing/unrelated shapes.
          contextSnapshot: (m as { contextSnapshot?: unknown }).contextSnapshot ?? undefined,
        };
      }),
    [messages, localReadReceipts],
  );
  const persistedMessageIds = useMemo(() => new Set(messageRows.map((m) => m.id)), [messageRows]);

  // While a stream is in-flight (or held briefly after `done`), the
  // persisted AGENT row may also be in `messageRows`. Prefer the live
  // stream bubble over either the matched row or a fresh empty placeholder
  // so the reply does not render twice during the swap window.
  const suppressedMessageId = streamBubble?.messageId ?? null;
  const streamBubbleStartedAt = streamBubble?.startedAt ?? null;
  const streamBubbleIsLive = Boolean(streamBubble && !streamBubble.finishedAt);
  const visibleMessageRows = useMemo(
    () =>
      messageRows.filter((m) => {
        if (suppressedMessageId && m.id === suppressedMessageId) return false;
        if (
          !suppressedMessageId &&
          streamBubbleIsLive &&
          streamBubbleStartedAt !== null &&
          m.role === "AGENT" &&
          !m.body.trim()
        ) {
          const createdAt = new Date(m.createdAt).getTime();
          if (Number.isFinite(createdAt) && createdAt >= streamBubbleStartedAt - 5_000) {
            return false;
          }
        }
        return true;
      }),
    [messageRows, streamBubbleIsLive, streamBubbleStartedAt, suppressedMessageId],
  );

  // Merged display rows: persisted + local SYSTEM messages interleaved.
  // Local messages appear after the last persisted message.
  const displayRows: ChatMessageRow[] = useMemo(
    () => [...visibleMessageRows, ...localMessages],
    [visibleMessageRows, localMessages],
  );
  const showSuggestedPrompts =
    visibleMessageRows.length === 0 && outbox.length === 0 && !streamBubble && !draft;
  const persistedUserMessages = useMemo(
    () =>
      messageRows
        .filter((m) => m.role === "USER")
        .map((m) => ({
          body: normalizeChatBodyForMatch(m.body),
          createdAt: new Date(m.createdAt).getTime(),
        }))
        .filter((m) => m.body && Number.isFinite(m.createdAt)),
    [messageRows],
  );
  // Hide optimistic sends once the persisted USER row is visible. `meta`
  // provides the exact row id, but realtime/refetch can beat that event, so
  // fall back to a narrow same-body/same-turn match during active sends.
  const visibleOutbox = useMemo(
    () =>
      outbox.filter((m) => {
        if (m.serverMessageId && persistedMessageIds.has(m.serverMessageId)) return false;
        const body = normalizeChatBodyForMatch(m.body);
        if (body && (m.status === "sending" || m.status === "sent" || m.status === "read")) {
          const persistedCopyVisible = persistedUserMessages.some(
            (p) => p.body === body && Math.abs(p.createdAt - m.createdAt) <= 120_000,
          );
          if (persistedCopyVisible) return false;
        }
        return true;
      }),
    [outbox, persistedMessageIds, persistedUserMessages],
  );

  const fillComposer = useCallback((body: string) => {
    setFillRequest((prev) => ({ body, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const seededInitialDraftRef = useRef<string | null>(null);
  useEffect(() => {
    const body = initialDraft?.trim();
    if (!body || seededInitialDraftRef.current === body) return;
    seededInitialDraftRef.current = body;
    fillComposer(body);
  }, [fillComposer, initialDraft]);

  const findPreviousUserBody = useCallback(
    (messageId: string) => {
      const idx = displayRows.findIndex((row) => row.id === messageId);
      if (idx === -1) return null;
      for (let i = idx - 1; i >= 0; i -= 1) {
        const row = displayRows[i];
        if (row?.role === "USER" && row.body.trim().length > 0) return row.body;
      }
      return null;
    },
    [displayRows],
  );

  const forkFromMessage = useCallback(
    (messageId: string) => {
      if (!threadId || messageId.startsWith("_")) return;
      forkThreadM.mutate({ threadId, messageId });
    },
    [forkThreadM, threadId],
  );

  // ---------- Presence-aware derived values ----------
  const mode = agentFull ? (agentFull.runtimeMode ?? "PERSISTENT") : "PERSISTENT";
  const lastHeartbeatAt = agentFull?.lastHeartbeatAt ?? null;
  const isEphemeral = mode === "EPHEMERAL";
  const status = agent?.status ?? "OFFLINE";
  // Availability model — distinguishes heartbeat-tracked agents (Hermes) from
  // on-demand managed runtimes (Codex app server, completions, dispatch) which
  // connect when you send and shouldn't read as a permanent "offline".
  const availability = agentAvailabilityModel({
    runtimeMode: mode,
    lastHeartbeatAt,
    transportMode: readiness?.mode ?? "none",
    runtimeHeartbeats:
      agentFull?.provider === "HERMES" || agentFull?.runtime?.adapterKey === "hermes",
  });
  const isOnDemand = availability === "on-demand";
  const isPersistentOnline = !isEphemeral && !isOnDemand && status === "ONLINE";
  const isPersistentBusy = !isEphemeral && !isOnDemand && status === "BUSY";
  const isPersistentOffline = !isEphemeral && !isOnDemand && status === "OFFLINE";
  const rawTurnStatus = (diagnostics?.turnStatus ?? null) as TurnStatusView;
  const chatSupportsTools = Boolean(readiness?.capabilities.tools || readiness?.capabilities.runs);

  // Composer placeholder copy
  let composerPlaceholder = agent ? `Message ${agent.name}…` : "Message agent…";
  if (agent) {
    if (isOnDemand) {
      composerPlaceholder = `Message ${agent.name}… (connects on send)`;
    } else if (isPersistentOffline) {
      composerPlaceholder = `Message ${agent.name}… (offline — will reply when back)`;
    } else if (isEphemeral) {
      composerPlaceholder = `Message ${agent.name}… (async — replies on next session)`;
    }
  }

  // Banner for offline/ephemeral agents (on-demand agents need no banner —
  // the transport chip + "on-demand" presence already convey it).
  let composerBanner: string | undefined;
  if (agent && !isOnDemand) {
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
  const turnStatus =
    lastPersistedMessage?.role === "AGENT" &&
    rawTurnStatus &&
    rawTurnStatus.phase !== "completed" &&
    rawTurnStatus.phase !== "idle"
      ? null
      : rawTurnStatus;
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
    canonicalKnown && (dispatchState === "acknowledged" || dispatchState === "running");
  const fallbackShowsThinking = !canonicalKnown && lastMessageIsUser && lastMessageAge < 300_000;
  const showThinking =
    !composerBusy &&
    !draft &&
    lastMessageIsUser &&
    (canonicalShowsThinking || fallbackShowsThinking);
  const thinkingIsStale = canonicalKnown
    ? dispatchState === "stalled"
    : showThinking && lastMessageAge >= 60_000;
  const thinkingDetail = canonicalKnown
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
    lastMessageIsUser &&
    canonicalKnown &&
    (dispatchState === "queued" || dispatchState === "wake-sent" || dispatchState === "stalled");

  // Suppress unused var warning — lastMessage is used for list rendering logic.
  void lastMessage;

  return (
    <div className="flex h-full flex-col">
      {agent && (
        <div className="flex items-center gap-2 border-b border-border/70 bg-card/40 px-3 py-1.5">
          <AgentAvatar agent={agent} size="xs" shape="circle" active />
          {/* Live-presence breath dot — pulses next to the title when the
              agent is actually reachable (persistent online/busy or an
              on-demand managed runtime). Suppressed for offline/ephemeral so
              it never falsely claims liveness. */}
          {(isPersistentOnline || isPersistentBusy || isOnDemand) && (
            <span
              className="forge-breath shrink-0"
              title={
                isOnDemand ? "live · on-demand" : isPersistentBusy ? "live · busy" : "live · online"
              }
            />
          )}
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

          {/* Transport chip — how this agent's chat is *actually* served
              (resolved engine + runtime/transport), so local ACP vs remote
              app-server vs Hermes vs streaming is distinguishable at a glance.
              Driven by chatReadiness so it reflects the attached runtime, not
              just the explicit runEngine field. Shared with the agents tab,
              status rail, wizard, and checklist via <TransportChip>. */}
          {readiness && <TransportChip mode={readiness.mode} label={readiness.transportLabel} />}

          {/* Override pill — only when at least one override is set. */}
          {(providerOverride || modelOverride) && (
            <span className="rounded-full border border-ember/30 bg-ember/10 px-1.5 py-0 text-[0.5625rem] uppercase tracking-wider text-ember">
              via {providerOverride ?? agentFull?.provider ?? "default"}
              {modelOverride && (
                <span className="ml-1 font-mono normal-case tracking-normal text-foreground/80">
                  {modelOverride}
                </span>
              )}
            </span>
          )}
          {effectiveYoloMode && (
            <span
              className="rounded-full border border-danger/30 bg-danger/10 px-1.5 py-0 text-[0.5625rem] uppercase tracking-wider text-danger"
              title={
                yoloModeOverride === null
                  ? "YOLO inherited from runtime config"
                  : "YOLO forced on for this conversation"
              }
            >
              YOLO
            </span>
          )}
          {yoloModeOverride === false && runtimeYoloDefault && (
            <span
              className="rounded-full border border-border bg-subtle/40 px-1.5 py-0 text-[0.5625rem] uppercase tracking-wider text-muted-foreground"
              title="Runtime YOLO is disabled for this conversation"
            >
              YOLO off
            </span>
          )}

          {/* Presence indicator */}
          <span className="ml-auto flex items-center gap-1.5">
            {isOnDemand ? (
              // Managed runtime dialed per turn (Codex app server, completions,
              // dispatch) — reachable on demand, not heartbeat-tracked, so don't
              // claim "offline". It connects when you send.
              <span
                className="flex items-center gap-1 text-[0.625rem] text-sky-600 dark:text-sky-400"
                title="Reached on demand — connects when you send. Not heartbeat-tracked; a failure surfaces as a connection error."
              >
                <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                on-demand
              </span>
            ) : isEphemeral ? (
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
            {threadId && agentFull && (
              <ProviderOverridePopover
                threadId={threadId}
                providerOverride={providerOverride}
                modelOverride={modelOverride}
                yoloModeOverride={yoloModeOverride}
                runtimeYoloDefault={runtimeYoloDefault}
                defaultProvider={agentFull.provider}
              />
            )}
          </span>
        </div>
      )}
      <ChatTurnProgress
        status={turnStatus}
        isLive={isStreaming}
        streamBubble={streamBubble}
        supportsTools={chatSupportsTools}
      />
      <div ref={scrollerRef} className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {showSuggestedPrompts && (
          <div className="px-2 py-4 text-[0.6875rem] text-muted-foreground">
            {agent ? (
              <div className="space-y-3">
                <p className="text-meta text-foreground/90">
                  Talk to <span className="font-medium">{agent.name}</span>. They can read your
                  current page, look up issues, and take actions on your behalf.
                </p>
                <div className="grid grid-cols-2 gap-1.5" data-testid="chat-suggested-prompts">
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
        {displayRows.map((m) => {
          const persisted = !m.id.startsWith("_") && m.role !== "SYSTEM";
          return (
            <ChatMessageBubble
              key={m.id}
              msg={m}
              agentName={agent?.name}
              onEditMessage={persisted && m.role === "USER" ? fillComposer : undefined}
              onResendMessage={
                persisted && m.role === "USER" ? (body) => handleSend(body) : undefined
              }
              onRegenerateFromMessage={
                persisted && m.role === "AGENT"
                  ? () => {
                      const prompt = findPreviousUserBody(m.id);
                      if (prompt) handleSend(prompt);
                      else toast.info("No previous user turn to regenerate");
                    }
                  : undefined
              }
              onForkFromMessage={persisted ? () => forkFromMessage(m.id) : undefined}
            />
          );
        })}
        {/* Active outbound messages (sending / sent / failed) sit above the
            agent's reply. Queued messages render below it as "up next". */}
        {visibleOutbox.filter((m) => m.status !== "queued").map(renderOutbound)}
        {/* Streaming bubble (new /api/chat/stream path). Takes precedence
            over the legacy MCP draft + thinking/wake diagnostics so the
            direct streaming UI is what the operator sees while the model
            is actively responding. */}
        {streamBubble ? (
          <AgentStreamBubble
            bubble={streamBubble}
            agentName={agent?.name}
            threadId={threadId ?? undefined}
            onRetry={
              streamBubble.error && streamBubble.error !== STREAM_STOP_SENTINEL && threadId
                ? () => {
                    const prompt = streamBubble.lastPrompt;
                    setStreamBubble(null);
                    void runStreamingSend(threadId, prompt, { context: sendContext });
                  }
                : undefined
            }
            onStop={stopActiveStream}
            onApprove={(callId, alwaysAllow) => void respondToTool(callId, true, alwaysAllow)}
            onDecline={(callId) => void respondToTool(callId, false)}
          />
        ) : draft ? (
          <AgentDraftBubble body={draft.body} agentName={agent?.name} />
        ) : showThinking ? (
          <AgentThinkingBubble stale={thinkingIsStale} detail={thinkingDetail} />
        ) : showWakeDiagnostic ? (
          <AgentWakeDiagnostic
            state={dispatchState as "queued" | "wake-sent" | "stalled"}
            agentName={agent?.name}
            wakeAttempts={diagnostics?.latestUserMessage?.wakeAttempts ?? 0}
            lastWakeAt={diagnostics?.latestUserMessage?.lastWakeAt ?? null}
          />
        ) : null}
        {/* Queued messages waiting their turn ("up next"). */}
        {visibleOutbox.filter((m) => m.status === "queued").map(renderOutbound)}
      </div>
      {boundCanvas && (
        <div className="px-2 pt-1">
          <div className="text-meta inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-2 py-0.5 text-muted-foreground">
            <Layers className="h-3 w-3 text-ember" />
            Bound to canvas
            <span className="font-mono text-foreground">{boundCanvas.name}</span>
          </div>
        </div>
      )}
      {readiness && !readiness.ready && (
        <div className="px-2 pt-1">
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <PlugZap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[0.6875rem] font-semibold text-amber-700 dark:text-amber-300">
                  {readiness.reason === "pull-act-only"
                    ? "This connection doesn't serve chat"
                    : readiness.reason === "no-runs-connector"
                      ? "No runtime attached for this agent"
                      : "No chat model configured"}
                </span>
                <span
                  className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[0.5625rem] uppercase tracking-wider text-amber-700 dark:text-amber-300"
                  title={
                    readiness.mode === "runs"
                      ? "Runs engine — a managed runtime must own the loop"
                      : "Streaming engine — a chat model must be configured"
                  }
                >
                  {readiness.mode}
                </span>
              </div>
              <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                {readiness.hint}
              </p>
              {workspace && (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {readiness.reason === "no-model" && (
                    <Link
                      href={`/w/${workspace.slug}/settings/workspace`}
                      className="inline-flex items-center gap-1 rounded border border-ember/40 bg-ember/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-ember transition-colors hover:bg-ember/20"
                    >
                      <Settings2 className="h-2.5 w-2.5" /> Configure model
                    </Link>
                  )}
                  <Link
                    href={`/w/${workspace.slug}/settings/agents`}
                    className="inline-flex items-center gap-1 rounded border border-border bg-card/40 px-1.5 py-0.5 text-[0.625rem] text-foreground/90 transition-colors hover:border-ember/40 hover:text-foreground"
                  >
                    <Settings2 className="h-2.5 w-2.5" /> Configure agent
                  </Link>
                  <Link
                    href={`/w/${workspace.slug}/settings/runtimes`}
                    className="inline-flex items-center gap-1 rounded border border-border bg-card/40 px-1.5 py-0.5 text-[0.625rem] text-foreground/90 transition-colors hover:border-ember/40 hover:text-foreground"
                  >
                    <PlugZap className="h-2.5 w-2.5" /> Manage runtimes
                  </Link>
                  <Link
                    href={`/w/${workspace.slug}/settings/connections`}
                    className="text-[0.625rem] text-muted-foreground hover:text-foreground"
                  >
                    Connections →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <ChatComposer
        onSend={handleSend}
        // Never block the composer — messages queue while a send is in
        // flight. `isPending` drives only the "sending…" footer hint.
        disabled={false}
        isPending={composerBusy}
        placeholder={composerPlaceholder}
        banner={composerBanner}
        slashContext={slashContext}
        contextSummary={contextSummary}
        contextItems={contextItems}
        onToggleContextItem={toggleContextItem}
        autoFocus={autoFocus}
        threadId={threadId}
        mentionableAgents={mentionableAgents}
        mentionablePeople={mentionablePeople}
        fillRequest={fillRequest ?? undefined}
      />
    </div>
  );
}
