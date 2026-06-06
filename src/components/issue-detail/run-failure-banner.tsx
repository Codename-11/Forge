"use client";

import { AlertTriangle, ArrowRightCircle } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";

type TerminalRunFailureStatus = "STALLED" | "ABANDONED" | "ERROR" | "ERRORED" | "FAILED";

type BannerRun = {
  id: string;
  status: string;
  currentStep?: string | null;
  externalRunId?: string | null;
  lastEventAt: Date | string;
  finishedAt?: Date | string | null;
  agent?: {
    name?: string | null;
    profileKey?: string | null;
    provider?: string | null;
    runtime?: {
      name?: string | null;
      adapterKey?: string | null;
    } | null;
  } | null;
};

type BannerMetadata = { label: string; value: string };

export type TerminalRunFailureBannerModel = {
  title: string;
  description: string;
  recommendation: string;
  metadata: BannerMetadata[];
};

const TERMINAL_FAILED_RUN_STATUSES = new Set<string>([
  "STALLED",
  "ABANDONED",
  "ERROR",
  "ERRORED",
  "FAILED",
] satisfies TerminalRunFailureStatus[]);

export function isTerminalFailedRunStatus(status: string | null | undefined): boolean {
  return TERMINAL_FAILED_RUN_STATUSES.has(String(status ?? "").toUpperCase());
}

export function getTerminalRunFailureBanner(
  run: BannerRun | null | undefined,
): TerminalRunFailureBannerModel | null {
  if (!run || !isTerminalFailedRunStatus(run.status)) return null;

  const provider = normalizeLabel(run.agent?.provider) ?? "Agent";
  const providerLabel = provider === "CODEX" ? "Codex" : titleCase(provider);
  const agentName = run.agent?.name?.trim() || providerLabel;
  const agentHandle = run.agent?.profileKey?.trim();
  const runtimeParts = [run.agent?.runtime?.name, run.agent?.runtime?.adapterKey]
    .map((part) => part?.trim())
    .filter(Boolean) as string[];
  const runtimeLabel = runtimeParts.length ? runtimeParts.join(" · ") : providerLabel;
  const metadata: BannerMetadata[] = [
    { label: "Agent", value: agentHandle ? `${agentName} (@${agentHandle})` : agentName },
    { label: "Tool surface", value: runtimeLabel },
    { label: "Last signal", value: relativeTime(run.finishedAt ?? run.lastEventAt) },
    { label: "Run", value: run.externalRunId ? `${run.id} · ${run.externalRunId}` : run.id },
  ];

  const stalledWithoutRuntimeActivity =
    run.status === "STALLED" &&
    !run.externalRunId &&
    !/output|completed|finished/i.test(run.currentStep ?? "");

  return {
    title: `${agentName} run ${run.status === "STALLED" ? "stalled" : "failed"} before completing`,
    description: stalledWithoutRuntimeActivity
      ? `${agentName} did not report runtime activity for this run before the watchdog marked it stalled.`
      : `${agentName} ended this run with status ${run.status}${run.currentStep ? `: ${run.currentStep}` : "."}`,
    recommendation: `Wake or reassign once ${agentName}'s runtime/tool surface is healthy. Switching Execute/Review/Research will not add terminal, filesystem, or git tools.`,
    metadata,
  };
}

export function TerminalRunFailureBanner({
  run,
  className,
  activityHref,
}: {
  run: BannerRun | null | undefined;
  className?: string;
  activityHref?: string;
}) {
  const banner = getTerminalRunFailureBanner(run);
  if (!banner) return null;

  return (
    <div
      className={cn(
        "mb-3 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm shadow-sm",
        className,
      )}
    >
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="font-medium text-foreground">{banner.title}</div>
            <p className="text-meta mt-0.5 leading-relaxed text-muted-foreground">
              {banner.description}
            </p>
          </div>
          <dl className="grid gap-1.5 sm:grid-cols-2">
            {banner.metadata.map((item) => (
              <div key={item.label} className="min-w-0">
                <dt className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground/80">
                  {item.label}
                </dt>
                <dd className="text-id truncate text-foreground" title={item.value}>
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="text-meta flex flex-wrap items-center gap-2 text-muted-foreground">
            <ArrowRightCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{banner.recommendation}</span>
            {activityHref ? (
              <a
                className="focus-ring rounded-sm text-ember underline-offset-2 hover:underline"
                href={activityHref}
              >
                View activity
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function normalizeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
