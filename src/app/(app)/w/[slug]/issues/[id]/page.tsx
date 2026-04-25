"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { AgentStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Confirm, Picker } from "@/components/ui/modal";
import { EmptyState, Skeleton, SkeletonText } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { trpc } from "@/lib/trpc";
import { formatDate, formatIssueId, relativeTime } from "@/lib/utils";
import { useTimePrefs } from "@/lib/time-prefs";
import { useWorkspace } from "@/hooks/use-workspace";
import { PinToggleButton } from "@/components/pins/pin-toggle-button";
import { IssueDetailTopbar } from "@/components/issue-detail/issue-topbar";
import { IssueMain } from "@/components/issue-detail/issue-main";
import { IssueRail } from "@/components/issue-detail/issue-rail";
import { useHotkey } from "@/lib/keyboard";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/**
 * Issue detail page. Two-column layout above `md`:
 *
 *   [ main column (flex-1 max-w-3xl) | right rail (sticky, w-96) ]
 *     description + comments           tabs: Attachments / Relations / Activity
 *
 * Below `md` it stacks and the rail's tab strip lives above the main
 * column. The rail owns its own tab state in `?tab=…` so deep-links work.
 * A secondary header ("IssueDetailTopbar") below the shell <Topbar /> hosts
 * the inline editors (title, status, priority, assignees) — keeps the
 * description above the fold without a separate metadata column below it.
 */
