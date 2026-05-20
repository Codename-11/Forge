"use client";
import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
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
  // Once the user clicks into an agent we stop auto-shuffling under them.
  const userPickedRef = useRef(false);

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
          <ChatThreadView agentId={selectedAgentId} autoFocus={autoFocus} />
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
