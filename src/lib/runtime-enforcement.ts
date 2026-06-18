import {
  RUNTIME_TOOL_CAPABILITIES,
  runtimeAllowedHostTools,
  runtimeHostToolPolicyEnforced,
  runtimeToolSurface,
  type RuntimeEngagementMode,
  type RuntimeToolCapability,
} from "@/lib/runtime-tools";

export type RuntimeEnforcementKind =
  | "forge-mcp"
  | "codex-sandbox"
  | "hermes-host"
  | "host-tool-policy"
  | "prompt-only";

export type RuntimeEnforcementLayer = {
  kind: RuntimeEnforcementKind;
  label: string;
  enforced: boolean;
  detail: string;
};

export type RuntimePolicySnapshot = {
  contractVersion: string;
  engagementMode: RuntimeEngagementMode;
  adapterKey: string | null;
  runtimeName?: string | null;
  capabilities: RuntimeToolCapability[];
  allowedHostTools: RuntimeToolCapability[];
  toolGrant?: {
    accessLevel: "READ_ONLY" | "FULL";
    scopePath?: string | null;
    approvedByUserId?: string | null;
    actionRequestId?: string | null;
    reason?: string | null;
  } | null;
  layers: RuntimeEnforcementLayer[];
  generatedAt: string;
};

export type RuntimePolicyToolGrantInput = {
  tools?: RuntimeToolCapability[];
  accessLevel: "READ_ONLY" | "FULL";
  scopePath?: string | null;
  approvedByUserId?: string | null;
  actionRequestId?: string | null;
  reason?: string | null;
};

function configRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function codexSandboxMode(config: unknown, mode: RuntimeEngagementMode): string {
  if (mode !== "EXECUTE") return "read-only";
  const value = configRecord(config).sandboxMode;
  return typeof value === "string" && value ? value : "danger-full-access";
}

export function buildRuntimePolicySnapshot(input: {
  contractVersion: string;
  engagementMode: RuntimeEngagementMode;
  adapterKey?: string | null;
  runtimeName?: string | null;
  config?: unknown;
  toolGrant?: RuntimePolicyToolGrantInput | null;
  generatedAt?: Date;
}): RuntimePolicySnapshot {
  const adapterKey = input.adapterKey ?? null;
  const surface = runtimeToolSurface(adapterKey, input.config);
  const mode = input.engagementMode;
  const grantTools = input.toolGrant?.tools?.length
    ? RUNTIME_TOOL_CAPABILITIES.filter((tool) => input.toolGrant?.tools?.includes(tool))
    : [];
  const allowedHostTools = grantTools.length
    ? grantTools
    : runtimeAllowedHostTools(adapterKey, input.config, mode);
  const toolGrant = input.toolGrant
    ? {
        accessLevel: input.toolGrant.accessLevel,
        scopePath: input.toolGrant.scopePath ?? null,
        approvedByUserId: input.toolGrant.approvedByUserId ?? null,
        actionRequestId: input.toolGrant.actionRequestId ?? null,
        reason: input.toolGrant.reason ?? null,
      }
    : null;

  const layers: RuntimeEnforcementLayer[] = [
    {
      kind: "forge-mcp",
      label: "Forge MCP",
      enforced: true,
      detail:
        mode === "EXECUTE"
          ? "Issue mutations are allowed by run mode."
          : "Forge rejects issue-state mutations from this non-Execute run.",
    },
  ];

  if (adapterKey === "codex-app-server") {
    const sandbox = toolGrant
      ? toolGrant.accessLevel === "FULL"
        ? "workspace-write"
        : "read-only"
      : codexSandboxMode(input.config, mode);
    const grantDetail = toolGrant
      ? ` One-time grant applies ${toolGrant.accessLevel === "READ_ONLY" ? "read-only" : "scoped write"} access${toolGrant.scopePath ? ` at ${toolGrant.scopePath}` : ""}.`
      : "";
    layers.push({
      kind: "codex-sandbox",
      label: "Codex sandbox",
      enforced: sandbox !== "danger-full-access" || mode !== "EXECUTE",
      detail:
        mode === "EXECUTE"
          ? `Codex app server receives sandbox ${sandbox}.${grantDetail}`
          : `Codex app server receives read-only sandbox for this mode.${grantDetail}`,
    });
  } else if (adapterKey === "hermes") {
    const enforced = runtimeHostToolPolicyEnforced(adapterKey, input.config) || !!toolGrant;
    layers.push({
      kind: enforced ? "hermes-host" : "prompt-only",
      label: enforced ? "Hermes host" : "Hermes host",
      enforced,
      detail: enforced
        ? `Hermes receives a per-run host tool allowlist: ${allowedHostTools.join(", ") || "none"}.`
        : "Hermes receives the mode contract, but this runtime is not marked as host-enforcing per-run tools.",
    });
  } else if (runtimeHostToolPolicyEnforced(adapterKey, input.config)) {
    layers.push({
      kind: "host-tool-policy",
      label: "Runtime host",
      enforced: true,
      detail: `Runtime host enforces the per-run tool policy: ${allowedHostTools.join(", ") || "none"}.`,
    });
  } else {
    layers.push({
      kind: "prompt-only",
      label: "Runtime host",
      enforced: false,
      detail: "No host-enforced runtime tool policy is declared for this adapter.",
    });
  }

  return {
    contractVersion: input.contractVersion,
    engagementMode: mode,
    adapterKey,
    runtimeName: input.runtimeName ?? null,
    capabilities: surface.capabilities,
    allowedHostTools,
    toolGrant,
    layers,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  };
}

export function primaryEnforcementLayer(
  snapshot: Pick<RuntimePolicySnapshot, "layers"> | null | undefined,
): RuntimeEnforcementLayer | null {
  if (!snapshot?.layers?.length) return null;
  return (
    snapshot.layers.find((layer) => layer.kind !== "forge-mcp") ??
    snapshot.layers.find((layer) => layer.enforced) ??
    snapshot.layers[0]
  );
}
