"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, Kbd, SkeletonList, useDensity } from "@/components/ui";
import { Confirm, Picker } from "@/components/ui/modal";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import type { SavedViewFilters } from "@/lib/saved-view-filters";

const priorityGlyph: Record<string, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};

export function IssueList({
  workspaceKey,
  projectId,
  assigneeId,
  authorId,
  includeDone = false,
  query,
  cycleId,
  initiativeId,
  extraFilters,
  emptyHint,
  emptyOverride,
  enableBulk = true,
}: {
  workspaceKey: string;
  projectId?: string;
  assigneeId?: string;
  authorId?: string;
  includeDone?: boolean;
  query?: string;
  /** Tri-state: `undefined` = any; `null` = backlog; string = specific id. */
  cycleId?: string | null;
  /** Tri-state: `undefined` = any; `null` = no initiative; string = id. */
  initiativeId?: string | null;
  /**
   * Phase 1D saved-view filter projection. Spread into `issue.list` after
   * the singleton legacy props so they remain authoritative. Use this
   * instead of calling `issue.list` directly when the caller has a
   * `SavedViewFilters` blob to apply.
   */
  extraFilters?: SavedViewFilters;
  emptyHint?: React.ReactNode;
  /**
   * When provided, replaces the default empty-state for this list. The
   * /issues page passes a "no issues match this view" state when filters
   * are active.
   */
  emptyOverride?: React.ReactNode;
  enableBulk?: boolean;
}) {
  const { data, isLoading } = trpc.issue.list.useQuery({
    includeDone,
    limit: 50,
    projectId,
    assigneeId,
    query,
    cycleId,
    initiativeId,
    ...(extraFilters ?? {}),
  });
  const { data: statuses } = trpc.status.list.useQuery();
  const utils = trpc.useUtils();
  const ws = useMaybeWorkspace();
  const base = ws ? `/w/${ws.slug}` : "";

  const items = useMemo(() => data?.items ?? [], [data]);
  const filtered = authorId ? items.filter((i) => i.authorId === authorId) : items;
  const density = useDensity();
  const compact = density === "compact";

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  const selectedArray = Array.from(selected);

  const bulkStatus = trpc.issue.bulkStatus.useMutation({
    onSuccess: () => {
      toast.success(`Status changed for ${selectedArray.length} issue(s).`);
      setSelected(new Set());
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkSetLabels = trpc.issue.bulkSetLabels.useMutation({
    onSuccess: (res) => {
      toast.success(
        `Labels updated on ${res.updated} issue(s) (+${res.added} / −${res.removed}).`,
      );
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkAssign = trpc.issue.bulkAssign.useMutation({
    onSuccess: (res) => {
      toast.success(`Assigned ${res.updated} issue(s).`);
      setSelected(new Set());
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkAssignAgent = trpc.issue.bulkAssignAgent.useMutation({
    onSuccess: (res) => {
      toast.success(`Agent updated on ${res.updated} issue(s).`);
      setSelected(new Set());
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const softDelete = trpc.issue.softDelete.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((i) => i.id)));
  }

  async function performBulkDelete() {
    await Promise.all(selectedArray.map((id) => softDelete.mutateAsync({ id })));
    toast.success(`Deleted ${selectedArray.length} issue(s).`);
    setSelected(new Set());
    setBulkDeleteOpen(false);
  }

  // Per-label presence count across the current selection. Used by the
  // label picker to show a mixed-state indicator when only some of the
  // selected issues carry a label.
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of filtered) {
      if (!selected.has(issue.id)) continue;
      for (const l of issue.labels) {
        counts.set(l.labelId, (counts.get(l.labelId) ?? 0) + 1);
      }
    }
    return counts;
  }, [filtered, selected]);

  if (isLoading) {
    return (
      <div className="px-5 py-2">
        <SkeletonList rows={8} />
      </div>
    );
  }

  if (filtered.length === 0) {
    if (emptyOverride !== undefined) {
      return <>{emptyOverride}</>;
    }
    return (
      <div className="flex h-60 items-center justify-center">
        <EmptyState
          variant="section"
          icon={<Inbox />}
          title="No active issues."
          description={
            emptyHint ?? (
              <span>
                Press <Kbd>⇧C</Kbd> to create one.
              </span>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="relative">
      {enableBulk && (
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/95 px-5 py-1.5 text-xs backdrop-blur">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.size > 0 && selected.size === filtered.length}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && selected.size < filtered.length;
              }}
              onChange={toggleAll}
              className="h-3.5 w-3.5 rounded border-border"
            />
            <span className="text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
          </label>
          {selected.size > 0 && (
            <>
              <select
                className="focus-ring h-7 rounded-md border border-input bg-background px-2 text-xs"
                disabled={bulkStatus.isPending}
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  bulkStatus.mutate({ ids: selectedArray, statusId: e.target.value });
                  e.target.value = "";
                }}
              >
                <option value="">Move to status…</option>
                {statuses?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLabelPickerOpen(true)}
                disabled={bulkSetLabels.isPending}
              >
                Labels
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAssigneePickerOpen(true)}
                disabled={bulkAssign.isPending || bulkAssignAgent.isPending}
              >
                Assign
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBulkDeleteOpen(true)}>
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
                className="ml-auto"
              >
                Clear
              </Button>
            </>
          )}
        </div>
      )}
      <div className="divide-y divide-border">
        {filtered.map((issue) => {
          const on = selected.has(issue.id);
          const rowCls = compact
            ? "row gap-2 px-5 py-1.5 hover:bg-subtle/60"
            : "row h-10 gap-3 px-5 hover:bg-subtle/60";
          const keyCls = compact
            ? "w-20 shrink-0 text-id text-muted-foreground"
            : "w-20 shrink-0 text-id text-muted-foreground";
          const titleCls = compact
            ? "truncate text-[0.75rem]"
            : "truncate text-sm";
          return (
            <div
              key={issue.id}
              className={cn(rowCls, on && "bg-ember/5")}
            >
              {enableBulk && (
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(issue.id)}
                  className="h-3.5 w-3.5 rounded border-border"
                  aria-label="Select"
                />
              )}
              <Link
                href={`${base}/issues/${issue.id}`}
                className={cn(
                  "row min-w-0 flex-1 gap-3",
                  compact ? "py-0" : "h-10",
                )}
              >
                <span className="w-4 text-center font-mono text-[0.6875rem] text-muted-foreground">
                  {priorityGlyph[issue.priority]}
                </span>
                <span className={keyCls}>
                  {formatIssueId(workspaceKey, issue.number)}
                </span>
                <Badge color={issue.status.color}>{issue.status.name}</Badge>
                <span className={titleCls}>{issue.title}</span>
                {issue.project && (
                  <Badge className="ml-2 shrink-0" color={issue.project.color ?? undefined}>
                    {issue.project.key}
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-3">
                  <span className="text-meta text-muted-foreground">
                    {relativeTime(issue.createdAt)}
                  </span>
                  {issue.assignedAgent && (
                    <span
                      className="flex items-center gap-1 text-meta text-muted-foreground"
                      title={`Agent: ${issue.assignedAgent.name}`}
                    >
                      <AgentPresenceDot
                        status={issue.assignedAgent.status}
                        size="sm"
                      />
                      <span className="text-id">
                        @{issue.assignedAgent.profileKey}
                      </span>
                    </span>
                  )}
                  <div className="flex -space-x-1.5">
                    {issue.assignees.slice(0, 3).map((a) => (
                      <Avatar
                        key={a.userId}
                        name={a.user.name}
                        image={a.user.image}
                        size={compact ? 16 : 18}
                        className="ring-1 ring-background"
                      />
                    ))}
                  </div>
                </div>
              </Link>
            </div>
          );
        })}
      </div>

      <Confirm
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        variant="destructive"
        title={`Delete ${selectedArray.length} issue${selectedArray.length === 1 ? "" : "s"}?`}
        description="The selected issues are soft-deleted and can be recovered by an admin. Type the count to confirm."
        primaryLabel="Delete"
        typeToConfirm={String(selectedArray.length)}
        loading={softDelete.isPending}
        onConfirm={performBulkDelete}
      />

      {labelPickerOpen && (
        <BulkLabelPicker
          open={labelPickerOpen}
          onOpenChange={setLabelPickerOpen}
          selectedCount={selectedArray.length}
          labelCounts={labelCounts}
          onAdd={(labelId) =>
            bulkSetLabels.mutate({
              issueIds: selectedArray,
              add: [labelId],
              remove: [],
            })
          }
          onRemove={(labelId) =>
            bulkSetLabels.mutate({
              issueIds: selectedArray,
              add: [],
              remove: [labelId],
            })
          }
        />
      )}

      {assigneePickerOpen && (
        <BulkAssigneePicker
          open={assigneePickerOpen}
          onOpenChange={setAssigneePickerOpen}
          onPickUser={(userId) =>
            bulkAssign.mutate({
              issueIds: selectedArray,
              claimedById: userId,
            })
          }
          onPickAgent={(agentId) =>
            bulkAssignAgent.mutate({
              issueIds: selectedArray,
              assignedAgentId: agentId,
            })
          }
        />
      )}
    </div>
  );
}

/**
 * Bulk-mode label picker.
 *
 * Reuses the shared <Picker> primitive by flattening labels into a rich
 * item list with a mixed-state indicator. Clicking a row toggles the
 * label on/off for the entire selection: if every selected issue already
 * carries the label (full), the click removes it; otherwise (none /
 * partial) the click adds it to all. The picker stays open after each
 * action so users can chain add/remove across several labels.
 */
function BulkLabelPicker({
  open,
  onOpenChange,
  selectedCount,
  labelCounts,
  onAdd,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selectedCount: number;
  labelCounts: Map<string, number>;
  onAdd: (labelId: string) => void;
  onRemove: (labelId: string) => void;
}) {
  const { data: labels, isLoading } = trpc.label.list.useQuery();
  const [query, setQuery] = useState("");

  type Row = {
    id: string;
    name: string;
    color: string;
    state: "full" | "partial" | "none";
  };

  const q = query.trim().toLowerCase();
  const rows: Row[] = (labels ?? [])
    .filter((l) => !q || l.name.toLowerCase().includes(q))
    .map((l) => {
      const count = labelCounts.get(l.id) ?? 0;
      const state: Row["state"] =
        count === 0 ? "none" : count === selectedCount ? "full" : "partial";
      return { id: l.id, name: l.name, color: l.color, state };
    });

  return (
    <Picker<Row>
      open={open}
      onOpenChange={onOpenChange}
      placeholder={`Add or remove labels across ${selectedCount} issue${selectedCount === 1 ? "" : "s"}…`}
      items={rows}
      getKey={(r) => r.id}
      onQueryChange={setQuery}
      loading={isLoading}
      emptyLabel="No labels match."
      onSelect={(r) => {
        // "full" = present on all selected -> click removes.
        // "partial" or "none" -> click adds.
        if (r.state === "full") onRemove(r.id);
        else onAdd(r.id);
        // Keep the picker open so the user can chain actions.
      }}
      renderItem={(r) => (
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "inline-block h-3 w-3 rounded-sm border",
              r.state === "full"
                ? "border-ember bg-ember"
                : r.state === "partial"
                  ? "border-ember bg-ember/40"
                  : "border-border bg-background",
            )}
          />
          <Badge color={r.color}>{r.name}</Badge>
          <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
            {r.state === "full"
              ? "all"
              : r.state === "partial"
                ? `${labelCounts.get(r.id) ?? 0}/${selectedCount}`
                : ""}
          </span>
        </div>
      )}
      footer={
        <span>
          Click a label to add it to every selected issue. Click a label
          marked <span className="font-mono">all</span> to remove it.
        </span>
      }
    />
  );
}

/**
 * Bulk-mode assignee picker — two tabs (Humans | Agents). The active tab
 * swaps the items list; each tab is single-pick, and each tab includes
 * an explicit "Unassign" row that nulls the corresponding field.
 *
 * Closes on select so the user isn't silently reassigning to the wrong
 * tab on an accidental chain.
 */
function BulkAssigneePicker({
  open,
  onOpenChange,
  onPickUser,
  onPickAgent,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPickUser: (userId: string | null) => void;
  onPickAgent: (agentId: string | null) => void;
}) {
  const [tab, setTab] = useState<"human" | "agent">("human");
  const [query, setQuery] = useState("");
  const { data: members, isLoading: membersLoading } =
    trpc.workspace.members.useQuery(undefined, { enabled: open && tab === "human" });
  const { data: agents, isLoading: agentsLoading } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: open && tab === "agent" },
  );

  type HumanRow =
    | { kind: "unassign"; key: string }
    | {
        kind: "user";
        key: string;
        id: string;
        name: string;
        image: string | null;
        email: string;
      };
  type AgentRow =
    | { kind: "unassign"; key: string }
    | {
        kind: "agent";
        key: string;
        id: string;
        name: string;
        profileKey: string;
        avatar: string | null;
        status: string;
      };

  const q = query.trim().toLowerCase();
  const humanRows: HumanRow[] = [
    { kind: "unassign", key: "__unassign" },
    ...(members ?? [])
      .filter((m) => {
        if (!q) return true;
        const n = m.user.name?.toLowerCase() ?? "";
        const e = m.user.email?.toLowerCase() ?? "";
        return n.includes(q) || e.includes(q);
      })
      .map(
        (m): HumanRow => ({
          kind: "user",
          key: m.user.id,
          id: m.user.id,
          name: m.user.name ?? m.user.email ?? "Unknown",
          image: m.user.image,
          email: m.user.email ?? "",
        }),
      ),
  ];
  const agentRows: AgentRow[] = [
    { kind: "unassign", key: "__unassign" },
    ...(agents ?? [])
      .filter((a) => {
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) ||
          a.profileKey.toLowerCase().includes(q)
        );
      })
      .map(
        (a): AgentRow => ({
          kind: "agent",
          key: a.id,
          id: a.id,
          name: a.name,
          profileKey: a.profileKey,
          avatar: a.avatar,
          status: a.status,
        }),
      ),
  ];

  const tabStrip = (
    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5 text-[0.6875rem]">
      <button
        type="button"
        onClick={() => {
          setTab("human");
          setQuery("");
        }}
        className={cn(
          "focus-ring rounded px-2 py-0.5",
          tab === "human"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Humans
      </button>
      <button
        type="button"
        onClick={() => {
          setTab("agent");
          setQuery("");
        }}
        className={cn(
          "focus-ring rounded px-2 py-0.5",
          tab === "agent"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Agents
      </button>
    </div>
  );

  if (tab === "human") {
    return (
      <Picker<HumanRow>
        open={open}
        onOpenChange={onOpenChange}
        placeholder="Assign to a workspace member…"
        items={humanRows}
        getKey={(r) => r.key}
        onQueryChange={setQuery}
        loading={membersLoading}
        emptyLabel="No members match."
        onSelect={(r) => {
          if (r.kind === "unassign") onPickUser(null);
          else onPickUser(r.id);
          onOpenChange(false);
        }}
        renderItem={(r) => {
          if (r.kind === "unassign") {
            return (
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-muted" />
                <span className="text-muted-foreground">Unassign (clear claim)</span>
              </div>
            );
          }
          return (
            <div className="flex items-center gap-2">
              <Avatar name={r.name} image={r.image} size={18} />
              <span className="truncate">{r.name}</span>
              {r.email && (
                <span className="ml-auto truncate font-mono text-[0.6875rem] text-muted-foreground">
                  {r.email}
                </span>
              )}
            </div>
          );
        }}
        footer={
          <div className="flex items-center justify-between gap-2">
            {tabStrip}
            <span>Human assignment sets the issue&apos;s claim.</span>
          </div>
        }
      />
    );
  }

  return (
    <Picker<AgentRow>
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Assign to an agent…"
      items={agentRows}
      getKey={(r) => r.key}
      onQueryChange={setQuery}
      loading={agentsLoading}
      emptyLabel="No active agents match."
      onSelect={(r) => {
        if (r.kind === "unassign") onPickAgent(null);
        else onPickAgent(r.id);
        onOpenChange(false);
      }}
      renderItem={(r) => {
        if (r.kind === "unassign") {
          return (
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-muted" />
              <span className="text-muted-foreground">Unassign agent</span>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-subtle text-[0.6875rem]">
              {r.avatar ? (
                <span aria-hidden>{r.avatar}</span>
              ) : (
                <span className="font-medium text-muted-foreground">
                  {r.name.slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <AgentPresenceDot status={r.status as "ONLINE" | "BUSY" | "OFFLINE"} />
            <span className="truncate">{r.name}</span>
            <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
              @{r.profileKey}
            </span>
          </div>
        );
      }}
      footer={
        <div className="flex items-center justify-between gap-2">
          {tabStrip}
          <span>Agent assignment fires the AGENT_ASSIGNED webhook.</span>
        </div>
      }
    />
  );
}
