"use client";
import { useEffect, useRef, useState } from "react";
import { Bot, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ChatThreadView } from "./chat-thread";

/**
 * Chat tab: left rail of agents (existing threads + all known agents),
 * right pane is the active thread.
 */
export function ChatTab({
  slug: _slug,
  autoFocus = false,
}: {
  slug: string;
  /** Focus the composer when the tab becomes active. */
  autoFocus?: boolean;
}) {
  const { data: threads } = trpc.chat.threads.useQuery(undefined, { staleTime: 30_000 });
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false }, { staleTime: 60_000 });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  // Null = show the agent's default thread; set = a specific conversation.
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  // Once the user clicks into an agent we stop auto-shuffling under them.
  const userPickedRef = useRef(false);
  const utils = trpc.useUtils();
  const createConversation = trpc.chat.createConversation.useMutation({
    onSuccess: (res) => {
      void utils.chat.threads.invalidate();
      setSelectedThreadId(res.thread.id);
    },
    onError: (e) => toast.error(e.message),
  });

  useEffect(() => {
    if (userPickedRef.current) return;
    if (selectedAgentId == null && threads && threads.length > 0) {
      setSelectedAgentId(threads[0].agent.id);
    }
  }, [threads, selectedAgentId]);

  // Build the agent rail: one row per agent (NOT per thread — an agent
  // with N threads should appear once, with its most-recent thread's
  // timestamp). Existing-thread agents sort by lastMessageAt; agents
  // with no thread fall in after, alphabetically.
  type RailAgent = {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
    status: string;
    role: string;
    lastMessageAt?: string | Date | null;
  };
  const byAgentId = new Map<string, RailAgent>();
  for (const t of threads ?? []) {
    const prior = byAgentId.get(t.agent.id);
    const ts = t.lastMessageAt ? new Date(t.lastMessageAt).getTime() : 0;
    const priorTs = prior?.lastMessageAt ? new Date(prior.lastMessageAt).getTime() : -1;
    if (!prior || ts > priorTs) {
      byAgentId.set(t.agent.id, {
        id: t.agent.id,
        name: t.agent.name,
        profileKey: t.agent.profileKey,
        avatar: t.agent.avatar ?? null,
        status: t.agent.status,
        role: t.agent.role,
        lastMessageAt: t.lastMessageAt,
      });
    }
  }
  for (const a of agents ?? []) {
    if (byAgentId.has(a.id)) continue;
    byAgentId.set(a.id, {
      id: a.id,
      name: a.name,
      profileKey: a.profileKey,
      avatar: a.avatar ?? null,
      status: a.status,
      role: a.role,
    });
  }
  const railAgents: RailAgent[] = Array.from(byAgentId.values()).sort((x, y) => {
    const xTs = x.lastMessageAt ? new Date(x.lastMessageAt).getTime() : -Infinity;
    const yTs = y.lastMessageAt ? new Date(y.lastMessageAt).getTime() : -Infinity;
    if (xTs !== yTs) return yTs - xTs;
    return x.name.localeCompare(y.name);
  });

  // Threads for the selected agent — default first, then most-recent.
  // Drives the thread strip + the "new chat" affordance. A brand-new
  // agent has none until ChatThreadView creates its default on mount.
  const agentThreads = (threads ?? [])
    .filter((t) => t.agent.id === selectedAgentId)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    });
  const defaultThreadId =
    agentThreads.find((t) => t.isDefault)?.id ?? agentThreads[0]?.id ?? null;
  const activeThreadId = selectedThreadId ?? defaultThreadId;

  return (
    <div className="flex h-full">
      {/* Agent rail */}
      <aside className="w-32 shrink-0 overflow-y-auto border-r border-border/60 bg-card/30">
        {railAgents.length === 0 && (
          <div className="px-2 py-3 text-center text-[0.625rem] text-muted-foreground">
            No agents yet
          </div>
        )}
        {railAgents.map((a) => {
          const isActive = selectedAgentId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                userPickedRef.current = true;
                setSelectedAgentId(a.id);
                // Reset to the agent's default thread when switching agents.
                setSelectedThreadId(null);
              }}
              className={cn(
                "group flex w-full items-center gap-1.5 border-b border-border/40 px-2 py-1.5 text-left text-[0.6875rem]",
                isActive
                  ? "bg-ember/10 text-foreground"
                  : "text-foreground/80 hover:bg-subtle/60",
              )}
              title={`${a.name} · @${a.profileKey}`}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[0.5625rem] uppercase",
                  isActive ? "bg-ember/30 text-ember" : "bg-subtle text-muted-foreground",
                )}
              >
                {a.profileKey.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <span
                className={
                  a.status === "ONLINE"
                    ? "h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                    : a.status === "BUSY"
                      ? "h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ember"
                      : "h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                }
                title={a.status}
              />
            </button>
          );
        })}
      </aside>
      {/* Thread pane */}
      <div className="min-w-0 flex-1">
        {selectedAgentId ? (
          <div className="flex h-full flex-col">
            {/* Thread strip: switch between this agent's conversations and
                start a new one. Backend supports many threads per agent
                (chat.createConversation) — this surfaces them. */}
            <div className="flex items-center gap-1 overflow-x-auto border-b border-border/60 bg-card/20 px-2 py-1">
              {agentThreads.map((t) => {
                const active = activeThreadId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      userPickedRef.current = true;
                      setSelectedThreadId(t.id);
                    }}
                    className={cn(
                      "max-w-[10rem] shrink-0 truncate rounded px-1.5 py-0.5 text-[0.625rem]",
                      active
                        ? "bg-ember/15 text-ember"
                        : "text-muted-foreground hover:bg-subtle/60",
                    )}
                    title={t.title ?? (t.isDefault ? "Main thread" : "Conversation")}
                  >
                    {t.title || (t.isDefault ? "Main" : "Chat")}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  if (selectedAgentId && !createConversation.isPending) {
                    createConversation.mutate({ agentId: selectedAgentId });
                  }
                }}
                disabled={createConversation.isPending}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:border-ember/40 hover:text-ember disabled:opacity-50"
                title="Start a new conversation with this agent"
              >
                <Plus className="h-3 w-3" /> New chat
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ChatThreadView
                key={activeThreadId ?? selectedAgentId}
                agentId={selectedAgentId}
                threadId={selectedThreadId}
                autoFocus={autoFocus}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[0.75rem] text-muted-foreground">
            <div>
              <Bot className="mx-auto mb-2 h-6 w-6 text-muted-foreground/60" />
              <div className="font-medium text-foreground">Talk to an agent</div>
              <div className="mt-1 text-[0.625rem]">
                Pick an agent on the left to start a conversation. Forge sends
                your current page context with each message.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
