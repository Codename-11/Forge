"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  GitBranch,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react";
import {
  RUNTIME_TOOL_CAPABILITIES,
  runtimeHostToolPolicyEnforced,
  runtimeToolSurface,
  type RuntimeToolCapability,
} from "@/lib/runtime-tools";
import {
  primaryEnforcementLayer,
  type RuntimePolicySnapshot,
} from "@/lib/runtime-enforcement";
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

export type RuntimeConfigStatusLike = {
  ok: boolean;
  code: string;
  tone: "ok" | "warning" | "danger" | "muted";
  label: string;
  detail: string;
};

export function RuntimeConfigStatusBadge({
  status,
}: {
  status: RuntimeConfigStatusLike | null | undefined;
}) {
  if (!status || status.ok) return null;
  const Icon =
    status.tone === "danger" || status.tone === "warning"
      ? AlertTriangle
      : ShieldAlert;
  const toneClass =
    status.tone === "ok"
      ? "border-success/30 bg-success/10 text-success"
      : status.tone === "danger"
        ? "border-danger/30 bg-danger/10 text-danger"
        : status.tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border bg-subtle/40 text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
        toneClass,
      )}
      title={status.detail}
    >
      <Icon className="h-3 w-3" />
      {status.label}
    </span>
  );
}

export function RuntimeToolSurfaceBadges({
  adapterKey,
  config,
  configStatus,
  className,
}: {
  adapterKey: string | null | undefined;
  config: unknown;
  configStatus?: RuntimeConfigStatusLike | null;
  className?: string;
}) {
  const surface = runtimeToolSurface(adapterKey, config);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <RuntimeConfigStatusBadge status={configStatus} />
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
      <RuntimeConfigEnforcementBadge adapterKey={adapterKey} config={config} />
    </div>
  );
}

function RuntimeConfigEnforcementBadge({
  adapterKey,
  config,
}: {
  adapterKey: string | null | undefined;
  config: unknown;
}) {
  if (adapterKey === "hermes") {
    const enforced = runtimeHostToolPolicyEnforced(adapterKey, config);
    const Icon = enforced ? ShieldCheck : ShieldAlert;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
          enforced
            ? "border-success/30 bg-success/10 text-success"
            : "border-warning/30 bg-warning/10 text-warning",
        )}
        title={
          enforced
            ? "Hermes runtime is marked as host-enforcing per-run tool allowlists."
            : "Hermes runtime receives mode instructions, but host tool policy is prompt-only."
        }
      >
        <Icon className="h-3 w-3" />
        {enforced ? "host enforced" : "prompt only"}
      </span>
    );
  }
  if (runtimeHostToolPolicyEnforced(adapterKey, config)) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-success"
        title={
          adapterKey === "codex-app-server"
            ? "Codex app server receives Forge's per-turn sandbox policy; non-Execute runs are forced read-only."
            : "This runtime adapter is marked as host-enforcing Forge's runtime tool policy."
        }
      >
        <ShieldCheck className="h-3 w-3" />
        {adapterKey === "codex-app-server" ? "sandbox enforced" : "host enforced"}
      </span>
    );
  }
  return null;
}

export function RuntimePolicyBadges({
  policy,
  compact = false,
}: {
  policy: RuntimePolicySnapshot | null | undefined;
  compact?: boolean;
}) {
  if (!policy) return null;
  const primary = primaryEnforcementLayer(policy);
  const layers = compact && primary ? [primary] : policy.layers;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {layers.map((layer) => {
        const Icon = layer.enforced ? ShieldCheck : ShieldAlert;
        return (
          <span
            key={`${layer.kind}-${layer.label}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
              layer.enforced
                ? "border-success/30 bg-success/10 text-success"
                : "border-warning/30 bg-warning/10 text-warning",
            )}
            title={layer.detail}
          >
            <Icon className="h-3 w-3" />
              {layer.kind === "forge-mcp"
                ? "Forge MCP"
                : layer.kind === "codex-sandbox"
                  ? "Codex sandbox"
                  : layer.kind === "hermes-host"
                    ? "Hermes host"
                    : layer.kind === "host-tool-policy"
                      ? "Runtime host"
                      : "prompt only"}
          </span>
        );
      })}
      {policy.toolGrant && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-ember/30 bg-ember/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-ember"
          title={`One-time ${policy.toolGrant.accessLevel === "READ_ONLY" ? "read-only" : "full"} runtime tool grant${policy.toolGrant.scopePath ? ` for ${policy.toolGrant.scopePath}` : ""}`}
        >
          <ShieldCheck className="h-3 w-3" />
          one-time grant
        </span>
      )}
      {!compact && (
        <span
          className="truncate rounded-md border border-border bg-background/40 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
          title={`Run contract ${policy.contractVersion}`}
        >
          v {policy.contractVersion}
        </span>
      )}
    </div>
  );
}

export function RuntimeToolSurfacePanel({
  adapterKey,
  config,
  configStatus,
}: {
  adapterKey: string | null | undefined;
  config: unknown;
  configStatus?: RuntimeConfigStatusLike | null;
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
        <RuntimeToolSurfaceBadges
          adapterKey={adapterKey}
          config={config}
          configStatus={configStatus}
        />
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
