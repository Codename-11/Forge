"use client";
import type { AgentStatus } from "@prisma/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  Inbox,
  Clock,
  MessageCircle,
  Sun,
  Target,
  ChevronRight,
  ChevronDown,
  Zap,
  Bot,
  CheckCheck,
  CalendarClock,
  UserCircle2,
  X,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Avatar } from "@/components/ui/avatar";
import { Badge, Card, EmptyState, Kbd, MOTION, Section, SkeletonList } from "@/components/ui";
import { Picker } from "@/components/ui/modal";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { BulkBar, type BulkBarAction } from "@/components/bulk-bar";
import { ProjectChip } from "@/components/project-chip";
import { RowQuickActions } from "@/components/row-quick-actions";
import { SnoozeMenu } from "@/components/snooze-menu";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { useHotkey } from "@/lib/keyboard";
import { workspaceColor } from "@/lib/workspace-color";

/**
 * Phase 1B inbox.
 *
 * Top-to-bottom buckets, all bucket counts + per-row "new" highlighting
 * driven by `inbox.get`'s `unreadSinceVisit` map and `lastVisitAt` (the
 * timestamp of the *previous* visit — `inbox.visit` returns the new one,
 * but the data we use for unread comparisons is captured before we bump
 * it).
 *
 *   1. Assigned & unblocked        (humanStalled excluded — that bucket
 *                                   gets its own section)
 *   2. Mentions                    (read-only, no quick actions)
 *   3. Stalled — yours             (humanStalled)
 *   4. Stalled — agents            (agentStalled)
 *   5. Snoozed                     (collapsible <details>, default closed)
 *
 * Bulk select sticky toolbar appears at the top of the page when ≥1 row
 * is checked. Mark-read on the toolbar bumps `lastInboxVisitAt` to now
 * (we re-anchor the unread cutoff; per-row read-state isn't tracked).
 */

type BucketKey = "assigned" | "humanStalled" | "agentStalled";

