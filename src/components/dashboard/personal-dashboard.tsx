"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  CornerDownLeft,
  MessageSquare,
  NotebookPen,
  Plus,
  Send,
  Sparkles,
  Sunrise,
} from "lucide-react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import type { AppRouter } from "@/server/routers/_app";

const AGENT_RAIL_KEY = "forge.personal.agentCompanionCollapsed";

type DuePreset = "TODAY" | "TOMORROW" | "SOMEDAY";

export function PersonalDashboard() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: me } = trpc.workspace.me.useQuery();
  const { data: statuses } = trpc.status.list.useQuery();
  const active = trpc.issue.list.useQuery({ includeDone: false, limit: 100, sort: "updated" });
  const notes = trpc.note.list.useQuery({ archived: false, limit: 3 });
  const [taskTitle, setTaskTitle] = useState("");
  const [duePreset, setDuePreset] = useState<DuePreset>("TODAY");
  const [noteBody, setNoteBody] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [railCollapsed, setRailCollapsed] = useState(false);

  useEffect(() => {
    try {
      setRailCollapsed(window.localStorage.getItem(AGENT_RAIL_KEY) === "1");
    } catch {
      // Keep the visible default when storage is unavailable.
    }
  }, []);

  function setAgentRailCollapsed(next: boolean) {
    setRailCollapsed(next);
    try {
      window.localStorage.setItem(AGENT_RAIL_KEY, next ? "1" : "0");
    } catch {
      // The preference is optional; the interaction still works.
    }
  }

  const createTask = trpc.issue.create.useMutation({
    onSuccess: () => {
      setTaskTitle("");
      utils.issue.list.invalidate();
      toast.success("Task added.");
    },
    onError: (error) => toast.error(error.message),
  });
  const completeTask = trpc.issue.update.useMutation({
    onSuccess: () => utils.issue.list.invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const createNote = trpc.note.create.useMutation({
    onSuccess: () => {
      setNoteBody("");
      utils.note.list.invalidate();
      toast.success("Note saved.");
    },
    onError: (error) => toast.error(error.message),
  });

  const now = useMemo(() => new Date(), []);
  const { startToday, endToday } = useMemo(() => {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startToday: start, endToday: end };
  }, [now]);

  const buckets = useMemo(() => {
    const overdue: PersonalIssue[] = [];
    const today: PersonalIssue[] = [];
    const upcoming: PersonalIssue[] = [];
    const unscheduled: PersonalIssue[] = [];
    for (const issue of active.data?.items ?? []) {
      if (!issue.dueDate) unscheduled.push(issue);
      else if (issue.dueDate < startToday) overdue.push(issue);
      else if (issue.dueDate < endToday) today.push(issue);
      else upcoming.push(issue);
    }
    const byDue = (a: (typeof overdue)[number], b: (typeof overdue)[number]) =>
      (a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER);
    return {
      overdue: overdue.sort(byDue),
      today: [...today.sort(byDue), ...unscheduled],
      upcoming: upcoming.sort(byDue),
    };
  }, [active.data?.items, endToday, startToday]);

  const delegated = useMemo(
    () => (active.data?.items ?? []).filter((issue) => issue.assignedAgent).slice(0, 4),
    [active.data?.items],
  );
  const doneStatus = statuses?.find((status) => status.category === "DONE");
  const firstName = (me?.user.name ?? me?.user.email ?? "there").split(/[\s@]/)[0] || "there";

  function addTask() {
    const title = taskTitle.trim();
    if (!title) return;
    const dueDate = new Date(startToday);
    if (duePreset === "TOMORROW") dueDate.setDate(dueDate.getDate() + 1);
    createTask.mutate({
      title,
      dueDate: duePreset === "SOMEDAY" ? undefined : dueDate,
    });
  }

  function agentChatHref(prompt: string) {
    return `/w/${ws.slug}/chat?draft=${encodeURIComponent(prompt)}`;
  }

  return (
    <>
      <Topbar
        title="Today"
        subtitle={formatLongDate(now)}
        actions={
          <Link
            href={agentChatHref("Help me review my open tasks and plan a realistic day.")}
            className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card/60 px-2.5 text-xs text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <Sparkles className="h-3.5 w-3.5 text-ember" />
            Plan my day
          </Link>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto grid min-h-full max-w-[1460px] transition-[grid-template-columns] duration-200",
            railCollapsed ? "grid-cols-1" : "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_21rem]",
          )}
        >
          <main className="min-w-0 px-4 py-6 sm:px-7 lg:px-10 lg:py-8">
            <div className="mx-auto max-w-4xl">
              <header className="mb-7 flex items-start justify-between gap-4">
                <div>
                  <div className="mb-1 flex items-center gap-2 text-meta font-medium uppercase tracking-[0.16em] text-ember">
                    <Sunrise className="h-3.5 w-3.5" />
                    Personal workspace
                  </div>
                  <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                    Good {dayPart(now)}, {firstName}.
                  </h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {buckets.today.length === 0
                      ? "Your day is clear. Capture what matters next."
                      : `${buckets.today.length} ${buckets.today.length === 1 ? "task" : "tasks"} in view for today.`}
                  </p>
                </div>
                {railCollapsed && (
                  <Button variant="outline" size="sm" onClick={() => setAgentRailCollapsed(false)}>
                    <Bot className="h-3.5 w-3.5 text-ember" />
                    Agent
                  </Button>
                )}
              </header>

              <section className="mb-8 rounded-xl border border-border bg-card/50 p-2 shadow-sm">
                <div className="flex items-center gap-2">
                  <Plus className="ml-2 h-4 w-4 shrink-0 text-ember" />
                  <input
                    value={taskTitle}
                    onChange={(event) => setTaskTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addTask();
                      }
                    }}
                    placeholder="Add a task…"
                    aria-label="Task title"
                    className="focus-ring h-10 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/70"
                  />
                  <Combobox
                    value={duePreset}
                    onChange={(value) => value && setDuePreset(value as DuePreset)}
                    options={[
                      { value: "TODAY", label: "Today" },
                      { value: "TOMORROW", label: "Tomorrow" },
                      { value: "SOMEDAY", label: "Someday" },
                    ]}
                    ariaLabel="Task due date"
                    className="hidden h-8 text-xs text-muted-foreground sm:inline-flex"
                  />
                  <Button
                    variant="ember"
                    size="sm"
                    onClick={addTask}
                    disabled={!taskTitle.trim() || createTask.isPending}
                  >
                    Add
                    <CornerDownLeft className="h-3 w-3" />
                  </Button>
                </div>
              </section>

              {active.isLoading ? (
                <TaskSkeleton />
              ) : (
                <div className="space-y-8">
                  {buckets.overdue.length > 0 && (
                    <TaskGroup
                      title="Overdue"
                      tone="danger"
                      issues={buckets.overdue}
                      workspaceKey={ws.key}
                      slug={ws.slug}
                      onComplete={(id) => doneStatus && completeTask.mutate({ id, statusId: doneStatus.id })}
                      canComplete={Boolean(doneStatus)}
                    />
                  )}
                  <TaskGroup
                    title="Today"
                    count={buckets.today.length}
                    issues={buckets.today}
                    workspaceKey={ws.key}
                    slug={ws.slug}
                    onComplete={(id) => doneStatus && completeTask.mutate({ id, statusId: doneStatus.id })}
                    canComplete={Boolean(doneStatus)}
                    empty="Nothing scheduled. Add a task above or ask your agent to plan the day."
                  />
                  <div id="upcoming" className="scroll-mt-20">
                    <TaskGroup
                      title="Upcoming"
                      count={buckets.upcoming.length}
                      issues={buckets.upcoming.slice(0, 6)}
                      workspaceKey={ws.key}
                      slug={ws.slug}
                      onComplete={(id) => doneStatus && completeTask.mutate({ id, statusId: doneStatus.id })}
                      canComplete={Boolean(doneStatus)}
                      empty="No upcoming deadlines."
                    />
                  </div>
                </div>
              )}

              <section id="personal-notes" className="mt-10 scroll-mt-20 border-t border-border/70 pt-7">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <NotebookPen className="h-4 w-4 text-ember" />
                    <h2 className="text-sm font-semibold">Notes</h2>
                  </div>
                  <Link href={`/w/${ws.slug}/dashboard#personal-notes`} className="text-xs text-muted-foreground hover:text-ember">
                    Personal scratchpad
                  </Link>
                </div>
                <div className="mb-3 flex gap-2">
                  <Input
                    value={noteBody}
                    onChange={(event) => setNoteBody(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && noteBody.trim()) {
                        event.preventDefault();
                        createNote.mutate({ body: noteBody.trim() });
                      }
                    }}
                    placeholder="Capture a note…"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!noteBody.trim() || createNote.isPending}
                    onClick={() => createNote.mutate({ body: noteBody.trim() })}
                  >
                    Save
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(notes.data?.items ?? []).map((note) => (
                    <article key={note.id} className="min-h-24 rounded-lg border border-border bg-card/40 p-3">
                      <div className="line-clamp-1 text-xs font-medium">{note.title || "Quick note"}</div>
                      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-meta leading-relaxed text-muted-foreground">
                        {note.body}
                      </p>
                    </article>
                  ))}
                  {!notes.isLoading && (notes.data?.items.length ?? 0) === 0 && (
                    <div className="sm:col-span-3 rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
                      Notes you capture here stay personal to you in this workspace.
                    </div>
                  )}
                </div>
              </section>
            </div>
          </main>

          {!railCollapsed && (
            <aside className="border-t border-border bg-card/30 px-5 py-6 xl:min-h-full xl:border-l xl:border-t-0">
              <div className="sticky top-0">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-lg border border-ember/30 bg-ember/10">
                      <Bot className="h-4 w-4 text-ember" />
                    </span>
                    <div>
                      <h2 className="text-sm font-semibold">Agent companion</h2>
                      <p className="text-[0.6875rem] text-muted-foreground">Real activity from delegated tasks</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    title="Collapse agent companion"
                    onClick={() => setAgentRailCollapsed(true)}
                    className="focus-ring grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-3">
                  {delegated.map((issue) => (
                    <article key={issue.id} className="rounded-lg border border-border bg-background/60 p-3">
                      <div className="flex items-start gap-2.5">
                        <AgentAvatar agent={issue.assignedAgent!} size="sm" active={issue.assignedAgent?.status === "ONLINE"} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium">{issue.assignedAgent?.name}</span>
                            <span className="text-[0.625rem] uppercase tracking-wide text-ember">
                              {agentStateLabel(issue.assignedAgent?.status)}
                            </span>
                          </div>
                          <Link href={`/w/${ws.slug}/issues/${issue.id}`} className="mt-1 block line-clamp-2 text-xs leading-relaxed hover:text-ember">
                            {issue.title}
                          </Link>
                          <div className="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                            <Clock3 className="h-3 w-3" />
                            {issue.status.name} · updated {relativeTime(issue.updatedAt)}
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                  {delegated.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border p-4 text-center">
                      <Bot className="mx-auto h-5 w-5 text-muted-foreground" />
                      <p className="mt-2 text-xs font-medium">No delegated work</p>
                      <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                        Assign any task to an agent and its honest activity will appear here.
                      </p>
                    </div>
                  )}
                </div>

                <div className="mt-5 rounded-xl border border-border bg-background/70 p-2">
                  <textarea
                    value={agentPrompt}
                    onChange={(event) => setAgentPrompt(event.target.value)}
                    placeholder="Ask an agent for help…"
                    rows={3}
                    className="focus-ring w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/70"
                  />
                  <div className="flex items-center justify-between gap-2 px-1 pb-1">
                    <Link href={`/w/${ws.slug}/agents`} className="text-[0.6875rem] text-muted-foreground hover:text-ember">
                      Manage agents
                    </Link>
                    <Link
                      href={agentChatHref(agentPrompt || "Help me decide what to work on next.")}
                      aria-label="Open prompt in agent chat"
                      className="focus-ring grid h-7 w-7 place-items-center rounded-md bg-ember text-ember-foreground hover:bg-ember/90"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </div>

                <Link
                  href={`/w/${ws.slug}/chat`}
                  className="mt-4 flex items-center justify-between rounded-md px-1 py-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <span className="flex items-center gap-2"><MessageSquare className="h-3.5 w-3.5" /> Open agent chat</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </aside>
          )}
        </div>
      </div>
    </>
  );
}

