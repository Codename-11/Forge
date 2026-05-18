"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Bot, Clock3, ImageIcon, MessageSquare, Paperclip, Radio, Settings2 } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { ChatThreadView } from "@/components/mission-control/chat-thread";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";

type AgentLite = {
  id: string;
  name: string;
  profileKey: string;
  avatar?: string | null;
  status: string;
  role?: string | null;
  runtimeMode?: string | null;
  lastHeartbeatAt?: Date | string | null;
};

function relativeTime(input: Date | string | null | undefined): string {
  if (!input) return "never";
  const time = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - time.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function truncate(body: string | null | undefined, fallback: string): string {
  const cleaned = (body ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 96 ? `${cleaned.slice(0, 93)}…` : cleaned;
}

function statusMeta(input: {
  agent: AgentLite;
  latestMessage?: { role: string; createdAt: Date | string } | null;
}) {
  const latest = input.latestMessage;
  if (latest?.role === "USER") {
    const age = Date.now() - new Date(latest.createdAt).getTime();
    if (age < 300_000) return { label: "thinking", tone: "ember" as const };
    return { label: "no recent reply", tone: "muted" as const };
  }
  if (input.agent.status === "BUSY") return { label: "busy", tone: "ember" as const };
  if (input.agent.status === "ONLINE") return { label: "online", tone: "green" as const };
  return { label: "offline", tone: "muted" as const };
}

function AgentGlyph({ agent, active }: { agent: AgentLite; active?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border font-mono text-[0.6875rem] uppercase",
        active
          ? "border-ember/40 bg-ember/15 text-ember"
          : "border-border bg-subtle/50 text-muted-foreground",
      )}
    >
      {agent.avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={agent.avatar} alt="" className="h-full w-full rounded-lg object-cover" />
      ) : (
        agent.profileKey.slice(0, 2)
      )}
    </span>
  );
}