export default function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const { data: ws } = trpc.workspace.current.useQuery();
  const { data: issue, isLoading, error } = trpc.issue.byId.useQuery({ id });
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: allLabels } = trpc.label.list.useQuery();
  const timePrefs = useTimePrefs();
  const utils = trpc.useUtils();

  const update = trpc.issue.update.useMutation({
    onMutate: async (input) => {
      await utils.issue.byId.cancel({ id: input.id });
      const prev = utils.issue.byId.getData({ id: input.id });
      utils.issue.byId.setData({ id: input.id }, (old) => {
        if (!old) return old;
        return { ...old, ...input } as typeof old;
      });
      return { prev };
    },
    onError: (err, input, ctx) => {
      if (ctx?.prev) utils.issue.byId.setData({ id: input.id }, ctx.prev);
      toast.error(err.message);
    },
    onSettled: () => utils.issue.byId.invalidate({ id }),
  });

  const assign = trpc.issue.assign.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id });
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setLabels = trpc.label.setForIssue.useMutation({
    onSuccess: () => utils.issue.byId.invalidate({ id }),
    onError: (e) => toast.error(e.message),
  });

  const setQueued = trpc.issue.setQueued.useMutation({
    onSuccess: (_data, vars) => {
      toast.success(vars.queued ? "Queued for agent." : "Removed from agent queue.");
      utils.issue.byId.invalidate({ id });
      utils.issue.queue.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const releaseClaim = trpc.issue.release.useMutation({
    onSuccess: () => {
      toast.success("Claim released.");
      utils.issue.byId.invalidate({ id });
      utils.issue.queue.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const softDelete = trpc.issue.softDelete.useMutation({
    onSuccess: () => {
      toast.success("Issue deleted.");
      utils.issue.list.invalidate();
      router.push(`/w/${slug}/issues`);
    },
    onError: (e) => toast.error(e.message),
  });

  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);

  useEffect(() => {
    if (issue && !editingTitle) setTitleDraft(issue.title);
  }, [issue, editingTitle]);

  // Capital A opens the agent picker. Lowercase `a` is intentionally left
  // free for the user-assignee picker + as the `g a` nav leader second key.
  useHotkey("shift+a", () => setAgentPickerOpen(true), []);

  if (error)
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState variant="page" title="Unable to load issue" description={error.message} />
      </div>
    );
  if (isLoading || !issue)
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-6 w-3/5" />
        <SkeletonText lines={4} />
        <Skeleton className="h-32 w-full" />
      </div>
    );

  const issueKey = ws ? formatIssueId(ws.key, issue.number) : "Issue";

  return (
    <>
      <Topbar
        title={issueKey}
        subtitle={<span className="font-mono text-[10px]">{issue.status.name}</span>}
        actions={
          <>
            <PinToggleButton issueId={issue.id} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/w/${slug}/focus/${id}`)}
              title="Fullscreen, distraction-free"
            >
              Focus
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          </>
        }
      />

      <IssueDetailTopbar
        left={
          <>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{issueKey}</span>
            {editingTitle ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (titleDraft.trim() && titleDraft !== issue.title)
                    update.mutate({ id: issue.id, title: titleDraft.trim() });
                  setEditingTitle(false);
                }}
                className="min-w-0 flex-1"
              >
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={() => {
                    if (titleDraft.trim() && titleDraft !== issue.title)
                      update.mutate({ id: issue.id, title: titleDraft.trim() });
                    setEditingTitle(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setTitleDraft(issue.title);
                      setEditingTitle(false);
                    }
                  }}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-sm font-semibold"
                />
              </form>
            ) : (
              <h1
                className="min-w-0 cursor-text truncate rounded-md px-1 py-0.5 text-sm font-semibold tracking-tight hover:bg-subtle/60"
                onClick={() => setEditingTitle(true)}
                title="Click to edit"
              >
                {issue.title}
              </h1>
            )}
          </>
        }
        middle={
          <div className="flex flex-wrap items-center gap-1.5">
            <InlineStatus
              value={issue.statusId}
              options={statuses ?? []}
              onChange={(statusId) => update.mutate({ id: issue.id, statusId })}
            />
            <InlinePriority
              value={issue.priority}
              onChange={(priority) => update.mutate({ id: issue.id, priority })}
            />
            <AssigneePicker
              current={issue.assignees.map((a) => ({
                userId: a.userId,
                name: a.user.name,
                image: a.user.image,
              }))}
              members={(members ?? []).map((m) => ({
                userId: m.user.id,
                name: m.user.name ?? m.user.email,
                image: m.user.image,
              }))}
              onChange={(userIds) => assign.mutate({ id: issue.id, userIds })}
            />
            <AgentChip current={issue.assignedAgent} onOpen={() => setAgentPickerOpen(true)} />
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col gap-6 p-5 md:flex-row md:gap-8 md:p-6">
          <div className="min-w-0 flex-1 md:max-w-3xl">
            <div className="mb-5 flex items-center gap-2 text-xs text-muted-foreground">
              <Avatar name={issue.author.name} image={issue.author.image} size={16} />
              <span>{issue.author.name ?? "Unknown"}</span>
              <span>·</span>
              <span title={formatDate(issue.createdAt, timePrefs)}>
                {relativeTime(issue.createdAt)}
              </span>
              <span>·</span>
              <span title={formatDate(issue.updatedAt, timePrefs)}>
                updated {relativeTime(issue.updatedAt)}
              </span>
            </div>

            <IssueMain
              issueId={issue.id}
              description={issue.description}
              comments={issue.comments}
              onDescriptionSave={(next) => update.mutate({ id: issue.id, description: next })}
            />

            <div className="mt-10 space-y-4 border-t border-border/60 pt-6">
              <SidebarField label="Project">
                <select
                  value={issue.projectId ?? ""}
                  onChange={(e) =>
                    update.mutate({
                      id: issue.id,
                      projectId: e.target.value || null,
                    })
                  }
                  className="focus-ring w-full max-w-xs rounded-md border border-input bg-background px-2 py-1 text-xs"
                >
                  <option value="">— none —</option>
                  {projects?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </SidebarField>
              <SidebarField label="Labels">
                <LabelPicker
                  current={issue.labels.map((l) => ({
                    id: l.labelId,
                    name: l.label.name,
                    color: l.label.color,
                  }))}
                  all={allLabels ?? []}
                  onChange={(labelIds) => setLabels.mutate({ issueId: issue.id, labelIds })}
                />
              </SidebarField>
              <SidebarField label="Due">
                <input
                  type="date"
                  value={issue.dueDate ? new Date(issue.dueDate).toISOString().slice(0, 10) : ""}
                  onChange={(e) =>
                    update.mutate({
                      id: issue.id,
                      dueDate: e.target.value ? new Date(e.target.value) : null,
                    })
                  }
                  className="focus-ring w-full max-w-xs rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                />
              </SidebarField>
              <SidebarField label="Agent queue">
                <label className="flex w-full max-w-xs items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-[11px]">
                  <input
                    type="checkbox"
                    checked={issue.queued}
                    onChange={(e) => setQueued.mutate({ id: issue.id, queued: e.target.checked })}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-muted-foreground">Queue for agent</span>
                  <span className="ml-auto">
                    <Badge className={issue.queued ? "bg-success/10 text-success" : undefined}>
                      {issue.queued ? "Queued" : "Not queued"}
                    </Badge>
                  </span>
                </label>
                <div className="max-w-xs text-[11px] text-muted-foreground">
                  Queued issues are available to{" "}
                  <span className="font-mono text-foreground">issues.claim</span>; assigned issues
                  can still sit unclaimed until an agent starts.
                </div>
                {issue.claimedAt && (
                  <div className="mt-2 max-w-xs rounded-md border border-border bg-card/60 p-2 text-[11px]">
                    <div className="text-muted-foreground">Claimed</div>
                    <div className="mt-0.5">
                      by <span className="font-mono">{issue.claimedById?.slice(0, 8)}</span>
                      {issue.claimExpiresAt && <> · expires {relativeTime(issue.claimExpiresAt)}</>}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1 w-full"
                      onClick={() => setReleaseOpen(true)}
                    >
                      Release claim
                    </Button>
                  </div>
                )}
              </SidebarField>
            </div>
          </div>

          <aside
            aria-label="Issue detail rail"
            className="shrink-0 md:sticky md:top-4 md:w-96 md:self-start"
          >
            <div className="rounded-lg border border-border bg-card/30 md:max-h-[calc(100svh-7rem)]">
              <IssueRail issueId={issue.id} />
            </div>
          </aside>
        </div>
      </div>

      <Confirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="destructive"
        title={`Delete ${issueKey}?`}
        description="Soft-deletes the issue. History is retained but the issue is removed from lists, boards, and relations."
        primaryLabel="Delete issue"
        typeToConfirm={issueKey}
        loading={softDelete.isPending}
        onConfirm={() => softDelete.mutate({ id })}
      />
      <Confirm
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title="Release claim?"
        description="The current agent loses its exclusive hold and the issue returns to the queue."
        primaryLabel="Release claim"
        loading={releaseClaim.isPending}
        onConfirm={() => releaseClaim.mutate({ id: issue.id })}
      />

      <AgentPickerModal
        open={agentPickerOpen}
        onOpenChange={setAgentPickerOpen}
        currentAgentId={issue.assignedAgent?.id ?? null}
        onSelect={(agentId) => {
          update.mutate({ id: issue.id, assignedAgentId: agentId });
          setAgentPickerOpen(false);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline selectors for the issue-topbar strip
// ---------------------------------------------------------------------------

function InlineStatus({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; name: string; color: string }[];
  onChange: (id: string) => void;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <label className="relative flex items-center">
      <span className="pointer-events-none inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px]">
        {current && (
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: current.color }}
          />
        )}
        <span>{current?.name ?? "Status"}</span>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Status"
      >
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function InlinePriority({
  value,
  onChange,
}: {
  value: (typeof PRIORITIES)[number];
  onChange: (p: (typeof PRIORITIES)[number]) => void;
}) {
  return (
    <label className="relative flex items-center">
      <span className="pointer-events-none inline-flex items-center rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px]">
        {value}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as (typeof PRIORITIES)[number])}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Priority"
      >
        {PRIORITIES.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </label>
  );
}

function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function LabelPicker({
  current,
  all,
  onChange,
}: {
  current: { id: string; name: string; color: string }[];
  all: { id: string; name: string; color: string }[];
  onChange: (labelIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(current.map((l) => l.id));

  function toggle(labelId: string) {
    const next = selected.has(labelId)
      ? current.filter((l) => l.id !== labelId).map((l) => l.id)
      : [...current.map((l) => l.id), labelId];
    onChange(next);
  }

  return (
    <div className="relative w-full max-w-xs">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="focus-ring flex w-full flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-left text-xs hover:bg-subtle"
      >
        {current.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          current.map((l) => (
            <Badge key={l.id} color={l.color}>
              {l.name}
            </Badge>
          ))
        )}
        <span className="ml-auto text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <ul className="max-h-64 overflow-y-auto py-1">
            {all.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => toggle(l.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-subtle"
                >
                  <span
                    className={
                      "inline-block h-3 w-3 rounded-sm border " +
                      (selected.has(l.id) ? "border-ember bg-ember" : "border-border bg-background")
                    }
                  />
                  <Badge color={l.color}>{l.name}</Badge>
                </button>
              </li>
            ))}
            {all.length === 0 && (
              <li className="px-3 py-3 text-center text-[11px] text-muted-foreground">
                No labels defined yet.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function AssigneePicker({
  current,
  members,
  onChange,
}: {
  current: { userId: string; name: string | null; image: string | null }[];
  members: { userId: string; name: string; image: string | null }[];
  onChange: (userIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(current.map((a) => a.userId));

  function toggle(userId: string) {
    const next = selected.has(userId)
      ? current.filter((a) => a.userId !== userId).map((a) => a.userId)
      : [...current.map((a) => a.userId), userId];
    onChange(next);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="focus-ring flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-left text-[11px] hover:bg-subtle"
      >
        {current.length === 0 ? (
          <span className="text-muted-foreground">Unassigned</span>
        ) : (
          <>
            <div className="flex -space-x-1.5">
              {current.slice(0, 3).map((a) => (
                <Avatar key={a.userId} name={a.name} image={a.image} size={16} />
              ))}
            </div>
            <span className="ml-1 text-muted-foreground">{current.length}</span>
          </>
        )}
        <span className="ml-auto text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          className="absolute z-20 mt-1 w-56 rounded-md border border-border bg-card shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <ul className="max-h-64 overflow-y-auto py-1">
            {members.map((m) => (
              <li key={m.userId}>
                <button
                  type="button"
                  onClick={() => toggle(m.userId)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-subtle"
                >
                  <span
                    className={
                      "inline-block h-3 w-3 rounded-sm border " +
                      (selected.has(m.userId)
                        ? "border-ember bg-ember"
                        : "border-border bg-background")
                    }
                  />
                  <Avatar name={m.name} image={m.image} size={18} />
                  <span className="truncate">{m.name}</span>
                </button>
              </li>
            ))}
            {members.length === 0 && (
              <li className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                No workspace members.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent assignment — sibling to the user assignee picker
// ---------------------------------------------------------------------------

type AssignedAgent = {
  id: string;
  name: string;
  profileKey: string;
  avatar: string | null;
  status: AgentStatus;
} | null;

function AgentChip({ current, onOpen }: { current: AssignedAgent; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Assign agent (shift+a)"
      className="focus-ring flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-left text-[11px] hover:bg-subtle"
    >
      {current ? (
        <>
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-subtle text-[10px]">
            {current.avatar ? (
              <span aria-hidden>{current.avatar}</span>
            ) : (
              <span className="font-medium text-muted-foreground">
                {current.name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
          <AgentPresenceDot status={current.status} size="sm" />
          <span className="truncate">{current.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">@{current.profileKey}</span>
        </>
      ) : (
        <span className="text-muted-foreground">Assign agent</span>
      )}
      <span className="ml-auto text-muted-foreground">▾</span>
    </button>
  );
}

type PickerRow =
  | { kind: "unassign"; key: string }
  | {
      kind: "agent";
      key: string;
      id: string;
      name: string;
      profileKey: string;
      avatar: string | null;
      status: AgentStatus;
      lastHeartbeatAt: Date | null;
      capabilities: string[];
    };

function AgentPickerModal({
  open,
  onOpenChange,
  currentAgentId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currentAgentId: string | null;
  onSelect: (agentId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const { data: agents, isLoading } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: open },
  );

  const q = query.trim().toLowerCase();
  const filteredAgents = (agents ?? []).filter((a) => {
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      a.profileKey.toLowerCase().includes(q) ||
      a.capabilities.some((c) => c.toLowerCase().includes(q))
    );
  });

  const items: PickerRow[] = [
    { kind: "unassign", key: "__unassign" },
    ...filteredAgents.map((a) => ({
      kind: "agent" as const,
      key: a.id,
      id: a.id,
      name: a.name,
      profileKey: a.profileKey,
      avatar: a.avatar,
      status: a.status,
      lastHeartbeatAt: a.lastHeartbeatAt,
      capabilities: a.capabilities,
    })),
  ];

  return (
    <Picker<PickerRow>
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Assign agent… (name, @profileKey, capability)"
      items={items}
      getKey={(it) => it.key}
      onQueryChange={setQuery}
      loading={isLoading}
      emptyLabel="No active agents match."
      onSelect={(it) => {
        if (it.kind === "unassign") onSelect(null);
        else onSelect(it.id);
      }}
      renderItem={(it) => {
        if (it.kind === "unassign") {
          const active = currentAgentId === null;
          return (
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-muted" />
              <span className="text-muted-foreground">Unassign</span>
              {active && (
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">current</span>
              )}
            </div>
          );
        }
        const active = currentAgentId === it.id;
        return (
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-subtle text-[11px]">
              {it.avatar ? (
                <span aria-hidden>{it.avatar}</span>
              ) : (
                <span className="font-medium text-muted-foreground">
                  {it.name.slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <AgentPresenceDot status={it.status} size="md" lastHeartbeatAt={it.lastHeartbeatAt} />
            <span className="truncate">{it.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">@{it.profileKey}</span>
            {it.capabilities.length > 0 && (
              <span className="ml-2 hidden min-w-0 truncate text-[10px] text-muted-foreground/80 sm:inline">
                {it.capabilities.slice(0, 3).join(" · ")}
              </span>
            )}
            {active && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                current
              </span>
            )}
          </div>
        );
      }}
    />
  );
}
