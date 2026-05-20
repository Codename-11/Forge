"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Compact "what's the agent doing right now?" chip for the issue
 * detail topbar. Sized to live next to the AgentChip / Status /
 * Priority cluster — same border/density (`px-2 py-1`,
 * `text-[0.6875rem]`).
 *
 * Data:
 * - Reads `agentRun.activeForIssue` (already used by the full-width
 *   AgentRunStrip in the main column). The parent page also drives
 *   `issue.byId` on a 15s `refetchInterval`, so the chip stays fresh
 *   without an extra subscription here. We poll our own query on a
 *   matching interval as a belt-and-braces measure for routes where
 *   SSE is dropped (offline tab, etc).
 *
 * Visual rules:
 * - Hidden when no active run — the chip never claims real estate
 *   when there's nothing to say.
 * - Pulsing dot only when `lastEventAt < 60s` ago (the "live" window).
 *   Outside that, the dot stays still — distinguishes "right now" from
 *   "this run is just open".
 * - Step text is mono via `.text-id` because it's a stable identifier
 *   the agent emits (e.g. "running tests"); relative-time uses
 *   `.text-meta`.
 * - Click navigates to Mission Control where the operator can see the
 *   full timeline. We pass `?run=<id>` as a hint — the Mission Control
 *   shell already reads run ids from search params for deep-link to a
 *   specific row.
 */
export function RunActivityChip({ issueId }: { issueId: string }) {
  const router = useRouter();
  const workspace = useWorkspace();
  // Match the parent page's 15s refetch cadence. The query itself
  // is cheap (single row + agent join) so the cost is negligible.
  const { data: run } = trpc.agentRun.activeForIssue.useQuery(
    { issueId },
    { refetchInterval: 15_000, staleTime: 5_000 },
  );

  // Tick the "live" indicator + the relative-time label every 10s
  // without burning CPU on every-second rerenders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  if (!run) return null;

  const lastEventTs = new Date(run.lastEventAt).getTime();
  const ageMs = now - lastEventTs;
  const isLive = ageMs < 60_000;
  const ageLabel = ageMs < 60_000 ? "just now" : relativeTime(run.lastEventAt);
  const step = (run.currentStep ?? "").trim() || "working…";
  const controlLabel =
    run.controlState === "PAUSE_REQUESTED"
      ? "pause requested"
      : run.controlState === "CANCEL_REQUESTED"
        ? "cancel requested"
        : null;

  // Hover title: full step + run status, so even when the chip is
  // truncated the operator can read the whole thing.
  const fullTitle = [
    `${run.agent.name} · ${run.status}${controlLabel ? ` (${controlLabel})` : ""}`,
    run.currentStep ? `→ ${run.currentStep}` : null,
    `updated ${ageLabel}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      onClick={() => {
        // Mission Control reads optional `?run=<id>` to focus the
        // matching row. If it doesn't recognize the hint it still
        // lands the operator on the live view.
        router.push(
          `/w/${workspace.slug}/command-center?run=${encodeURIComponent(run.id)}`,
        );
      }}
      title={fullTitle}
      aria-label={`Agent activity: ${step}. Updated ${ageLabel}. Click to open Mission Control.`}
      className={cn(
        "focus-ring inline-flex max-w-[18rem] items-center gap-1.5 rounded-md border px-2 py-1 text-left",
        "border-ember/40 bg-ember/10 text-foreground/90 hover:bg-ember/15",
      )}
    >
      <span
        aria-hidden
        className="relative inline-flex h-1.5 w-1.5 shrink-0"
      >
        {isLive && (
          <span className="absolute inset-0 rounded-full bg-ember opacity-60 motion-safe:animate-ping" />
        )}
        <span
          className={cn(
            "relative inline-block h-1.5 w-1.5 rounded-full",
            isLive ? "bg-ember" : "bg-ember/60",
          )}
        />
      </span>
      <span className="text-id min-w-0 truncate">{step}</span>
      <span className="text-meta shrink-0 text-muted-foreground">
        · {ageLabel}
      </span>
    </button>
  );
}
