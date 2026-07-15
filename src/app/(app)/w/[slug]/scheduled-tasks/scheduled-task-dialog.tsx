"use client";

import { useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Combobox } from "@/components/ui/combobox";
import { trpc } from "@/lib/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type ScheduledTaskListItem = RouterOutputs["scheduledTask"]["list"][number];

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Australia/Sydney",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

type FormState = {
  name: string;
  issueTitle: string;
  prompt: string;
  issuePriority: (typeof PRIORITIES)[number];
  deliveryType: "INBOX" | "PROJECT";
  projectId: string;
  scheduleType: "INTERVAL" | "DAILY" | "WEEKLY";
  intervalMinutes: number;
  localTime: string;
  dayOfWeek: number;
  timezone: string;
};

function minutesToTime(minutes: number | null) {
  const value = minutes ?? 9 * 60;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function initialState(task: ScheduledTaskListItem | null): FormState {
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    name: task?.name ?? "",
    issueTitle: task?.issueTitle ?? "",
    prompt: task?.prompt ?? "",
    issuePriority: task?.issuePriority ?? "NONE",
    deliveryType: task?.deliveryType ?? "INBOX",
    projectId: task?.projectId ?? "",
    scheduleType: task?.scheduleType ?? "DAILY",
    intervalMinutes: task?.intervalMinutes ?? 60,
    localTime: minutesToTime(task?.timeOfDayMinutes ?? null),
    dayOfWeek: task?.dayOfWeek ?? 1,
    timezone: task?.timezone ?? browserTimezone,
  };
}

