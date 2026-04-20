"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, Kbd, SkeletonList, useDensity } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

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
  emptyHint,
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
  emptyHint?: React.ReactNode;
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
  const selectedArray = Array.from(selected);

  const bulkStatus = trpc.issue.bulkStatus.useMutation({
    onSuccess: () => {
      toast.success(`Status changed for ${selectedArray.length} issue(s).`);
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

  async function bulkDelete() {
    if (!confirm(`Delete ${selectedArray.length} issue(s)?`)) return;
    await Promise.all(selectedArray.map((id) => softDelete.mutateAsync({ id })));
    toast.success(`Deleted ${selectedArray.length} issue(s).`);
    setSelected(new Set());
  }

  if (isLoading) {
    return (
      <div className="px-5 py-2">
        <SkeletonList rows={8} />
      </div>
    );
  }

  if (filtered.length === 0) {
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
              <Button size="sm" variant="ghost" onClick={bulkDelete}>
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
            ? "w-20 shrink-0 font-mono text-[11px] text-muted-foreground"
            : "w-20 shrink-0 font-mono text-[11px] text-muted-foreground";
          const titleCls = compact
            ? "truncate text-[12px]"
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
                <span className="w-4 text-center font-mono text-[11px] text-muted-foreground">
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
                  <span className="text-[11px] text-muted-foreground">
                    {relativeTime(issue.createdAt)}
                  </span>
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
    </div>
  );
}
