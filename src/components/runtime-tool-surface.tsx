"use client";

import { CheckCircle2, FolderOpen, GitBranch, Terminal, XCircle } from "lucide-react";
import {
  RUNTIME_TOOL_CAPABILITIES,
  runtimeToolSurface,
  type RuntimeToolCapability,
} from "@/lib/runtime-tools";
import { cn } from "@/lib/utils";

const TOOL_META: Record<RuntimeToolCapability, { label: string; icon: typeof Terminal }> = {
  terminal: { label: "terminal", icon: Terminal },
  filesystem: { label: "filesystem", icon: FolderOpen },
  git: { label: "git", icon: GitBranch },
};

function ToolChip({ tool }: { tool: RuntimeToolCapability }) {
  const meta = TOOL_META[tool];
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
      title={`Runtime declares ${meta.label} access`}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

export function RuntimeToolSurfaceBadges({
  adapterKey,
  config,
  className,
}: {
  adapterKey: string | null | undefined;
  config: unknown;
  className?: string;
}) {
  const surface = runtimeToolSurface(adapterKey, config);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
          surface.hasRepoTools
            ? "border-success/30 bg-success/10 text-success"
            : "border-warning/30 bg-warning/10 text-warning",
        )}
        title={
          surface.hasRepoTools
            ? "This runtime declares local repo tools."
            : "This runtime does not declare terminal/filesystem/git access."
        }
      >
        {surface.hasRepoTools ? (
          <CheckCircle2 className="h-3 w-3" />
        ) : (
          <XCircle className="h-3 w-3" />
        )}
        {surface.hasRepoTools ? "repo tools" : "no repo tools"}
      </span>
      {surface.capabilities.map((tool) => (
        <ToolChip key={tool} tool={tool} />
      ))}
      {surface.workspaceRoot && (
        <span
          className="max-w-full truncate rounded-md border border-border bg-background/40 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
          title={`Workspace root: ${surface.workspaceRoot}`}
        >
          cwd {surface.workspaceRoot}
        </span>
      )}
    </div>
  );
}

export function RuntimeToolSurfacePanel({
  adapterKey,
  config,
}: {
  adapterKey: string | null | undefined;
  config: unknown;
}) {
  const surface = runtimeToolSurface(adapterKey, config);
  const declared = new Set(surface.capabilities);
  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
            Local tool surface
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {surface.label}
          </div>
        </div>
        <RuntimeToolSurfaceBadges adapterKey={adapterKey} config={config} />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {RUNTIME_TOOL_CAPABILITIES.map((tool) => {
          const meta = TOOL_META[tool];
          const Icon = meta.icon;
          const enabled = declared.has(tool);
          return (
            <div
              key={tool}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-2 text-meta",
                enabled
                  ? "border-success/20 bg-success/5 text-foreground"
                  : "border-border bg-subtle/20 text-muted-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="font-medium">{meta.label}</span>
              <span className="ml-auto font-mono text-[0.625rem] uppercase tracking-wider">
                {enabled ? "declared" : "missing"}
              </span>
            </div>
          );
        })}
      </div>
      {surface.workspaceRoot && (
        <div className="mt-3 truncate text-meta text-muted-foreground">
          workspace root{" "}
          <span className="font-mono text-foreground/80">{surface.workspaceRoot}</span>
        </div>
      )}
    </div>
  );
}

