"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Play, Square, Clock, X, DollarSign } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { useHotkey } from "@/lib/keyboard";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { broadcastCrossTab, useCrossTab } from "@/hooks/use-realtime";
import { MOTION } from "@/lib/motion";

/**
 * Floating pill time tracker. Hidden when `workspace.timeTrackingEnabled`
 * is false.
 *
 * States:
 *   Idle    — pill with "Start tracking" + optional issue picker.
 *   Running — elapsed timer ticks client-side, stop button, billable toggle.
 *   Just-stopped toast advertises the duration.
 *
 * Keyboard: `t` toggles the widget open/closed; `shift+t` starts/stops
 * when on an issue detail (captures the current issue id from the path).
 */
export function TimeTrackerWidget() {
  const workspace = useMaybeWorkspace();
  const pathname = usePathname() ?? "";
  const enabled = workspace?.timeTrackingEnabled ?? false;

  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [billable, setBillable] = useState(false);
  const [issueId, setIssueId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const { data: running, refetch: refetchRunning } = trpc.timeEntry.running.useQuery(
    undefined,
    { enabled, refetchOnWindowFocus: true },
  );

  const { data: recentIssues } = trpc.issue.list.useQuery(
    { includeDone: false, limit: 20 },
    { enabled: enabled && open && !running },
  );

  const utils = trpc.useUtils();
  const start = trpc.timeEntry.start.useMutation({
    onSuccess: () => {
      setDescription("");
      setIssueId(null);
      refetchRunning();
      utils.timeEntry.list.invalidate();
      broadcastCrossTab({ type: "timer:started" });
    },
    onError: (e) => toast.error(e.message),
  });
  const stop = trpc.timeEntry.stop.useMutation({
    onSuccess: (entry) => {
      const minutes = entry.endedAt
        ? Math.max(
            0,
            Math.round(
              (entry.endedAt.getTime() - entry.startedAt.getTime()) / 60_000,
            ),
          )
        : 0;
      toast.success(`Stopped · ${formatMinutes(minutes)}`);
      refetchRunning();
      utils.timeEntry.list.invalidate();
      broadcastCrossTab({ type: "timer:stopped" });
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.timeEntry.update.useMutation({
    onSuccess: () => {
      refetchRunning();
      broadcastCrossTab({ type: "timer:updated" });
    },
    onError: (e) => toast.error(e.message),
  });

  // Sibling tab started/stopped a timer — we mirror the change by
  // re-fetching the running entry.
  useCrossTab((msg) => {
    if (
      msg.type === "timer:started" ||
      msg.type === "timer:stopped" ||
      msg.type === "timer:updated"
    ) {
      refetchRunning();
      void utils.timeEntry.list.invalidate();
    }
  });

  // Tick once per second while running so the elapsed label updates live.
  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(iv);
  }, [running]);

  const elapsedLabel = useMemo(() => {
    if (!running) return "";
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(running.startedAt).getTime()) / 1000),
    );
    // tick is referenced here to keep the memo re-evaluating every second.
    void tick;
    return formatElapsed(seconds);
  }, [running, tick]);

  // Current issue id parsed from the URL, if on an issue detail page.
  const currentIssueIdRef = useRef<string | null>(null);
  useEffect(() => {
    const m = pathname.match(/\/issues\/([a-z0-9]+)(?:$|[/?])/i);
    currentIssueIdRef.current = m ? m[1] : null;
  }, [pathname]);

  useHotkey(
    "t",
    () => {
      if (!enabled) return;
      setOpen((v) => !v);
    },
    [enabled],
  );
  useHotkey(
    "shift+t",
    () => {
      if (!enabled) return;
      if (running) {
        stop.mutate({ entryId: running.id });
      } else {
        const id = currentIssueIdRef.current ?? undefined;
        start.mutate({ issueId: id, description: description || undefined, billable });
      }
    },
    [enabled, running, start, stop, billable, description],
  );

  if (!enabled) return null;

  return (
    <div className={cn("fixed bottom-4 right-4 z-40", MOTION.slideUp)}>
      {running ? (
        <div className="flex items-center gap-2 rounded-full border border-border bg-card/95 px-2 py-1.5 shadow-lg backdrop-blur">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-ember/10 text-ember">
            <Clock className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-id leading-tight">{elapsedLabel}</div>
            <div className="max-w-[200px] truncate text-meta text-muted-foreground">
              {running.issue ? running.issue.title : running.description || "Tracking…"}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              update.mutate({ entryId: running.id, billable: !running.billable })
            }
            className={cn(
              "focus-ring grid h-6 w-6 place-items-center rounded-full border text-[10px]",
              running.billable
                ? "border-success/60 bg-success/10 text-success"
                : "border-border text-muted-foreground hover:bg-subtle",
            )}
            title={running.billable ? "Billable · click to unmark" : "Mark billable"}
          >
            <DollarSign className="h-3 w-3" />
          </button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="h-6 rounded-full px-2 text-[11px]"
            onClick={() => stop.mutate({ entryId: running.id })}
            disabled={stop.isPending}
          >
            <Square className="h-3 w-3" /> Stop
          </Button>
        </div>
      ) : open ? (
        <div className="w-80 rounded-lg border border-border bg-card shadow-lg">
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold">Start tracking</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto grid h-5 w-5 place-items-center rounded hover:bg-subtle"
              title="Close (t)"
            >
              <X className="h-3 w-3" />
            </button>
          </header>
          <div className="space-y-2 p-3 text-[12px]">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                Issue (optional)
              </span>
              <select
                value={issueId ?? ""}
                onChange={(e) => setIssueId(e.target.value || null)}
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1"
              >
                <option value="">— none —</option>
                {(recentIssues?.items ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {workspace ? formatIssueId(workspace.key, i.number) : `#${i.number}`}
                    {" — "}
                    {i.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                Description
              </span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What are you working on?"
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={billable}
                onChange={(e) => setBillable(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Billable
            </label>
            <Button
              type="button"
              variant="ember"
              size="sm"
              className="w-full"
              disabled={start.isPending}
              onClick={() =>
                start.mutate({
                  issueId: issueId ?? undefined,
                  description: description || undefined,
                  billable,
                })
              }
            >
              <Play className="h-3 w-3" /> Start
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 py-1.5 text-[11px] shadow-lg backdrop-blur hover:bg-subtle"
          title="Start tracking (t)"
        >
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Start tracking</span>
          <span className="kbd !px-1 !text-[9px]">T</span>
        </button>
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}