export function ChatWorkspaceSurface() {
  const ws = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
  const threadParam = searchParams.get("thread");

  const { data: threads, isLoading: threadsLoading } = trpc.chat.threads.useQuery(undefined, {
    staleTime: 20_000,
  });
  const { data: agents, isLoading: agentsLoading } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { staleTime: 60_000 },
  );

  useRealtime((evt) => {
    if (evt.subjectType === "chat-thread" || evt.subjectType === "chat-thread-stream") {
      void utils.chat.threads.invalidate();
    }
  });

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const selectedThread = useMemo(
    () => (threadParam ? (threads ?? []).find((thread) => thread.id === threadParam) : null),
    [threadParam, threads],
  );

  useEffect(() => {
    if (selectedThread) {
      setSelectedAgentId(selectedThread.agent.id);
      return;
    }
    if (threadParam && threads && !selectedThread) {
      setSelectedAgentId(null);
      return;
    }
    if (!selectedAgentId) {
      const fallbackAgentId = threads?.[0]?.agent.id ?? agents?.[0]?.id ?? null;
      if (fallbackAgentId) setSelectedAgentId(fallbackAgentId);
    }
  }, [agents, selectedAgentId, selectedThread, threadParam, threads]);

  const threadAgentIds = useMemo(
    () => new Set((threads ?? []).map((thread) => thread.agent.id)),
    [threads],
  );
  const starterAgents = useMemo(
    () => (agents ?? []).filter((agent) => !threadAgentIds.has(agent.id)),
    [agents, threadAgentIds],
  );
  const selectedAgent = useMemo(() => {
    if (!selectedAgentId) return null;
    return (
      selectedThread?.agent ??
      threads?.find((thread) => thread.agent.id === selectedAgentId)?.agent ??
      agents?.find((agent) => agent.id === selectedAgentId) ??
      null
    );
  }, [agents, selectedAgentId, selectedThread?.agent, threads]);

  const openThread = (threadId: string, agentId: string) => {
    setSelectedAgentId(agentId);
    router.replace(`/w/${ws.slug}/chat?thread=${encodeURIComponent(threadId)}`);
  };
  const startAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    router.replace(`/w/${ws.slug}/chat`);
  };

  const hasRows = (threads?.length ?? 0) > 0 || starterAgents.length > 0;

  return (
    <>
      <Topbar
        title="Chat"
        subtitle="Agent conversations, file-backed prompts, and dispatch state."
        actions={
          <Link href={`/w/${ws.slug}/settings/agents`}>
            <Button variant="ghost" size="sm">
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              Manage agents
            </Button>
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full min-h-0 grid-cols-[20rem_minmax(0,1fr)] border-b border-border/60 max-lg:grid-cols-[17rem_minmax(0,1fr)] max-md:grid-cols-1 xl:grid-cols-[20rem_minmax(0,1fr)_18rem]">
          <aside className="flex min-h-0 flex-col border-r border-border/70 bg-card/30 max-md:hidden">
            <div className="border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MessageSquare className="h-4 w-4 text-ember" />
                Conversations
              </div>
              <p className="mt-1 text-subtitle text-muted-foreground">
                Recent operator ⇄ agent threads in this workspace.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {(threadsLoading || agentsLoading) && !hasRows ? (
                <div className="space-y-2 p-2">
                  {Array.from({ length: 4 }).map((_, idx) => (
                    <div key={idx} className="h-16 animate-pulse rounded-lg bg-subtle/50" />
                  ))}
                </div>
              ) : !hasRows ? (
                <div className="rounded-lg border border-dashed border-border bg-card/40 p-4 text-center">
                  <Bot className="mx-auto h-7 w-7 text-muted-foreground/60" />
                  <div className="mt-2 text-sm font-medium text-foreground">No conversations yet</div>
                  <p className="mt-1 text-meta text-muted-foreground">
                    Chat is where agent conversations and file-backed prompts appear.
                    Add an agent, then send a message with context or attachments.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {(threads ?? []).length > 0 && (
                    <div className="space-y-1">
                      <div className="px-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        Recent
                      </div>
                      {(threads ?? []).map((thread) => {
                        const active = selectedAgentId === thread.agent.id;
                        const latest = thread.latestMessage;
                        const meta = statusMeta({ agent: thread.agent, latestMessage: latest });
                        return (
                          <button
                            key={thread.id}
                            type="button"
                            onClick={() => openThread(thread.id, thread.agent.id)}
                            className={cn(
                              "flex w-full gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                              active
                                ? "border-ember/40 bg-ember/10"
                                : "border-transparent hover:border-border hover:bg-subtle/50",
                            )}
                          >
                            <AgentGlyph agent={thread.agent} active={active} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {thread.agent.name}
                                </span>
                                <span className="text-id text-muted-foreground">@{thread.agent.profileKey}</span>
                              </div>
                              <p className="mt-0.5 truncate text-meta text-muted-foreground">
                                {truncate(latest?.body, latest?.attachmentCount ? "Attachment prompt" : "No messages yet")}
                              </p>
                              <div className="mt-1 flex items-center gap-2 text-[0.6875rem] text-muted-foreground/80">
                                <span className="flex items-center gap-1">
                                  <Clock3 className="h-3 w-3" />
                                  {relativeTime(thread.lastMessageAt)}
                                </span>
                                {latest?.attachmentCount ? (
                                  <span className="flex items-center gap-1">
                                    {latest.hasImageAttachment ? <ImageIcon className="h-3 w-3" /> : <Paperclip className="h-3 w-3" />}
                                    {latest.attachmentCount}
                                  </span>
                                ) : null}
                                <span
                                  className={cn(
                                    "ml-auto rounded-full px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider",
                                    meta.tone === "green"
                                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                      : meta.tone === "ember"
                                        ? "bg-ember/15 text-ember"
                                        : "bg-subtle text-muted-foreground",
                                  )}
                                >
                                  {meta.label}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {starterAgents.length > 0 && (
                    <div className="space-y-1">
                      <div className="px-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        Start a thread
                      </div>
                      {starterAgents.map((agent) => {
                        const active = selectedAgentId === agent.id;
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            onClick={() => startAgent(agent.id)}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                              active
                                ? "border-ember/40 bg-ember/10"
                                : "border-transparent hover:border-border hover:bg-subtle/50",
                            )}
                          >
                            <AgentGlyph agent={agent} active={active} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-foreground">{agent.name}</div>
                              <div className="flex items-center gap-2 text-meta text-muted-foreground">
                                <span className="text-id">@{agent.profileKey}</span>
                                <span className="flex items-center gap-1">
                                  <Radio className="h-3 w-3" />
                                  {agent.status.toLowerCase()}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>

          <main className="flex min-h-0 flex-col bg-background">
            {threadParam && threads && !selectedThread ? (
              <div className="flex h-full items-center justify-center p-8 text-center">
                <div className="max-w-sm rounded-xl border border-border bg-card/40 p-6 shadow-sm">
                  <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground/60" />
                  <h2 className="mt-3 text-base font-semibold text-foreground">Thread unavailable</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This chat thread is archived, belongs to another operator, or no longer exists.
                  </p>
                  <Button className="mt-4" variant="subtle" onClick={() => router.replace(`/w/${ws.slug}/chat`)}>
                    Back to Chat
                  </Button>
                </div>
              </div>
            ) : selectedAgentId ? (
              <ChatThreadView agentId={selectedAgentId} />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
                <div className="max-w-sm">
                  <Bot className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
                  <div className="text-base font-semibold text-foreground">Pick an agent to start</div>
                  <p className="mt-1 text-sm">
                    Chat is the live operator console. Messages can carry page context,
                    pasted files, drag/drop uploads, and links for Hermes-backed agents.
                  </p>
                </div>
              </div>
            )}
          </main>

          <section className="hidden border-l border-border/70 bg-card/20 p-4 xl:block">
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <div className="text-sm font-semibold text-foreground">Context</div>
              {selectedAgent ? (
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center gap-3">
                    <AgentGlyph agent={selectedAgent} active />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">{selectedAgent.name}</div>
                      <div className="text-id text-muted-foreground">@{selectedAgent.profileKey}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-meta">
                    <div className="rounded-lg border border-border/60 bg-background/60 p-2">
                      <div className="text-muted-foreground">Status</div>
                      <div className="mt-0.5 font-medium text-foreground">{selectedAgent.status.toLowerCase()}</div>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/60 p-2">
                      <div className="text-muted-foreground">Messages</div>
                      <div className="mt-0.5 font-medium text-foreground">
                        {selectedThread?._count.messages ?? "—"}
                      </div>
                    </div>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    Composer sends your current page context plus finalized attachments only after upload completes.
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-meta text-muted-foreground">
                  Select a conversation to inspect agent state and attachment-backed prompts.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
