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