type PersonalIssue = inferRouterOutputs<AppRouter>["issue"]["list"]["items"][number];

function TaskGroup({
  title,
  count,
  tone,
  issues,
  workspaceKey,
  slug,
  onComplete,
  canComplete,
  empty,
}: {
  title: string;
  count?: number;
  tone?: "danger";
  issues: PersonalIssue[];
  workspaceKey: string;
  slug: string;
  onComplete: (id: string) => void;
  canComplete: boolean;
  empty?: string;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className={cn("text-sm font-semibold", tone === "danger" && "text-danger")}>{title}</h2>
        {count !== undefined && <span className="text-meta tabular-nums text-muted-foreground">{count}</span>}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card/30">
        {issues.map((issue) => (
          <div key={issue.id} className="group flex min-h-12 items-center gap-3 border-b border-border/60 px-3 last:border-b-0 hover:bg-subtle/40">
            <button
              type="button"
              onClick={() => onComplete(issue.id)}
              disabled={!canComplete}
              aria-label={`Complete ${issue.title}`}
              className="focus-ring grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-ember/10 hover:text-ember disabled:opacity-40"
            >
              <Circle className="h-4 w-4" />
              <Check className="absolute h-3 w-3 opacity-0 group-hover:opacity-100" />
            </button>
            <Link href={`/w/${slug}/issues/${issue.id}`} className="min-w-0 flex-1 py-3">
              <div className="truncate text-sm">{issue.title}</div>
              <div className="mt-0.5 flex items-center gap-2 text-meta text-muted-foreground">
                <span className="text-id">{formatIssueId(workspaceKey, issue.number)}</span>
                {issue.dueDate && <span>{formatTaskDate(issue.dueDate)}</span>}
                {issue.assignedAgent && <span className="truncate">with {issue.assignedAgent.name}</span>}
              </div>
            </Link>
            {issue.assignedAgent ? (
              <AgentAvatar agent={issue.assignedAgent} size="xs" active={issue.assignedAgent.status === "ONLINE"} />
            ) : (
              <Link
                href={`/w/${slug}/issues/${issue.id}`}
                className="hidden items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-ember group-hover:flex"
              >
                <Bot className="h-3 w-3" /> Delegate
              </Link>
            )}
          </div>
        ))}
        {issues.length === 0 && (
          <div className="flex min-h-20 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {empty ?? "No tasks here."}
          </div>
        )}
      </div>
    </section>
  );
}

function TaskSkeleton() {
  return (
    <div className="space-y-8" aria-label="Loading tasks">
      {[2, 3].map((rows) => (
        <div key={rows}>
          <div className="mb-2 h-4 w-20 animate-pulse rounded bg-subtle" />
          <div className="overflow-hidden rounded-lg border border-border">
            {Array.from({ length: rows }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse border-b border-border/60 bg-card/30 last:border-0" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function dayPart(date: Date) {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function formatLongDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatTaskDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function agentStateLabel(status: string | undefined) {
  if (status === "BUSY") return "Working";
  if (status === "ONLINE") return "Ready";
  return "Assigned";
}
