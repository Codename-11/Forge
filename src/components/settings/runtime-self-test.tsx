"use client";

import Link from "next/link";
import { AlertTriangle, MessageSquare, RefreshCw, Settings2 } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";

export type RuntimeSelfTestView = {
  status: string;
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
  detail: string;
  lastRunAt: Date | string | null;
  durationMs: number | null;
  supported: boolean;
  expectation: string;
};

function toneClass(tone: RuntimeSelfTestView["tone"]) {
  return tone === "success"
    ? "border-success/30 bg-success/10 text-success"
    : tone === "danger"
      ? "border-danger/30 bg-danger/10 text-danger"
      : tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-border bg-subtle/40 text-muted-foreground";
}

function durationText(durationMs: number | null): string {
  if (durationMs === null) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function RuntimeSelfTestBadge({ selfTest }: { selfTest: RuntimeSelfTestView }) {
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
        toneClass(selfTest.tone),
      )}
      title={selfTest.detail}
    >
      {selfTest.label}
    </span>
  );
}

export function RuntimeSelfTestLine({
  selfTest,
  className,
}: {
  selfTest: RuntimeSelfTestView;
  className?: string;
}) {
  const duration = durationText(selfTest.durationMs);
  const when = selfTest.lastRunAt ? `${relativeTime(selfTest.lastRunAt)} ago` : null;
  const text = when
    ? `${selfTest.label} ${when}${duration ? ` · ${duration}` : ""}`
    : selfTest.detail;
  return (
    <span className={cn("min-w-0 truncate", className)} title={selfTest.detail}>
      {text}
    </span>
  );
}

type SelfTestIssue = {
  title: string;
  summary: string;
  steps: string[];
};

function issueForSelfTest(input: {
  selfTest: RuntimeSelfTestView;
  adapterKey?: string | null;
}): SelfTestIssue | null {
  const { selfTest, adapterKey } = input;
  if (selfTest.status !== "FAILED") return null;

  const detail = selfTest.detail.toLowerCase();
  const isCodex = adapterKey === "codex-app-server";

  if (
    detail.includes("runtime endpoint") ||
    detail.includes("bearer token") ||
    detail.includes("transport gate")
  ) {
    return {
      title: "Runtime endpoint rejected Forge",
      summary:
        "Forge could not authenticate to the app-server or bridge endpoint. This is the socket/bridge secret, not the Codex account login.",
      steps: [
        "Confirm the endpoint URL points at the running bridge or app server.",
        "Re-save the runtime secret if the bridge expects a Bearer token.",
        "Run the connection test, then run self-test again.",
      ],
    };
  }

  if (
    detail.includes("inside the runtime/provider") ||
    detail.includes("refresh token") ||
    detail.includes("codex cli") ||
    detail.includes("login") ||
    detail.includes("credential")
  ) {
    return {
      title: isCodex ? "Codex auth inside the runtime failed" : "Provider auth failed",
      summary: isCodex
        ? "Forge reached the Codex app server. The failing credential is the Codex auth on the host or bridge process, not Forge workspace auth."
        : "Forge reached the runtime, but the runtime/provider credentials failed when the turn started.",
      steps: isCodex
        ? [
            "Re-authenticate the Codex CLI/app-server account on the host or bridge process.",
            "Restart the bridge/app-server so it picks up the refreshed auth.",
            "Run self-test again from this page.",
          ]
        : [
            "Refresh the provider/runtime credential on the host running the runtime.",
            "Restart the runtime process if credentials are loaded at startup.",
            "Run self-test again from this page.",
          ],
    };
  }

  if (detail.includes("no endpoint")) {
    return {
      title: "Runtime endpoint is missing",
      summary: "Forge cannot start a self-test turn because this runtime has no endpoint.",
      steps: [
        "Edit the runtime and add the app-server or gateway URL.",
        "Use wss:// or https:// for public endpoints.",
        "Run the connection test before self-test.",
      ],
    };
  }

  if (detail.includes("requested approval")) {
    return {
      title: "Self-test asked for tools or approval",
      summary:
        "The diagnostic turn should answer without tools. A runtime policy, prompt, or adapter behavior is causing it to request approval.",
      steps: [
        "Check the runtime approval policy and sandbox defaults.",
        "Confirm the app-server is receiving the no-tool self-test instruction.",
        "Retry after clearing any stuck approval in the runtime host.",
      ],
    };
  }

  if (detail.includes("did not complete") || detail.includes("timed out")) {
    return {
      title: "Self-test timed out",
      summary: "Forge started the diagnostic turn, but the runtime did not complete it in time.",
      steps: [
        "Confirm the runtime process is still running and can stream events.",
        "Check the bridge/app-server logs for a stuck or crashed turn.",
        "Restart the runtime and run self-test again.",
      ],
    };
  }

  return {
    title: "Self-test failed",
    summary: "Forge could not complete a minimal diagnostic turn against this runtime.",
    steps: [
      "Read the detail below for the failing adapter message.",
      "Check endpoint, runtime secret, host credentials, and runtime logs.",
      "Use Fix in Chat to hand this diagnostic to an agent.",
    ],
  };
}

export function RuntimeSelfTestNotice({
  selfTest,
  adapterKey,
  fixHref,
  onEdit,
  onRunSelfTest,
  running,
}: {
  selfTest: RuntimeSelfTestView;
  adapterKey?: string | null;
  fixHref?: string;
  onEdit?: () => void;
  onRunSelfTest?: () => void;
  running?: boolean;
}) {
  const issue = issueForSelfTest({ selfTest, adapterKey });
  if (!issue) return null;
  const isCodex = adapterKey === "codex-app-server";

  return (
    <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-semibold text-foreground">{issue.title}</div>
            <RuntimeSelfTestBadge selfTest={selfTest} />
          </div>
          <p className="mt-1 text-meta leading-relaxed text-muted-foreground">
            {issue.summary}
          </p>
          {isCodex && (
            <div className="mt-2 rounded-md border border-ember/30 bg-ember/5 px-3 py-2 text-meta text-muted-foreground">
              <div className="font-medium text-foreground">Codex app-server auth boundary</div>
              <div className="mt-0.5">
                Forge workspace auth and the runtime secret only get Forge to the bridge.
                The test turn then uses Codex auth inside the app-server host or Docker
                container, typically the mounted <span className="font-mono">~/.codex/auth.json</span>.
                Re-authenticate Codex on that host, restart the bridge/container, then run
                self-test again.
              </div>
            </div>
          )}
          <div className="mt-3 grid gap-2 rounded-md border border-border/60 bg-background/45 p-2 text-meta sm:grid-cols-[0.8fr_1.2fr]">
            <div>
              <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                What to check
              </div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {issue.steps.map((step) => (
                  <li key={step} className="flex gap-1.5">
                    <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-danger/70" />
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                Self-test detail
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-foreground/85">
                {selfTest.detail}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {fixHref && (
              <Link
                href={fixHref}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-ember/40 bg-ember/10 px-2.5 py-1.5 text-[0.75rem] font-medium text-ember hover:bg-ember/15"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Fix in Chat
              </Link>
            )}
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[0.75rem] text-foreground/85 hover:border-ember/40 hover:text-foreground"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Edit runtime
              </button>
            )}
            {onRunSelfTest && (
              <button
                type="button"
                onClick={onRunSelfTest}
                disabled={running}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[0.75rem] text-foreground/85 hover:border-ember/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", running && "animate-spin")} />
                {running ? "Self-testing..." : "Run self-test"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