export function ScheduledTaskDialog({
  open,
  task,
  onClose,
  onSaved,
}: {
  open: boolean;
  task: ScheduledTaskListItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(task));
  const { data: projects } = trpc.project.list.useQuery(
    { archived: false, limit: 500 },
    { enabled: open },
  );
  const create = trpc.scheduledTask.create.useMutation();
  const update = trpc.scheduledTask.update.useMutation();

  useEffect(() => {
    if (open) setForm(initialState(task));
  }, [open, task]);

  const timezoneOptions = useMemo(
    () => (TIMEZONES.includes(form.timezone) ? TIMEZONES : [form.timezone, ...TIMEZONES]),
    [form.timezone],
  );
  const pending = create.isPending || update.isPending;
  const error = create.error?.message ?? update.error?.message;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const schedule =
      form.scheduleType === "INTERVAL"
        ? ({
            type: "INTERVAL" as const,
            intervalMinutes: form.intervalMinutes,
            timezone: form.timezone,
          } as const)
        : form.scheduleType === "DAILY"
          ? ({
              type: "DAILY" as const,
              timeOfDayMinutes: timeToMinutes(form.localTime),
              timezone: form.timezone,
            } as const)
          : ({
              type: "WEEKLY" as const,
              timeOfDayMinutes: timeToMinutes(form.localTime),
              dayOfWeek: form.dayOfWeek,
              timezone: form.timezone,
            } as const);
    const payload = {
      name: form.name,
      action: "CREATE_ISSUE" as const,
      prompt: form.prompt,
      issueTitle: form.issueTitle,
      issuePriority: form.issuePriority,
      deliveryType: form.deliveryType,
      projectId: form.deliveryType === "PROJECT" ? form.projectId || null : null,
      schedule,
    };
    if (task) await update.mutateAsync({ id: task.id, ...payload });
    else await create.mutateAsync(payload);
    onSaved();
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-h-[82vh] max-w-2xl overflow-y-auto">
      <form onSubmit={submit}>
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">
            {task ? "Edit scheduled task" : "New scheduled task"}
          </h2>
          <p className="text-meta mt-1 text-muted-foreground">
            Create a real Forge issue from this prompt on a recurring schedule.
          </p>
        </div>

        <div className="space-y-5 p-5">
          <section className="space-y-3">
            <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              Task
            </h3>
            <Field label="Name">
              <Input
                autoFocus
                aria-label="Task name"
                required
                maxLength={100}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Monday customer follow-up"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Action">
                <Combobox
                  value="CREATE_ISSUE"
                  onChange={() => {}}
                  options={[{ value: "CREATE_ISSUE", label: "Create issue" }]}
                  disabled
                  ariaLabel="Action"
                  className="h-9 w-full"
                  matchTriggerWidth
                />
              </Field>
              <Field label="Issue priority">
                <Combobox
                  value={form.issuePriority}
                  onChange={(value) =>
                    value &&
                    setForm({ ...form, issuePriority: value as FormState["issuePriority"] })
                  }
                  options={PRIORITIES.map((priority) => ({
                    value: priority,
                    label: priority.charAt(0) + priority.slice(1).toLowerCase(),
                  }))}
                  ariaLabel="Issue priority"
                  className="h-9 w-full"
                  matchTriggerWidth
                />
              </Field>
            </div>
            <Field label="Created issue title">
              <Input
                aria-label="Created issue title"
                required
                maxLength={300}
                value={form.issueTitle}
                onChange={(event) => setForm({ ...form, issueTitle: event.target.value })}
                placeholder="Prepare weekly customer summary"
              />
            </Field>
            <Field label="Prompt / issue description">
              <textarea
                aria-label="Prompt / issue description"
                required
                maxLength={50_000}
                rows={5}
                value={form.prompt}
                onChange={(event) => setForm({ ...form, prompt: event.target.value })}
                className="focus-ring w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                placeholder="Describe the recurring work, expected result, and relevant context."
              />
            </Field>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              Delivery
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Target type">
                <Combobox
                  value={form.deliveryType}
                  onChange={(value) =>
                    value && setForm({ ...form, deliveryType: value as "INBOX" | "PROJECT" })
                  }
                  options={[
                    { value: "INBOX", label: "Workspace inbox" },
                    { value: "PROJECT", label: "Project" },
                  ]}
                  ariaLabel="Delivery target type"
                  className="h-9 w-full"
                  matchTriggerWidth
                />
              </Field>
              {form.deliveryType === "PROJECT" && (
                <Field label="Project">
                  <Combobox
                    value={form.projectId || null}
                    onChange={(value) => setForm({ ...form, projectId: value ?? "" })}
                    options={(projects?.items ?? []).map((project) => ({
                      value: project.id,
                      label: project.name,
                      secondary: project.key,
                      color: project.color,
                    }))}
                    placeholder="Choose a project…"
                    searchable
                    ariaLabel="Delivery project"
                    className="h-9 w-full"
                    matchTriggerWidth
                  />
                </Field>
              )}
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              Schedule
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Repeats">
                <Combobox
                  value={form.scheduleType}
                  onChange={(value) =>
                    value && setForm({ ...form, scheduleType: value as FormState["scheduleType"] })
                  }
                  options={[
                    { value: "INTERVAL", label: "At an interval" },
                    { value: "DAILY", label: "Daily" },
                    { value: "WEEKLY", label: "Weekly" },
                  ]}
                  ariaLabel="Schedule frequency"
                  className="h-9 w-full"
                  matchTriggerWidth
                />
              </Field>
              <Field label="Timezone">
                <Combobox
                  value={form.timezone}
                  onChange={(value) => value && setForm({ ...form, timezone: value })}
                  options={timezoneOptions.map((timezone) => ({
                    value: timezone,
                    label: timezone,
                  }))}
                  searchable
                  ariaLabel="Schedule timezone"
                  className="h-9 w-full"
                  matchTriggerWidth
                />
              </Field>
            </div>
            {form.scheduleType === "INTERVAL" ? (
              <Field label="Every (minutes)">
                <Input
                  type="number"
                  aria-label="Interval in minutes"
                  min={5}
                  max={525_600}
                  required
                  value={form.intervalMinutes}
                  onChange={(event) =>
                    setForm({ ...form, intervalMinutes: Number(event.target.value) })
                  }
                />
              </Field>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {form.scheduleType === "WEEKLY" && (
                  <Field label="Weekday">
                    <Combobox
                      value={String(form.dayOfWeek)}
                      onChange={(value) =>
                        value !== null && setForm({ ...form, dayOfWeek: Number(value) })
                      }
                      options={WEEKDAYS.map((day, index) => ({
                        value: String(index),
                        label: day,
                      }))}
                      ariaLabel="Schedule weekday"
                      className="h-9 w-full"
                      matchTriggerWidth
                    />
                  </Field>
                )}
                <Field label="Local time">
                  <Input
                    type="time"
                    aria-label="Local run time"
                    required
                    value={form.localTime}
                    onChange={(event) => setForm({ ...form, localTime: event.target.value })}
                  />
                </Field>
              </div>
            )}
            <p className="text-meta text-muted-foreground">
              Daily and weekly schedules follow local wall-clock time through daylight-saving
              changes.
            </p>
          </section>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="ember" disabled={pending}>
            {pending && <Spinner size="sm" />}
            {task ? "Save changes" : "Create task"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
