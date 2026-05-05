"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  Archive,
  CalendarClock,
  Inbox,
  Tag,
  UserCircle2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState, Kbd, SkeletonList, useDensity } from "@/components/ui";
import { Confirm, Picker } from "@/components/ui/modal";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { BulkBar, type BulkBarAction } from "@/components/bulk-bar";
import { SnoozeMenu } from "@/components/snooze-menu";
import { trpc } from "@/lib/trpc";
import { useHotkey } from "@/lib/keyboard";
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
  dueOn,
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
   * Single-day due-date filter (UTC `YYYY-MM-DD`). Forwarded straight
   * through to `issue.list`. Not part of `SavedViewFilters` — saved
   * views don't pin a specific calendar day.
   */
  dueOn?: string;
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
    dueOn,
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

  // ---- Selection state --------------------------------------------------
  // Mirrors the inbox's pattern: a single Set<string> with a sister
  // ordered-id ref so Shift+Click ranges are stable, plus a hover/focus
  // anchor for the `x` hotkey.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const orderedIdsRef = useRef<string[]>([]);
  const lastClickedRef = useRef<string | null>(null);
  const hoveredRowRef = useRef<string | null>(null);

  orderedIdsRef.current = filtered.map((i) => i.id);

  const toggleSelected = useCallback(
    (id: string, opts?: { range?: boolean }) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (opts?.range && lastClickedRef.current) {
          const list = orderedIdsRef.current;
          const a = list.indexOf(lastClickedRef.current);
          const b = list.indexOf(id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) next.add(list[i]);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      lastClickedRef.current = id;
    },
    [],
  );

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((i) => i.id)));
  }

  // Hotkeys — `x` toggles the hovered row; `Esc` clears (only fires
  // when bulk-select is enabled and a selection exists). Mirror the
  // inbox's editable-target guard so we don't fire from inputs.
  useHotkey(
    "x",
    () => {
      if (!enableBulk) return;
      const id = hoveredRowRef.current;
      if (id) toggleSelected(id);
    },
    [toggleSelected, enableBulk],
  );
  useEffect(() => {
    if (!enableBulk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selected.size > 0) {
        const target = e.target as HTMLElement | null;
        const isEditable =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable;
        if (isEditable) return;
        e.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enableBulk, selected.size, clearSelection]);

  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const selectedArray = useMemo(() => Array.from(selected), [selected]);

  // ---- Bulk mutations (Phase 0 procs) ----------------------------------
  const bulkTransition = trpc.issue.bulkTransition.useMutation({
    onSuccess: (res) => {
      toast.success(`Status changed on ${res.updated} issue(s).`);
      clearSelection();
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkAddLabel = trpc.issue.bulkAddLabel.useMutation({
    onSuccess: (res) => {
      toast.success(`Added label to ${res.updated} issue(s).`);
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkRemoveLabel = trpc.issue.bulkRemoveLabel.useMutation({
    onSuccess: (res) => {
      toast.success(`Removed label from ${res.updated} issue(s).`);
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkAssign = trpc.issue.bulkAssign.useMutation({
    onSuccess: (res) => {
      toast.success(`Assigned ${res.updated} issue(s).`);
      clearSelection();
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkAssignAgent = trpc.issue.bulkAssignAgent.useMutation({
    onSuccess: (res) => {
      toast.success(`Agent updated on ${res.updated} issue(s).`);
      clearSelection();
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const snoozeManyM = trpc.issue.snoozeMany.useMutation({
    onSuccess: ({ updated }) => {
      toast.success(`Snoozed ${updated} issue${updated === 1 ? "" : "s"}.`);
      clearSelection();
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkArchiveM = trpc.issue.bulkArchive.useMutation({
    onSuccess: ({ updated }) => {
      toast.success(`Archived ${updated} issue${updated === 1 ? "" : "s"}.`);
      clearSelection();
      setBulkArchiveOpen(false);
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkPending =
    bulkTransition.isPending ||
    bulkAddLabel.isPending ||
    bulkRemoveLabel.isPending ||
    bulkAssign.isPending ||
    bulkAssignAgent.isPending ||
    snoozeManyM.isPending ||
    bulkArchiveM.isPending;

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

  const bulkActions: BulkBarAction[] = [
    {
      id: "status",
      label: "Status…",
      icon: <ArrowRightLeft className="h-3 w-3" />,
      title: "Move to status",
      disabled: bulkPending,
      onClick: () => setStatusPickerOpen(true),
    },
    {
      id: "assign",
      label: "Assign…",
      icon: <UserCircle2 className="h-3 w-3" />,
      title: "Assign selected",
      disabled: bulkPending,
      onClick: () => setAssigneePickerOpen(true),
    },
    {
      id: "snooze",
      label: null,
      render: (cls) => (
        <SnoozeMenu
          onSelect={(until) =>
            snoozeManyM.mutate({ ids: selectedArray, until })
          }
          trigger={
            <button
              type="button"
              disabled={bulkPending}
              title="Snooze selected"
              className={cls}
            >
              <CalendarClock className="h-3 w-3" />
              Snooze for…
            </button>
          }
        />
      ),
    },
    {
      id: "label",
      label: "Label…",
      icon: <Tag className="h-3 w-3" />,
      title: "Add or remove labels",
      disabled: bulkPending,
      onClick: () => setLabelPickerOpen(true),
    },
    {
      id: "archive",
      label: "Archive",
      icon: <Archive className="h-3 w-3" />,
      title: "Archive (soft delete) selected",
      disabled: bulkPending,
      onClick: () => setBulkArchiveOpen(true),
    },
  ];

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
      {enableBulk && selected.size > 0 && (
        <BulkBar
          count={selected.size}
          onClear={clearSelection}
          actions={bulkActions}
        />
      )}
      {enableBulk && selected.size === 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/95 px-5 py-1.5 text-xs backdrop-blur">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={false}
              ref={(el) => {
                if (el) el.indeterminate = false;
              }}
              onChange={toggleAll}
              className="h-3.5 w-3.5 rounded border-border"
            />
            <span className="text-muted-foreground">Select all</span>
          </label>
          <span className="text-meta text-muted-foreground/70">
            <Kbd>x</Kbd> select hovered · Shift+Click for range
          </span>
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
              onMouseEnter={() => (hoveredRowRef.current = issue.id)}
              onMouseLeave={() => {
                if (hoveredRowRef.current === issue.id)
                  hoveredRowRef.current = null;
              }}
            >
              {enableBulk && (
                <input
                  type="checkbox"
                  checked={on}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      e.preventDefault();
                      toggleSelected(issue.id, { range: true });
                    }
                  }}
                  onChange={(e) => {
                    if (!(e.nativeEvent as MouseEvent).shiftKey)
                      toggleSelected(issue.id);
                  }}
                  className="h-3.5 w-3.5 rounded border-border"
                  aria-label="Select issue"
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
        open={bulkArchiveOpen}
        onOpenChange={setBulkArchiveOpen}
        variant="destructive"
        title={`Archive ${selectedArray.length} issue${selectedArray.length === 1 ? "" : "s"}?`}
        description="Archived issues are soft-deleted — hidden from active lists but recoverable by an admin via the audit trail. Type the count to confirm."
        primaryLabel="Archive"
        typeToConfirm={String(selectedArray.length)}
        loading={bulkArchiveM.isPending}
        onConfirm={() => bulkArchiveM.mutate({ ids: selectedArray })}
      />

      {statusPickerOpen && (
        <BulkStatusPicker
          open={statusPickerOpen}
          onOpenChange={setStatusPickerOpen}
          statuses={statuses ?? []}
          onPick={(statusId) => {
            bulkTransition.mutate({ ids: selectedArray, statusId });
            setStatusPickerOpen(false);
          }}
        />
      )}

      {labelPickerOpen && (
        <BulkLabelPicker
          open={labelPickerOpen}
          onOpenChange={setLabelPickerOpen}
          selectedCount={selectedArray.length}
          labelCounts={labelCounts}
          onAdd={(labelId) =>
            bulkAddLabel.mutate({ ids: selectedArray, labelId })
          }
          onRemove={(labelId) =>
            bulkRemoveLabel.mutate({ ids: selectedArray, labelId })
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
 * Bulk-mode status picker — minimal Picker over `status.list`. The
 * server's `bulkTransition` enforces the workspace scope; we just need
 * to emit the chosen id.
 */
function BulkStatusPicker({
  open,
  onOpenChange,
  statuses,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  statuses: Array<{
    id: string;
    name: string;
    color: string;
    category: string;
  }>;
  onPick: (statusId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items = statuses.filter((s) => !q || s.name.toLowerCase().includes(q));
  return (
    <Picker
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Move selected to status…"
      items={items}
      getKey={(s) => s.id}
      onQueryChange={setQuery}
      emptyLabel="No statuses match."
      onSelect={(s) => onPick(s.id)}
      renderItem={(s) => (
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: s.color }}
          />
          <span className="truncate">{s.name}</span>
          <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
            {s.category.toLowerCase().replace(/_/g, " ")}
          </span>
        </div>
      )}
    />
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
