"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Clock } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

type Form = {
  id?: string;
  name: string;
  projectId: string;
  titleTemplate: string;
  descriptionTemplate: string;
  defaultPriority: Priority;
  intervalDays: number;
  nextRunAt: string; // yyyy-mm-dd
  active: boolean;
};

function defaultForm(): Form {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return {
    name: "",
    projectId: "",
    titleTemplate: "",
    descriptionTemplate: "",
    defaultPriority: "NONE",
    intervalDays: 7,
    nextRunAt: d.toISOString().slice(0, 10),
    active: true,
  };
}

export default function RecurringPage() {
  const { data: rows, refetch } = trpc.recurring.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const [editing, setEditing] = useState<Form | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const create = trpc.recurring.create.useMutation({
    onSuccess: () => {
      toast.success("Schedule created.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.recurring.update.useMutation({
    onSuccess: () => {
      toast.success("Schedule saved.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.recurring.delete.useMutation({
    onSuccess: () => {
      toast.success("Schedule deleted.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const runNow = trpc.recurring.runNow.useMutation({
    onSuccess: () => {
      toast.success("Issue created from schedule.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Recurring issues"
        subtitle="Auto-created on a cadence. Daily standups, weekly reviews, monthly retros."
        actions={
          <Button variant="ember" size="sm" onClick={() => setEditing(defaultForm())}>
            New schedule
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card>
            {(rows ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Badge>{r.intervalDays === 1 ? "daily" : `every ${r.intervalDays}d`}</Badge>
                    {!r.active && <Badge color="#78716c">paused</Badge>}
                    {r.project && (
                      <Badge color={r.project.color ?? undefined}>{r.project.key}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {r.titleTemplate}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Next run {relativeTime(r.nextRunAt)}
                    {r.lastRunAt && <> · last ran {relativeTime(r.lastRunAt)}</>}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={runNow.isPending}
                  onClick={() => runNow.mutate({ id: r.id })}
                >
                  Run now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setEditing({
                      id: r.id,
                      name: r.name,
                      projectId: r.projectId ?? "",
                      titleTemplate: r.titleTemplate,
                      descriptionTemplate: r.descriptionTemplate ?? "",
                      defaultPriority: r.defaultPriority as Priority,
                      intervalDays: r.intervalDays,
                      nextRunAt: new Date(r.nextRunAt).toISOString().slice(0, 10),
                      active: r.active,
                    })
                  }
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleteTarget({ id: r.id, name: r.name })}
                >
                  Delete
                </Button>
              </li>
            ))}
            {rows?.length === 0 && (
              <EmptyState
                icon={Clock}
                title="No recurring schedules yet"
                hint="The ticker scans every 5 minutes — add a schedule to auto-create issues on a cadence."
              />
            )}
          </Card>
        </div>
      </div>

      <Dialog open={!!editing} onClose={() => setEditing(null)} className="max-w-xl">
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing.name.trim() || !editing.titleTemplate.trim())
                return toast.error("Name and title required.");
              const payload = {
                name: editing.name.trim(),
                projectId: editing.projectId || null,
                titleTemplate: editing.titleTemplate.trim(),
                descriptionTemplate: editing.descriptionTemplate.trim() || null,
                defaultPriority: editing.defaultPriority,
                intervalDays: editing.intervalDays,
                nextRunAt: new Date(editing.nextRunAt),
                active: editing.active,
              };
              if (editing.id) update.mutate({ id: editing.id, ...payload });
              else create.mutate(payload);
            }}
            className="space-y-3 p-5"
          >
            <div className="text-sm font-semibold">
              {editing.id ? "Edit schedule" : "New schedule"}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                autoFocus
                placeholder="e.g. Weekly review"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Title template</label>
              <Input
                value={editing.titleTemplate}
                onChange={(e) => setEditing({ ...editing, titleTemplate: e.target.value })}
                placeholder="Weekly review"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Description template</label>
              <textarea
                value={editing.descriptionTemplate}
                onChange={(e) =>
                  setEditing({ ...editing, descriptionTemplate: e.target.value })
                }
                rows={4}
                className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Interval (days)</label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={editing.intervalDays}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      intervalDays: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Next run (date)</label>
                <Input
                  type="date"
                  value={editing.nextRunAt}
                  onChange={(e) => setEditing({ ...editing, nextRunAt: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Priority</label>
                <select
                  value={editing.defaultPriority}
                  onChange={(e) =>
                    setEditing({ ...editing, defaultPriority: e.target.value as Priority })
                  }
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Project</label>
                <select
                  value={editing.projectId}
                  onChange={(e) => setEditing({ ...editing, projectId: e.target.value })}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">No project</option>
                  {projects?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Active</label>
                <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 text-xs">
                  <input
                    type="checkbox"
                    checked={editing.active}
                    onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                    className="h-3.5 w-3.5"
                  />
                  Ticker creates issues
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="ember" disabled={create.isPending || update.isPending}>
                {editing.id ? "Save" : "Create"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title={`Delete "${deleteTarget?.name}"?`}
        description="This action cannot be undone."
        primaryLabel="Delete"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync({ id: deleteTarget.id });
          setDeleteTarget(null);
        }}
      />
    </>
  );
}
