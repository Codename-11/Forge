"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/modal/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { trpc } from "@/lib/trpc";
import { cn, formatDate } from "@/lib/utils";
import { useTimePrefs } from "@/lib/time-prefs";
import { useWorkspace } from "@/hooks/use-workspace";
import { ScheduledTaskDialog, type ScheduledTaskListItem } from "./scheduled-task-dialog";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function ScheduledTasksPage() {
  const workspace = useWorkspace();
  const timePrefs = useTimePrefs();
  const utils = trpc.useUtils();
  const { data: tasks, isLoading } = trpc.scheduledTask.list.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTaskListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskListItem | null>(null);
  const canManage = workspace.role === "OWNER" || workspace.role === "ADMIN";

  const refresh = () => utils.scheduledTask.list.invalidate();
  const pauseTask = trpc.scheduledTask.pause.useMutation({ onSuccess: refresh });
  const resumeTask = trpc.scheduledTask.resume.useMutation({ onSuccess: refresh });
  const runTask = trpc.scheduledTask.runNow.useMutation({ onSuccess: refresh });
  const deleteTask = trpc.scheduledTask.delete.useMutation({ onSuccess: refresh });

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(task: ScheduledTaskListItem) {
    setEditing(task);
    setDialogOpen(true);
  }

  async function runNow(task: ScheduledTaskListItem) {
    try {
      const result = await runTask.mutateAsync({ id: task.id });
      if (result?.status === "FAILED") toast.error("Run failed. Error details were saved.");
      else toast.success("Scheduled task completed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run task.");
    }
  }

  async function toggleEnabled(task: ScheduledTaskListItem) {
    try {
      if (task.enabled) {
        await pauseTask.mutateAsync({ id: task.id });
        toast.success("Scheduled task paused.");
      } else {
        await resumeTask.mutateAsync({ id: task.id });
        toast.success("Scheduled task resumed with a new future run time.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update task.");
    }
  }

  return (
    <>
      <Topbar
        title="Scheduled tasks"
        subtitle="Recurring automation with durable run history and timezone-aware schedules."
        actions={
          canManage ? (
            <Button size="sm" variant="ember" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              New task
            </Button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
          {!canManage && (
            <div className="rounded-lg border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
              Scheduled tasks are visible to workspace members. An owner or admin can change them.
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center rounded-lg border border-border bg-card/40 py-20 text-sm text-muted-foreground">
              <Spinner size="sm" /> Loading scheduled tasks…
            </div>
          ) : !tasks?.length ? (
            <div className="rounded-lg border border-border bg-card/30">
              <EmptyState
                variant="page"
                icon={<CalendarClock />}
                title="No scheduled tasks yet"
                description="Turn a recurring prompt into a real issue delivered to the inbox or a project."
                action={
                  canManage ? (
                    <Button variant="ember" onClick={openCreate}>
                      <Plus className="h-4 w-4" /> Create scheduled task
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  workspaceSlug={workspace.slug}
                  workspaceKey={workspace.key}
                  canManage={canManage}
                  formatTimestamp={(date) => formatDate(date, timePrefs)}
                  onEdit={() => openEdit(task)}
                  onRun={() => runNow(task)}
                  onToggle={() => toggleEnabled(task)}
                  onDelete={() => setDeleteTarget(task)}
                  pending={
                    (runTask.isPending && runTask.variables?.id === task.id) ||
                    (pauseTask.isPending && pauseTask.variables?.id === task.id) ||
                    (resumeTask.isPending && resumeTask.variables?.id === task.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ScheduledTaskDialog
        open={dialogOpen}
        task={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          setDialogOpen(false);
          void refresh();
          toast.success(editing ? "Scheduled task updated." : "Scheduled task created.");
        }}
      />

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        variant="destructive"
        typeToConfirm={deleteTarget?.name}
        title={`Delete “${deleteTarget?.name ?? "scheduled task"}”?`}
        description="The task and its run history will be permanently deleted. Issues already created by it are kept."
        primaryLabel="Delete task"
        loading={deleteTask.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteTask.mutateAsync({
              id: deleteTarget.id,
              confirmation: deleteTarget.name,
            });
            toast.success("Scheduled task deleted.");
            setDeleteTarget(null);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not delete task.");
          }
        }}
      />
    </>
  );
}

function TaskCard({
  task,
  workspaceSlug,
  workspaceKey,
  canManage,
  formatTimestamp,
  onEdit,
  onRun,
  onToggle,
  onDelete,
  pending,
}: {
  task: ScheduledTaskListItem;
  workspaceSlug: string;
  workspaceKey: string;
  canManage: boolean;
  formatTimestamp: (date: Date | string) => string;
  onEdit: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
  pending: boolean;
}) {
  const running = task.status === "RUNNING";
  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card/40">
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge status={task.status} />
            <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{task.name}</h2>
            <span className="text-meta text-muted-foreground">Create issue</span>
          </div>
          <div>
            <div className="text-sm text-foreground">{task.issueTitle}</div>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {task.prompt}
            </p>
          </div>
          <dl className="grid grid-cols-1 gap-x-5 gap-y-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
            <Metadata label="Schedule" value={scheduleLabel(task)} />
            <Metadata
              label="Delivery"
              value={
                task.deliveryType === "PROJECT"
                  ? (task.project?.name ?? "Missing project")
                  : "Workspace inbox"
              }
            />
            <Metadata
              label="Last run"
              value={task.lastRunAt ? formatTimestamp(task.lastRunAt) : "Never"}
            />
            <Metadata
              label="Next run"
              value={task.nextRunAt ? formatTimestamp(task.nextRunAt) : "Paused"}
              emphasized={task.enabled}
            />
          </dl>
          {task.status === "FAILED" && task.lastError && (
            <div className="flex gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">
                  Last run failed
                  {task.consecutiveFailures > 1
                    ? ` · ${task.consecutiveFailures} consecutive failures`
                    : ""}
                </div>
                <p className="text-meta mt-0.5 break-words">{task.lastError}</p>
                {task.nextRunAt && (
                  <p className="text-meta mt-1">The next scheduled run remains active.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {canManage && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 lg:justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={onRun}
              disabled={pending || running || !task.enabled}
            >
              {pending && runTaskIsLikely(task) ? (
                <Spinner size="sm" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Run now
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggle} disabled={pending || running}>
              {task.enabled ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {task.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onEdit}
              disabled={running}
              aria-label={`Edit ${task.name}`}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDelete}
              disabled={running}
              className="text-danger hover:bg-danger/10"
              aria-label={`Delete ${task.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        )}
      </div>

      <details className="border-t border-border bg-background/30">
        <summary className="focus-ring cursor-pointer px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
          Recent runs ({task.runs.length})
        </summary>
        {task.runs.length ? (
          <div className="divide-y divide-border border-t border-border">
            {task.runs.map((run) => (
              <div
                key={run.id}
                className="grid gap-2 px-4 py-3 text-xs sm:grid-cols-[9rem_1fr_auto] sm:items-center"
              >
                <div className="flex items-center gap-2">
                  <RunIcon status={run.status} />
                  <span className="capitalize text-foreground">{run.status.toLowerCase()}</span>
                  <span className="text-meta text-muted-foreground">
                    {run.trigger.toLowerCase()}
                  </span>
                </div>
                <div className="text-meta min-w-0 text-muted-foreground">
                  {formatTimestamp(run.startedAt)}
                  {run.error && <p className="mt-1 break-words text-danger">{run.error}</p>}
                </div>
                {run.outputIssue && (
                  <Link
                    href={`/w/${workspaceSlug}/issues/${run.outputIssue.id}`}
                    className="focus-ring text-meta inline-flex items-center gap-1 rounded text-foreground hover:text-ember"
                  >
                    <span className="text-id">
                      {workspaceKey}-{run.outputIssue.number}
                    </span>
                    <span className="max-w-48 truncate">{run.outputIssue.title}</span>
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            No runs yet.
          </p>
        )}
      </details>
    </article>
  );
}

function runTaskIsLikely(task: ScheduledTaskListItem) {
  return task.status !== "PAUSED";
}

function Metadata({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-meta mt-0.5 truncate",
          emphasized ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function StatusBadge({ status }: { status: ScheduledTaskListItem["status"] }) {
  const styles = {
    ACTIVE: "bg-ember/10 text-ember",
    RUNNING: "bg-warning/10 text-warning",
    SUCCEEDED: "bg-success/10 text-success",
    FAILED: "bg-danger/10 text-danger",
    PAUSED: "bg-subtle text-muted-foreground",
  }[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
        styles,
      )}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

function RunIcon({ status }: { status: ScheduledTaskListItem["runs"][number]["status"] }) {
  if (status === "SUCCEEDED") return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  if (status === "FAILED") return <AlertTriangle className="h-3.5 w-3.5 text-danger" />;
  return <Clock3 className="h-3.5 w-3.5 text-warning" />;
}

function scheduleLabel(task: ScheduledTaskListItem) {
  if (task.scheduleType === "INTERVAL") {
    const minutes = task.intervalMinutes ?? 0;
    if (minutes % 1_440 === 0) return `Every ${minutes / 1_440} day${minutes === 1_440 ? "" : "s"}`;
    if (minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
    return `Every ${minutes} minutes`;
  }
  const minutes = task.timeOfDayMinutes ?? 0;
  const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  if (task.scheduleType === "DAILY") return `Daily at ${time} · ${task.timezone}`;
  return `${WEEKDAYS[task.dayOfWeek ?? 0]} at ${time} · ${task.timezone}`;
}
