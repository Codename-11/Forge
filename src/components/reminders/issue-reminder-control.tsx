"use client";
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

function localInput(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function IssueReminderControl({ issueId }: { issueId: string }) {
  const utils = trpc.useUtils();
  const reminder = trpc.reminder.forIssue.useQuery({ issueId }, { refetchInterval: 30_000 });
  const push = trpc.reminder.deliveryOptions.useQuery();
  const loadedVersion = useRef("");
  const [value, setValue] = useState("");
  const [browserPush, setBrowserPush] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState("UTC");
  useEffect(() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  useEffect(() => {
    if (!reminder.data) return;
    const version = `${reminder.data.id}:${reminder.data.updatedAt.getTime()}`;
    if (loadedVersion.current === version) return;
    loadedVersion.current = version;
    setValue(localInput(new Date(reminder.data.remindAt)));
    setBrowserPush(reminder.data.browserPush);
  }, [reminder.data]); // Preserve a draft when the same schedule is polled again.
  const invalidate = () =>
    Promise.all([
      utils.reminder.invalidate(),
      utils.notification.unreadCount.invalidate(),
      utils.notification.globalUnreadCount.invalidate(),
    ]);
  const save = trpc.reminder.set.useMutation({
    onSuccess: () => {
      void invalidate();
      setError(null);
      toast.success("Personal reminder saved.");
    },
    onError: (err) => setError(err.message),
  });
  const cancel = trpc.reminder.dismiss.useMutation({
    onSuccess: () => {
      void invalidate();
      setValue("");
      setError(null);
      toast.success("Reminder canceled.");
    },
    onError: (err) => setError(err.message),
  });
  function submit() {
    const at = new Date(value);
    if (
      !value ||
      Number.isNaN(at.getTime()) ||
      localInput(at) !== value ||
      at.getTime() <= Date.now()
    ) {
      setError(
        "Choose a valid future local time. Check the time if daylight saving changes that day.",
      );
      return;
    }
    save.mutate({ issueId, remindAt: at, timezone, browserPush });
  }
  return (
    <details className="group rounded-md border border-border bg-card/40">
      <summary className="focus-ring cursor-pointer list-none px-2 py-2 text-xs">
        <span className="flex items-center gap-2">
          <Bell className="h-3.5 w-3.5 text-muted-foreground" />
          {reminder.data ? "My reminder" : "Remind me"}
          <span className="ml-auto text-muted-foreground">{reminder.data ? "Edit" : "Add"}</span>
        </span>
        {reminder.data && (
          <span className="text-meta mt-1 block text-muted-foreground">
            {new Date(reminder.data.remindAt) <= new Date() ? "Due · " : ""}
            {new Date(reminder.data.remindAt).toLocaleString()}
          </span>
        )}
      </summary>
      <div className="space-y-3 border-t border-border p-3">
        <p className="text-meta text-muted-foreground">
          Only you receive this reminder. It does not change the due date or wake an agent.
        </p>
        <label className="block text-xs font-medium">
          Reminder time
          <input
            aria-label="Personal reminder time"
            type="datetime-local"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="focus-ring mt-1 block w-full min-w-0 rounded-md border border-input bg-background px-2 py-2 text-sm"
          />
        </label>
        <p className="text-meta text-muted-foreground">{timezone}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setValue(localInput(new Date(Date.now() + 60 * 60_000)))}
          >
            In 1 hour
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const date = new Date();
              date.setDate(date.getDate() + 1);
              date.setHours(9, 0, 0, 0);
              setValue(localInput(date));
            }}
          >
            Tomorrow at 9
          </Button>
        </div>
        <label className="text-meta flex items-start gap-2 text-muted-foreground">
          <input
            type="checkbox"
            checked={browserPush}
            disabled={!push.data?.browserPushAvailable && !browserPush}
            onChange={(event) => setBrowserPush(event.target.checked)}
            className="mt-0.5"
          />
          Also notify my subscribed browsers
        </label>
        {!push.data?.browserPushAvailable && (
          <p className="text-meta text-muted-foreground">
            Enable Forge alerts in a supported browser to add push delivery. Your reminder will
            appear in Forge either way.
          </p>
        )}
        {(error || reminder.error) && (
          <p role="alert" className="text-xs text-danger">
            {error ?? reminder.error?.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ember"
            size="sm"
            disabled={!value || save.isPending || cancel.isPending}
            onClick={submit}
          >
            Save reminder
          </Button>
          {reminder.data && (
            <Button
              variant="ghost"
              size="sm"
              disabled={cancel.isPending || save.isPending}
              onClick={() => cancel.mutate({ id: reminder.data!.id })}
            >
              Cancel reminder
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}
