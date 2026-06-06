"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type RuntimePreflight = {
  severity: "info" | "warning";
  title: string;
  description: string;
  recommendation: string;
  agentLabel: string;
  runtimeLabel: string;
  dispatchSurface: string;
  requiredSurface: string;
} | null;

export function RuntimePreflightBanner({
  preflight,
  className,
}: {
  preflight: RuntimePreflight;
  className?: string;
}) {
  if (!preflight) return null;
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
            <div className="font-medium text-foreground">{preflight.title}</div>
            <p className="text-meta mt-0.5 leading-relaxed text-muted-foreground">
              {preflight.description}
            </p>
          </div>
          <dl className="grid gap-1.5 sm:grid-cols-2">
            <PreflightMeta label="Agent" value={preflight.agentLabel} />
            <PreflightMeta label="Runtime" value={preflight.runtimeLabel} />
            <PreflightMeta label="Dispatch" value={preflight.dispatchSurface} />
            <PreflightMeta label="Needs" value={preflight.requiredSurface} />
          </dl>
          <p className="text-meta leading-relaxed text-muted-foreground">
            {preflight.recommendation}
          </p>
        </div>
      </div>
    </div>
  );
}

function PreflightMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground/80">
        {label}
      </dt>
      <dd className="text-id truncate text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}
