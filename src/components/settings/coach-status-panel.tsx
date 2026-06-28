"use client";
import Link from "next/link";
import { AlertTriangle, Check, CheckCircle2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { formatIssueId, relativeTime } from "@/lib/utils";

/**
 * Coach health at a glance — sits under the Coach toggle in Settings →
 * Workspace → AI. Surfaces why the Coach is or isn't doing anything: provider
 * reachability, the Coach agent, which trigger events are active vs disabled,
 * and when it last fired. Read-only; the knobs are the controls around it.
 */
export function CoachStatusPanel() {
  const ws = useWorkspace();
  const { data: s } = trpc.ai.coachStatus.useQuery();
  if (!s) return null;

  const anyTrigger =
    s.triggers.stalled.enabled ||
    s.triggers.noack.enabled ||
    s.triggers.sla.enabled;
  const armed =
    s.enabled && s.provider.available && !!s.agent && anyTrigger;

  const headline = armed
    ? "Coach armed"
    : s.enabled
      ? "Coach needs attention"
      : "Coach off";

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/40 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {armed ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-300" />
          )}
          {headline}
        </div>
        {s.lastFired ? (
          <Link
            href={`/w/${ws.slug}/issues/${s.lastFired.issueId}`}
            className="text-meta text-muted-foreground hover:text-foreground"
          >
            last fired {formatIssueId(ws.key, s.lastFired.issueNumber)} ·{" "}
            {relativeTime(s.lastFired.at)}
          </Link>
        ) : (
          <span className="text-meta text-muted-foreground">never fired</span>
        )}
      </div>

      <ul className="space-y-1">
        <Line ok={s.enabled} label="AI + Coach enabled" fix="toggle above" />
        <Line
          ok={s.provider.available}
          label={`Provider — ${s.provider.label}${s.provider.available ? " reachable" : ""}`}
          fix={s.provider.reason ?? "not configured"}
        />
        <Line
          ok={!!s.agent}
          label={s.agent ? `Coach agent @${s.agent.profileKey}` : "No Coach agent"}
          fix="set up below"
        />
      </ul>

      <div>
        <div className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
          Triggers
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Trigger
            on={s.triggers.stalled.enabled}
            label={`stalled ${s.triggers.stalled.minutes}m`}
          />
          <Trigger
            on={s.triggers.noack.enabled}
            label={`no-ack ${s.triggers.noack.seconds}s`}
          />
          <Trigger on={s.triggers.sla.enabled} label="SLA breach" />
        </div>
        {!anyTrigger && (
          <p className="mt-1.5 text-meta text-amber-200/80">
            No triggers active — the Coach will never fire. Enable a stall, ack,
            or SLA window in the dispatch / SLA settings.
          </p>
        )}
      </div>
    </div>
  );
}

function Line({
  ok,
  label,
  fix,
}: {
  ok: boolean;
  label: string;
  fix?: string;
}) {
  return (
    <li className="flex items-center gap-2 text-meta">
      {ok ? (
        <Check className="h-3 w-3 shrink-0 text-success" />
      ) : (
        <X className="h-3 w-3 shrink-0 text-amber-300" />
      )}
      <span className={ok ? "text-muted-foreground" : "text-foreground"}>
        {label}
      </span>
      {!ok && fix && (
        <span className="text-muted-foreground/70">— {fix}</span>
      )}
    </li>
  );
}

function Trigger({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.6875rem] " +
        (on
          ? "border-success/30 bg-success/10 text-success"
          : "border-border bg-card/40 text-muted-foreground")
      }
    >
      {on ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}
