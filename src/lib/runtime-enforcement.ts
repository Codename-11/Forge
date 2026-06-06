import {
  runtimeHostEnforcesModeToolPolicy,
  runtimeModeToolCapabilities,
  runtimeToolSurface,
  type RuntimeEngagementMode,
  type RuntimeToolCapability,
} from "@/lib/runtime-tools";

export type RuntimeEnforcementKind =
  | "forge-mcp"
  | "codex-sandbox"
  | "hermes-host"
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
  layers: RuntimeEnforcementLayer[];
  generatedAt: string;
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
  generatedAt?: Date;
}): RuntimePolicySnapshot {
  const adapterKey = input.adapterKey ?? null;
  const surface = runtimeToolSurface(adapterKey, input.config);
  const mode = input.engagementMode;
  const allowedHostTools =
    adapterKey === "hermes"
      ? runtimeModeToolCapabilities(input.config, mode)
      : mode === "EXECUTE"
        ? surface.capabilities
        : [];

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
    const sandbox = codexSandboxMode(input.config, mode);
    layers.push({
      kind: "codex-sandbox",
      label: "Codex sandbox",
      enforced: sandbox !== "danger-full-access" || mode !== "EXECUTE",
      detail:
        mode === "EXECUTE"
          ? `Codex app server receives sandbox ${sandbox}.`
          : "Codex app server receives read-only sandbox for this mode.",
    });
  } else if (adapterKey === "hermes") {
    const enforced = runtimeHostEnforcesModeToolPolicy(input.config);
    layers.push({
      kind: enforced ? "hermes-host" : "prompt-only",
      label: enforced ? "Hermes host" : "Hermes host",
      enforced,
      detail: enforced
        ? `Hermes receives a per-run host tool allowlist: ${allowedHostTools.join(", ") || "none"}.`
        : "Hermes receives the mode contract, but this runtime is not marked as host-enforcing per-run tools.",
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