export default function InboxPage() {
  const workspace = useWorkspace();
  const utils = trpc.useUtils();
  const [allWorkspaces, setAllWorkspaces] = useState(false);

  const { data, isLoading } = trpc.inbox.get.useQuery({ allWorkspaces });
  const { data: agentQueue, isLoading: queueLoading } = trpc.issue.queue.useQuery(
    { includeClaimed: true, limit: 25 },
    { enabled: !allWorkspaces },
  );
  const { data: agents } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: !allWorkspaces },
  );
  // Pulse numbers come from the standard issue list — same shape as before.
  const { data: active } = trpc.issue.list.useQuery({
    includeDone: false,
    limit: 200,
  });
  const { data: recentDone } = trpc.issue.list.useQuery({
    includeDone: true,
    limit: 200,
  });

  // Capture the *previous* visit timestamp so we can highlight rows that
  // changed since then. `data.lastVisitAt` is exactly that — the server
  // returns it from inbox.get without bumping it. We pin it on first
  // arrival via a ref so subsequent refetches (after `visit`) don't blow
  // it away mid-session.
  const previousVisitRef = useRef<Date | null | undefined>(undefined);
  const previousVisitAt: Date | null = useMemo(() => {
    if (previousVisitRef.current !== undefined) return previousVisitRef.current;
    if (data) {
      const v = data.lastVisitAt ? new Date(data.lastVisitAt) : null;
      previousVisitRef.current = v;
      return v;
    }
    return null;
  }, [data]);

  // Bump lastInboxVisitAt on mount. Server-side debounce handles repeats
  // within 5s; we just fire it once per page entry.
  const visitM = trpc.inbox.visit.useMutation({
    onSuccess: () => {
      void utils.inbox.badge.invalidate();
    },
  });
  const visitFiredRef = useRef(false);
  useEffect(() => {
    if (visitFiredRef.current) return;
    if (!data) return;
    visitFiredRef.current = true;
    visitM.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Compute pulse stats and focus-in-cycle count (unchanged from prior).
  const pulse = useMemo(() => {
    const openCount = active?.items.length ?? 0;
    const inProgress =
      active?.items.filter((i) => i.status.category === "IN_PROGRESS").length ?? 0;
    const weekAgo = Date.now() - 7 * 86_400_000;
    const doneThisWeek =
      recentDone?.items.filter(
        (i) => i.status.category === "DONE" && new Date(i.updatedAt).getTime() >= weekAgo,
      ).length ?? 0;
    const activeSprint = data?.cycle?.name ?? "None";
    return { openCount, inProgress, doneThisWeek, activeSprint };
  }, [active, recentDone, data?.cycle]);

  const focusInCycle = useMemo(() => {
    if (!data) return 0;
    if (!data.cycle) return data.counts.assignedUnblocked;
    return data.assignedUnblocked.length;
  }, [data]);

  const queueRows = !allWorkspaces ? (agentQueue ?? []) : [];
  const readyAgentIssues = queueRows.filter((i) => i.unblocked && !i.claimedAt).length;
  const claimedAgentIssues = queueRows.filter((i) => !!i.claimedAt).length;
  const assignedAgentIssues = queueRows.filter((i) => !!i.assignedAgent).length;
  const onlineAgents =
    agents?.filter((a) => a.status === "ONLINE" || a.status === "BUSY").length ?? 0;

  // ---- Selection state ----------------------------------------------------
  // Single Set<id> across all buckets; bulk actions fan out per id. Order
  // is preserved via a sister array so Shift+Click ranges are stable.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const orderedIdsRef = useRef<string[]>([]);
  const lastClickedRef = useRef<string | null>(null);
  const hoveredRowRef = useRef<string | null>(null);

  // Build a flat ordered id list from the current buckets so Shift-range
  // selection has a stable visual order. Mentions are excluded — they're
  // not selectable.
  const orderedIds = useMemo(() => {
    if (!data) return [];
    const ids: string[] = [];
    for (const i of data.assignedUnblocked) ids.push(i.id);
    for (const i of data.humanStalled) ids.push(i.id);
    for (const i of data.agentStalled) ids.push(i.id);
    return ids;
  }, [data]);
  orderedIdsRef.current = orderedIds;

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

  // Hotkeys: `x` toggles the hovered row; `Esc` clears.
  useHotkey(
    "x",
    () => {
      const id = hoveredRowRef.current;
      if (id) toggleSelected(id);
    },
    [toggleSelected],
  );
  useEffect(() => {
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
  }, [selected.size, clearSelection]);

  // ---- Bulk mutations -----------------------------------------------------
  const snoozeManyM = trpc.issue.snoozeMany.useMutation({
    onSuccess: ({ updated }) => {
      toast.success(
        `Snoozed ${updated} issue${updated === 1 ? "" : "s"}.`,
      );
      clearSelection();
      void utils.inbox.get.invalidate();
      void utils.inbox.badge.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const bulkAssignM = trpc.issue.bulkAssign.useMutation({
    onSuccess: ({ updated }) => {
      toast.success(`Reassigned ${updated} issue${updated === 1 ? "" : "s"}.`);
      clearSelection();
      void utils.inbox.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const bulkAssignAgentM = trpc.issue.bulkAssignAgent.useMutation({
    onSuccess: ({ updated }) => {
      toast.success(`Reassigned ${updated} issue${updated === 1 ? "" : "s"}.`);
      clearSelection();
      void utils.inbox.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const markReadM = trpc.inbox.visit.useMutation({
    onSuccess: () => {
      toast.success("Inbox marked as read.");
      // Bump the local previousVisit anchor so unread chips clear without
      // requiring a full refetch — refetch happens in the background.
      previousVisitRef.current = new Date();
      void utils.inbox.get.invalidate();
      void utils.inbox.badge.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // ---- Bulk picker open state --------------------------------------------
  const [reassignPickerOpen, setReassignPickerOpen] = useState(false);
  const selectedArray = useMemo(() => Array.from(selected), [selected]);

  // ---- Per-row inline picker state (status, assignee) --------------------
  const [statusPicker, setStatusPicker] = useState<{
    issueId: string | null;
  }>({ issueId: null });
  const [assigneePicker, setAssigneePicker] = useState<{
    issueId: string | null;
  }>({ issueId: null });

  const updateIssueM = trpc.issue.update.useMutation({
    onSuccess: () => {
      toast.success("Status updated.");
      void utils.inbox.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const assignIssueM = trpc.issue.assign.useMutation({
    onSuccess: () => {
      toast.success("Assignees updated.");
      void utils.inbox.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const assignAgentM = trpc.issue.update.useMutation({
    onSuccess: () => {
      toast.success("Agent updated.");
      void utils.inbox.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Inbox"
        subtitle="Everything worth looking at, in one place."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md bg-subtle p-0.5 text-[0.6875rem]">
              <button
                type="button"
                onClick={() => setAllWorkspaces(false)}
                className={cn(
                  "focus-ring rounded px-2 py-1",
                  MOTION.fast,
                  !allWorkspaces
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                This workspace
              </button>
              <button
                type="button"
                onClick={() => setAllWorkspaces(true)}
                className={cn(
                  "focus-ring rounded px-2 py-1",
                  MOTION.fast,
                  allWorkspaces
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                All my workspaces
              </button>
            </div>
            <Link
              href={`/w/${workspace.slug}/dashboard`}
              className="focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
              title="Workspace overview — onboarding, focus, recent done"
            >
              Workspace overview
              <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected.size > 0 && (
          <BulkBar
            count={selected.size}
            onClear={clearSelection}
            contentClassName="mx-auto max-w-5xl"
            actions={inboxBulkActions({
              count: selected.size,
              disabled:
                snoozeManyM.isPending ||
                bulkAssignM.isPending ||
                bulkAssignAgentM.isPending ||
                markReadM.isPending,
              onMarkRead: () => markReadM.mutate(),
              onSnooze: (until) =>
                snoozeManyM.mutate({ ids: selectedArray, until }),
              onReassign: () => setReassignPickerOpen(true),
            })}
          />
        )}
        <div className="mx-auto max-w-5xl space-y-8 p-5">
          {/* Rollups — always render so the page doesn't jump while loading. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FocusRollup
              count={data ? focusInCycle : null}
              cycleName={data?.cycle?.name ?? null}
              slug={workspace.slug}
            />
            <PulseRollup
              openCount={pulse.openCount}
              inProgress={pulse.inProgress}
              doneThisWeek={pulse.doneThisWeek}
              activeSprint={pulse.activeSprint}
              slug={workspace.slug}
            />
          </div>

          {!allWorkspaces && (
            <AgentQueueSection
              rows={queueRows}
              loading={queueLoading}
              workspaceKey={workspace.key}
              slug={workspace.slug}
              ready={readyAgentIssues}
              claimed={claimedAgentIssues}
              assigned={assignedAgentIssues}
              onlineAgents={onlineAgents}
            />
          )}

          {isLoading || !data ? (
            <div className="space-y-4">
              <SkeletonList rows={4} />
              <SkeletonList rows={3} />
            </div>
          ) : data.assignedUnblocked.length === 0 &&
            data.mentions.length === 0 &&
            data.humanStalled.length === 0 &&
            data.agentStalled.length === 0 &&
            data.snoozed.length === 0 ? (
            <div className="rounded-lg border border-border bg-card/30 px-6 py-16">
              <EmptyState
                variant="page"
                icon={<Sun />}
                title="Inbox zero — nothing's waiting"
                description="When someone @mentions you, assigns work, or replies to a thread you're following, it lands here."
                action={
                  <Link
                    href={`/w/${workspace.slug}/dashboard`}
                    className="text-meta inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    Browse suggestions in dashboard
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                }
              />
            </div>
          ) : (
            <>
              <BucketSection
                bucket="assigned"
                title="Assigned & unblocked"
                hint="Your assignments that aren't waiting on anything else."
                icon={<Inbox className="h-3.5 w-3.5 text-muted-foreground" />}
                count={data.counts.assignedUnblocked}
                newCount={data.unreadSinceVisit.assignedUnblocked}
                emptyTitle="Nothing in your queue."
                emptyDescription={
                  <span>
                    Pick up something from Issues or press <Kbd>⇧C</Kbd> to create one.
                  </span>
                }
                emptyIcon={<Inbox />}
                rows={data.assignedUnblocked}
                slug={workspace.slug}
                previousVisitAt={previousVisitAt}
                selected={selected}
                onToggle={toggleSelected}
                onHover={(id) => (hoveredRowRef.current = id)}
                onPickStatus={(id) => setStatusPicker({ issueId: id })}
                onPickAssignee={(id) => setAssigneePicker({ issueId: id })}
              />

              <Section
                title={
                  <span className="flex items-center gap-2">
                    <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    Mentions
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      {data.counts.mentions}
                    </span>
                    {data.unreadSinceVisit.mentions > 0 && (
                      <NewBadge count={data.unreadSinceVisit.mentions} />
                    )}
                  </span>
                }
                hint="Comments that @mention you, last 7 days."
              >
                <Card as="ul">
                  {data.mentions.length === 0 ? (
                    <EmptyState
                      as="li"
                      variant="card"
                      icon={<MessageCircle />}
                      title="No recent mentions."
                      description="Comments that @mention you land here."
                    />
                  ) : (
                    data.mentions.map((m) => {
                      const isNew =
                        !!previousVisitAt &&
                        new Date(m.createdAt) > previousVisitAt;
                      return (
                        <li
                          key={m.id}
                          className={cn(
                            "flex items-start gap-3 px-3 py-2 text-[0.75rem]",
                            isNew && "bg-ember/5",
                          )}
                        >
                          {isNew && <NewDot />}
                          <WorkspaceBadge
                            slug={m.issue.workspace.slug}
                            wsKey={m.issue.workspace.key}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <Link
                                href={`/w/${m.issue.workspace.slug}/issues/${m.issue.id}`}
                                className="text-id hover:underline"
                              >
                                {formatIssueId(m.issue.workspace.key, m.issue.number)}
                              </Link>
                              <span className="truncate">{m.issue.title}</span>
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                              <span className="font-medium text-foreground">
                                {m.author.name ?? "Someone"}
                              </span>
                              {" — "}
                              {m.body}
                            </div>
                          </div>
                          <span className="text-meta shrink-0 text-muted-foreground">
                            {relativeTime(m.createdAt)}
                          </span>
                        </li>
                      );
                    })
                  )}
                </Card>
              </Section>

              <BucketSection
                bucket="humanStalled"
                title="Stalled — yours"
                hint={
                  data.stalledThresholdDays
                    ? `Your work without activity for more than ${data.stalledThresholdDays}d.`
                    : "Your work without recent activity."
                }
                icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />}
                count={data.counts.humanStalled}
                newCount={data.unreadSinceVisit.humanStalled}
                emptyTitle="Nothing stalled."
                emptyDescription="Work is moving. Nice."
                emptyIcon={<AlertTriangle />}
                rows={data.humanStalled}
                slug={workspace.slug}
                previousVisitAt={previousVisitAt}
                selected={selected}
                onToggle={toggleSelected}
                onHover={(id) => (hoveredRowRef.current = id)}
                onPickStatus={(id) => setStatusPicker({ issueId: id })}
                onPickAssignee={(id) => setAssigneePicker({ issueId: id })}
                tone="warn"
              />

              <BucketSection
                bucket="agentStalled"
                title="Agent runs stalled"
                hint={
                  data.stalledThresholdDays
                    ? `Issues whose assigned agent has been silent for more than ${data.stalledThresholdDays}d.`
                    : "Issues whose assigned agent has been silent."
                }
                icon={<Bot className="h-3.5 w-3.5 text-warning" />}
                count={data.counts.agentStalled}
                newCount={data.unreadSinceVisit.agentStalled}
                emptyTitle="No agent runs stalled."
                emptyDescription="Every assigned agent is moving."
                emptyIcon={<Bot />}
                rows={data.agentStalled}
                slug={workspace.slug}
                previousVisitAt={previousVisitAt}
                selected={selected}
                onToggle={toggleSelected}
                onHover={(id) => (hoveredRowRef.current = id)}
                onPickStatus={(id) => setStatusPicker({ issueId: id })}
                onPickAssignee={(id) => setAssigneePicker({ issueId: id })}
                tone="warn"
                showAgent
              />

              <SnoozedSection
                rows={data.snoozed}
                count={data.counts.snoozed}
                slug={workspace.slug}
              />

              {!allWorkspaces && (
                <Section
                  title={
                    <span className="flex items-center gap-2">
                      <Target className="h-3.5 w-3.5 text-muted-foreground" />
                      Current sprint burn
                    </span>
                  }
                  hint="Progress on the active sprint in this workspace."
                >
                  {data.cycle ? (
                    <div className="rounded-lg border border-border bg-card/40 p-4">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/w/${workspace.slug}/cycles/${data.cycle.id}`}
                            className="truncate text-sm font-semibold hover:underline"
                          >
                            {data.cycle.name}
                          </Link>
                          <div className="text-id text-muted-foreground">
                            {data.cycle.done}/{data.cycle.total} done · {data.cycle.remaining}{" "}
                            remaining
                          </div>
                        </div>
                        <div className="text-right font-mono text-2xl tabular-nums">
                          {data.cycle.pctDone}%
                        </div>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-subtle">
                        <div
                          className="h-full bg-ember transition-[width]"
                          style={{ width: `${data.cycle.pctDone}%` }}
                        />
                      </div>
                      <div className="mt-3 flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>
                          {data.cycle.endsAt
                            ? `Ends ${relativeTime(data.cycle.endsAt)}`
                            : "No end date"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <Card>
                      <EmptyState
                        variant="section"
                        icon={<Target />}
                        title="No active sprint."
                        description="Start one from the Sprints page."
                      />
                    </Card>
                  )}
                </Section>
              )}
            </>
          )}
        </div>
      </div>

      {/* Per-row pickers */}
      {statusPicker.issueId && (
        <StatusPickerModal
          issueId={statusPicker.issueId}
          open={!!statusPicker.issueId}
          onOpenChange={(o) => !o && setStatusPicker({ issueId: null })}
          onSelect={(statusId) => {
            if (!statusPicker.issueId) return;
            updateIssueM.mutate({ id: statusPicker.issueId, statusId });
            setStatusPicker({ issueId: null });
          }}
        />
      )}
      {assigneePicker.issueId && (
        <AssigneePickerModal
          open={!!assigneePicker.issueId}
          onOpenChange={(o) => !o && setAssigneePicker({ issueId: null })}
          onPickUser={(userId) => {
            if (!assigneePicker.issueId) return;
            assignIssueM.mutate({
              id: assigneePicker.issueId,
              userIds: userId ? [userId] : [],
            });
            setAssigneePicker({ issueId: null });
          }}
          onPickAgent={(agentId) => {
            if (!assigneePicker.issueId) return;
            assignAgentM.mutate({
              id: assigneePicker.issueId,
              assignedAgentId: agentId,
            });
            setAssigneePicker({ issueId: null });
          }}
        />
      )}

      {/* Bulk reassign picker */}
      {reassignPickerOpen && (
        <AssigneePickerModal
          open={reassignPickerOpen}
          onOpenChange={setReassignPickerOpen}
          onPickUser={(userId) => {
            bulkAssignM.mutate({
              issueIds: selectedArray,
              claimedById: userId,
            });
            setReassignPickerOpen(false);
          }}
          onPickAgent={(agentId) => {
            bulkAssignAgentM.mutate({
              issueIds: selectedArray,
              assignedAgentId: agentId,
            });
            setReassignPickerOpen(false);
          }}
        />
      )}
    </>
  );
}


// ---------------------------------------------------------------------------
// Bulk action bar — actions are configured here and rendered by the
// shared <BulkBar /> component (`@/components/bulk-bar`). The inbox
// uses three actions: mark-read, snooze (own popover via SnoozeMenu),
// and reassign.
// ---------------------------------------------------------------------------

function inboxBulkActions({
  count,
  disabled,
  onMarkRead,
  onSnooze,
  onReassign,
}: {
  count: number;
  disabled: boolean;
  onMarkRead: () => void;
  onSnooze: (until: Date | null) => void;
  onReassign: () => void;
}): BulkBarAction[] {
  return [
    {
      id: "mark-read",
      label: `Mark read (${count})`,
      icon: <CheckCheck className="h-3 w-3" />,
      title: "Mark read",
      disabled,
      onClick: onMarkRead,
    },
    {
      id: "snooze",
      label: null,
      // SnoozeMenu owns its own popover state; we render it as the
      // trigger node so positioning works correctly.
      render: (cls) => (
        <SnoozeMenu
          onSelect={onSnooze}
          trigger={
            <button
              type="button"
              disabled={disabled}
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
      id: "reassign",
      label: "Reassign…",
      icon: <UserCircle2 className="h-3 w-3" />,
      title: "Reassign selected",
      disabled,
      onClick: onReassign,
    },
  ];
}

// ---------------------------------------------------------------------------
// Bucket section + row
// ---------------------------------------------------------------------------

type StalledIssueRow = {
  id: string;
  number: number;
  title: string;
  updatedAt: Date | string;
  snoozedUntil?: Date | string | null;
  workspace: { slug: string; key: string };
  status: { id?: string; name: string; color: string; category?: string };
  project: { id: string; key: string; name: string; color: string | null } | null;
  assignedAgent?: {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
    status: AgentStatus;
  } | null;
};

function BucketSection({
  bucket,
  title,
  hint,
  icon,
  count,
  newCount,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  rows,
  slug,
  previousVisitAt,
  selected,
  onToggle,
  onHover,
  onPickStatus,
  onPickAssignee,
  tone,
  showAgent,
}: {
  bucket: BucketKey;
  title: string;
  hint?: string;
  icon: React.ReactNode;
  count: number;
  newCount: number;
  emptyTitle: string;
  emptyDescription: React.ReactNode;
  emptyIcon: React.ReactNode;
  rows: StalledIssueRow[];
  slug: string;
  previousVisitAt: Date | null;
  selected: Set<string>;
  onToggle: (id: string, opts?: { range?: boolean }) => void;
  onHover: (id: string | null) => void;
  onPickStatus: (id: string) => void;
  onPickAssignee: (id: string) => void;
  tone?: "warn";
  showAgent?: boolean;
}) {
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          {icon}
          {title}
          <span className="font-mono text-[0.6875rem] text-muted-foreground">{count}</span>
          {newCount > 0 && <NewBadge count={newCount} />}
        </span>
      }
      hint={hint}
    >
      <Card as="ul">
        {rows.length === 0 ? (
          <EmptyState
            as="li"
            variant="card"
            icon={emptyIcon}
            title={emptyTitle}
            description={emptyDescription}
          />
        ) : (
          rows.map((i) => (
            <IssueRow
              key={i.id}
              issue={i}
              tone={tone}
              showAgent={!!showAgent}
              isSelected={selected.has(i.id)}
              isNew={!!previousVisitAt && new Date(i.updatedAt) > previousVisitAt}
              onToggle={(opts) => onToggle(i.id, opts)}
              onHover={(h) => onHover(h ? i.id : null)}
              // RowQuickActions calls these with an HTMLElement anchor;
              // we ignore it because our pickers are page-level modals.
              onPickStatus={() => onPickStatus(i.id)}
              onPickAssignee={() => onPickAssignee(i.id)}
              bucket={bucket}
              slug={slug}
            />
          ))
        )}
      </Card>
    </Section>
  );
}

function IssueRow({
  issue,
  tone,
  showAgent,
  isSelected,
  isNew,
  onToggle,
  onHover,
  onPickStatus,
  onPickAssignee,
  // bucket is passed for future per-bucket telemetry / styling — currently
  // unused but a stable hook so we don't have to thread props later.
  bucket: _bucket,
  slug: _slug,
}: {
  issue: StalledIssueRow;
  tone?: "warn";
  showAgent: boolean;
  isSelected: boolean;
  isNew: boolean;
  onToggle: (opts?: { range?: boolean }) => void;
  onHover: (hovered: boolean) => void;
  // Loose signature — `RowQuickActions` calls these with an HTMLElement
  // anchor; the inbox callers drop it because our pickers are page-level.
  onPickStatus: (anchor?: HTMLElement) => void;
  onPickAssignee: (anchor?: HTMLElement) => void;
  bucket: BucketKey;
  slug: string;
}) {
  return (
    <li
      className={cn(
        "group relative flex items-center gap-2 px-3 py-2 text-[0.75rem]",
        isSelected ? "bg-ember/5" : "hover:bg-subtle/40",
      )}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {isNew && <NewDot />}
      <input
        type="checkbox"
        checked={isSelected}
        onClick={(e) => {
          // Capture range modifier on click so toggle gets it. The change
          // event below still fires normally.
          if (e.shiftKey) {
            e.preventDefault();
            onToggle({ range: true });
          }
        }}
        onChange={(e) => {
          // No-op for shift-click (handled in onClick). Plain click toggles.
          if (!(e.nativeEvent as MouseEvent).shiftKey) onToggle();
        }}
        className="h-3.5 w-3.5 shrink-0 rounded border-border"
        aria-label="Select issue"
      />
      <WorkspaceBadge slug={issue.workspace.slug} wsKey={issue.workspace.key} />
      <Link
        href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
        className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
      >
        <span className="text-id shrink-0 text-muted-foreground">
          {formatIssueId(issue.workspace.key, issue.number)}
        </span>
        <span className="truncate">{issue.title}</span>
      </Link>
      {showAgent && issue.assignedAgent && (
        <span
          className="text-meta inline-flex shrink-0 items-center gap-1 text-muted-foreground"
          title={`Assigned to ${issue.assignedAgent.name}`}
        >
          {issue.assignedAgent.avatar ? (
            <span aria-hidden className="text-id">
              {issue.assignedAgent.avatar}
            </span>
          ) : null}
          <AgentPresenceDot status={issue.assignedAgent.status} size="sm" />
          <span className="text-id">@{issue.assignedAgent.profileKey}</span>
        </span>
      )}
      {issue.project && (
        <ProjectChip
          project={issue.project}
          slug={issue.workspace.slug}
          className="shrink-0 px-1.5 py-0.5"
        />
      )}
      <span
        className="text-id shrink-0 rounded px-1.5 py-0.5"
        style={{
          backgroundColor: `${issue.status.color}22`,
          color: issue.status.color,
        }}
        title={
          issue.status.category
            ? `${issue.status.name} · ${issue.status.category}`
            : issue.status.name
        }
      >
        {issue.status.name}
      </span>
      <span
        className={cn(
          "text-meta shrink-0",
          tone === "warn" ? "text-warning" : "text-muted-foreground",
        )}
      >
        {relativeTime(issue.updatedAt)}
      </span>

      {/* Inline quick actions — hover-revealed (always-visible when selected). */}
      <RowQuickActions
        issueId={issue.id}
        snoozedUntil={issue.snoozedUntil}
        hasAssignedAgent={!!issue.assignedAgent}
        onPickStatus={onPickStatus}
        onPickAssignee={onPickAssignee}
        alwaysVisible={isSelected}
        className="shrink-0"
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Snoozed section — collapsible <details>
// ---------------------------------------------------------------------------

function SnoozedSection({
  rows,
  count,
  slug: _slug,
}: {
  rows: StalledIssueRow[];
  count: number;
  slug: string;
}) {
  const utils = trpc.useUtils();
  const unsnoozeM = trpc.issue.unsnooze.useMutation({
    onSuccess: () => {
      toast.success("Unsnoozed.");
      void utils.inbox.get.invalidate();
      void utils.inbox.badge.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (count === 0) return null;
  return (
    <details className="group rounded-lg border border-border bg-card/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
        <CalendarClock className="h-3 w-3" />
        <span>Snoozed</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground/70">
          {count}
        </span>
        <ChevronDown className="ml-auto h-3 w-3 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="border-t border-border">
        {rows.map((i) => (
          <li
            key={i.id}
            className="flex items-center gap-2 px-3 py-2 text-[0.75rem] hover:bg-subtle/40"
          >
            <WorkspaceBadge slug={i.workspace.slug} wsKey={i.workspace.key} />
            <Link
              href={`/w/${i.workspace.slug}/issues/${i.id}`}
              className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
            >
              <span className="text-id shrink-0 text-muted-foreground">
                {formatIssueId(i.workspace.key, i.number)}
              </span>
              <span className="truncate">{i.title}</span>
            </Link>
            {i.snoozedUntil && (
              <span
                className="text-meta shrink-0 text-muted-foreground"
                title={`Snoozed until ${new Date(
                  i.snoozedUntil,
                ).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}`}
              >
                until{" "}
                {new Date(i.snoozedUntil).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                unsnoozeM.mutate({ id: i.id });
              }}
              disabled={unsnoozeM.isPending}
              className="focus-ring inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Unsnooze
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Status / Assignee picker modals
// ---------------------------------------------------------------------------

function StatusPickerModal({
  issueId: _issueId,
  open,
  onOpenChange,
  onSelect,
}: {
  issueId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSelect: (statusId: string) => void;
}) {
  const { data: statuses, isLoading } = trpc.status.list.useQuery();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items = (statuses ?? []).filter(
    (s) => !q || s.name.toLowerCase().includes(q),
  );
  return (
    <Picker
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Move to status…"
      items={items}
      getKey={(s) => s.id}
      onQueryChange={setQuery}
      loading={isLoading}
      emptyLabel="No statuses match."
      onSelect={(s) => onSelect(s.id)}
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

function AssigneePickerModal({
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
        status: AgentStatus;
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
          status: a.status as AgentStatus,
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
                <span className="text-muted-foreground">Unassign</span>
              </div>
            );
          }
          return (
            <div className="flex items-center gap-2">
              <Avatar name={r.name} image={r.image} size={18} />
              <span className="truncate">{r.name}</span>
              {r.email && (
                <span className="text-id ml-auto truncate text-muted-foreground">
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
            <AgentPresenceDot status={r.status} />
            <span className="truncate">{r.name}</span>
            <span className="text-id ml-auto text-muted-foreground">
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

// ---------------------------------------------------------------------------
// Visual primitives
// ---------------------------------------------------------------------------

function NewBadge({ count }: { count: number }) {
  return (
    <span
      title={`${count} item${count === 1 ? "" : "s"} updated since your last visit`}
      className="inline-flex items-center gap-1 rounded-full border border-ember/30 bg-ember/10 px-1.5 py-0 text-[0.625rem] font-medium uppercase tracking-wider text-ember"
    >
      {count} new
    </span>
  );
}

function NewDot() {
  return (
    <span
      title="Updated since your last visit"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ember"
    />
  );
}

// ---------------------------------------------------------------------------
// Rollup blocks (unchanged structure, kept inline so we don't reach for an
// extracted file just for this page).
// ---------------------------------------------------------------------------

function FocusRollup({
  count,
  cycleName,
  slug,
}: {
  count: number | null;
  cycleName: string | null;
  slug: string;
}) {
  const hasData = count !== null;
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-card/40 p-4 hover:border-ember/40",
        MOTION.base,
      )}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ember/10 text-ember">
        <Zap className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Today&apos;s focus
        </div>
        <div className="mt-0.5 text-sm">
          {hasData ? (
            count === 0 ? (
              <span className="text-muted-foreground">
                Nothing pressing — pick something up, or press ⇧C.
              </span>
            ) : (
              <>
                <span className="font-mono tabular-nums">{count}</span> unblocked{" "}
                {count === 1 ? "issue" : "issues"} waiting on you
                {cycleName && (
                  <>
                    {" "}
                    · sprint <span className="font-medium">{cycleName}</span>
                  </>
                )}
                .
              </>
            )
          ) : (
            <span className="text-muted-foreground">Loading…</span>
          )}
        </div>
      </div>
      <Link
        href={`/w/${slug}/issues?mine=1`}
        className={cn(
          "ml-auto shrink-0 text-muted-foreground group-hover:text-foreground",
          MOTION.fast,
        )}
        title="Open my issues"
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function PulseRollup({
  openCount,
  inProgress,
  doneThisWeek,
  activeSprint,
  slug,
}: {
  openCount: number;
  inProgress: number;
  doneThisWeek: number;
  activeSprint: string;
  slug: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/30 p-4">
      <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Workspace pulse
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 text-[0.6875rem]">
        <Stat label="Open" value={openCount} href={`/w/${slug}/issues`} />
        <Stat label="In progress" value={inProgress} href={`/w/${slug}/issues`} />
        <Stat label="Done / 7d" value={doneThisWeek} href={`/w/${slug}/issues?status=done`} />
        <Stat label="Sprint" value={activeSprint} href={`/w/${slug}/cycles`} mono={false} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent queue (unchanged from prior design)
// ---------------------------------------------------------------------------

type AgentQueueIssue = {
  id: string;
  number: number;
  title: string;
  priority: string;
  claimedAt: Date | string | null;
  claimExpiresAt: Date | string | null;
  unblocked: boolean;
  status: { name: string; color: string };
  project: { id: string; key: string; name: string; color: string | null } | null;
  claimedBy: { name: string | null; email: string | null } | null;
  assignedAgent: {
    id: string;
    name: string;
    profileKey: string;
    status: AgentStatus;
  } | null;
};

function AgentQueueSection({
  rows,
  loading,
  workspaceKey,
  slug,
  ready,
  claimed,
  assigned,
  onlineAgents,
}: {
  rows: AgentQueueIssue[];
  loading: boolean;
  workspaceKey: string;
  slug: string;
  ready: number;
  claimed: number;
  assigned: number;
  onlineAgents: number;
}) {
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          Agent queue
          <span className="font-mono text-[0.6875rem] text-muted-foreground">{rows.length}</span>
        </span>
      }
      hint={`${ready} ready now · ${assigned} assigned · ${claimed} claimed · ${onlineAgents} online/busy agents`}
    >
      <Card as="ul">
        {loading ? (
          <li className="px-3 py-3">
            <SkeletonList rows={3} />
          </li>
        ) : rows.length === 0 ? (
          <EmptyState
            as="li"
            variant="card"
            icon={<Bot />}
            title="No queued agent work."
            description="Queue an issue from its detail page when it is ready for an agent to claim."
          />
        ) : (
          rows.map((issue) => (
            <li key={issue.id} className="px-3 py-2 hover:bg-subtle/40">
              <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
                <Link
                  href={`/w/${slug}/issues/${issue.id}`}
                  className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
                >
                  <span className="text-id shrink-0 text-muted-foreground">
                    {formatIssueId(workspaceKey, issue.number)}
                  </span>
                  <span className="truncate">{issue.title}</span>
                </Link>
                <Badge color={issue.status.color}>{issue.status.name}</Badge>
                {issue.project && (
                  <ProjectChip
                    project={{
                      id: issue.project.id,
                      key: issue.project.key,
                      name: issue.project.name,
                      color: issue.project.color,
                    }}
                    slug={slug}
                    className="shrink-0 px-1.5 py-0.5"
                  />
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted-foreground">
                <QueueStateBadge issue={issue} />
                {issue.assignedAgent ? (
                  <span
                    className="inline-flex items-center gap-1"
                    title={`Assigned to ${issue.assignedAgent.name}`}
                  >
                    <AgentPresenceDot status={issue.assignedAgent.status} size="sm" />
                    <span className="font-mono">@{issue.assignedAgent.profileKey}</span>
                  </span>
                ) : (
                  <span>unassigned</span>
                )}
                {issue.claimExpiresAt && (
                  <span>claim expires {relativeTime(issue.claimExpiresAt)}</span>
                )}
              </div>
            </li>
          ))
        )}
      </Card>
    </Section>
  );
}

function QueueStateBadge({ issue }: { issue: AgentQueueIssue }) {
  if (issue.claimedAt) {
    const by = issue.claimedBy?.name ?? issue.claimedBy?.email ?? "agent";
    return <Badge className="bg-ember/10 text-ember">Claimed by {by}</Badge>;
  }
  if (!issue.unblocked) {
    return <Badge className="bg-danger/10 text-danger">Blocked</Badge>;
  }
  return <Badge className="bg-success/10 text-success">Ready to claim</Badge>;
}

function Stat({
  label,
  value,
  href,
  mono = true,
}: {
  label: string;
  value: string | number;
  href?: string;
  mono?: boolean;
}) {
  const body = (
    <div className="flex min-w-0 flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "mt-0.5 truncate text-foreground",
          mono ? "font-mono text-sm tabular-nums" : "text-sm",
        )}
      >
        {value}
      </span>
    </div>
  );
  if (!href) return body;
  return (
    <Link href={href} className="min-w-0 rounded-md px-1 py-0.5 hover:bg-subtle/60">
      {body}
    </Link>
  );
}

function WorkspaceBadge({ slug, wsKey }: { slug: string; wsKey: string }) {
  const c = workspaceColor(wsKey);
  return (
    <Link
      href={`/w/${slug}/inbox`}
      className="text-id grid h-5 w-5 shrink-0 place-items-center rounded-sm font-semibold"
      style={{
        backgroundColor: c.bg,
        color: c.fg,
        boxShadow: `inset 0 0 0 1px ${c.ring}`,
      }}
      title={wsKey}
    >
      {wsKey.slice(0, 2)}
    </Link>
  );
}
