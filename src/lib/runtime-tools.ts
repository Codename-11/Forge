export const RUNTIME_TOOL_CAPABILITIES = ["terminal", "filesystem", "git"] as const;

export type RuntimeToolCapability = (typeof RUNTIME_TOOL_CAPABILITIES)[number];
export type RuntimeEngagementMode = "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS";
export type RuntimeToolGrantStrategy = "mode-profile" | "sandbox" | "none";

const RUNTIME_TOOL_SET = new Set<string>(RUNTIME_TOOL_CAPABILITIES);

function configRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function normalizeTool(value: string): string {
  return value.toLowerCase().replace(/[_\s]+/g, "-");
}

function addTool(
  tools: Set<RuntimeToolCapability>,
  value: unknown,
): void {
  if (typeof value !== "string") return;
  const normalized = normalizeTool(value);
  if (RUNTIME_TOOL_SET.has(normalized)) {
    tools.add(normalized as RuntimeToolCapability);
  }
}

export function runtimeWorkspaceRoot(config: unknown): string | null {
  const c = configRecord(config);
  return typeof c.workspaceRoot === "string" && c.workspaceRoot.trim()
    ? c.workspaceRoot.trim()
    : null;
}

export function runtimeDeclaresLocalWorkspaceTools(config: unknown): boolean {
  return configRecord(config).localWorkspaceTools === true;
}

export function declaredRuntimeToolCapabilities(config: unknown): RuntimeToolCapability[] {
  const c = configRecord(config);
  const tools = new Set<RuntimeToolCapability>();

  if (Array.isArray(c.toolCapabilities)) {
    for (const value of c.toolCapabilities) addTool(tools, value);
  }
  if (Array.isArray(c.tools)) {
    for (const value of c.tools) addTool(tools, value);
  }
  for (const key of RUNTIME_TOOL_CAPABILITIES) {
    if (c[key] === true) tools.add(key);
  }
  if (runtimeDeclaresLocalWorkspaceTools(config)) {
    for (const key of RUNTIME_TOOL_CAPABILITIES) tools.add(key);
  }

  return RUNTIME_TOOL_CAPABILITIES.filter((key) => tools.has(key));
}

export function runtimeHasDeclaredRepoTools(config: unknown): boolean {
  const c = configRecord(config);
  const raw = [
    ...(Array.isArray(c.toolCapabilities) ? c.toolCapabilities : []),
    ...(Array.isArray(c.tools) ? c.tools : []),
    ...(runtimeDeclaresLocalWorkspaceTools(config) ? ["local-workspace"] : []),
    ...RUNTIME_TOOL_CAPABILITIES.filter((key) => c[key] === true),
  ];
  const normalized = new Set(
    raw
      .filter((value): value is string => typeof value === "string")
      .map(normalizeTool),
  );
  return (
    normalized.has("local-workspace") ||
    normalized.has("local-repo") ||
    normalized.has("repo") ||
    normalized.has("terminal") ||
    normalized.has("filesystem") ||
    normalized.has("file-system") ||
    normalized.has("git")
  );
}

export function runtimeHostEnforcesModeToolPolicy(config: unknown): boolean {
  const c = configRecord(config);
  return c.modeToolPolicyEnforced === true || c.hostEnforcedToolPolicy === true;
}

// Default tools a Research/Review run gets when the operator hasn't set an
// explicit `modeToolProfiles` override: read/inspect-oriented capabilities
// only. `terminal` is excluded even when declared — arbitrary command
// execution isn't "read-only" per the documented mode contract
// (docs/agents/engagement-modes.md: Research = "Read, search, run read-only
// tools").
const READ_ORIENTED_CAPABILITIES: readonly RuntimeToolCapability[] = ["filesystem", "git"];

export function runtimeModeToolCapabilities(
  config: unknown,
  mode: RuntimeEngagementMode,
): RuntimeToolCapability[] {
  const c = configRecord(config);
  const profiles =
    c.modeToolProfiles && typeof c.modeToolProfiles === "object" && !Array.isArray(c.modeToolProfiles)
      ? (c.modeToolProfiles as Record<string, unknown>)
      : null;
  const explicit = profiles?.[mode];
  if (Array.isArray(explicit)) {
    const tools = new Set<RuntimeToolCapability>();
    for (const value of explicit) addTool(tools, value);
    return RUNTIME_TOOL_CAPABILITIES.filter((tool) => tools.has(tool));
  }

  const declared = declaredRuntimeToolCapabilities(config);
  if (mode === "EXECUTE") return declared;
  if (mode === "DISCUSS") return [];
  // RESEARCH / REVIEW: never grant more than the runtime actually declared,
  // and never terminal — just the read-oriented subset of what's available.
  return declared.filter((tool) => READ_ORIENTED_CAPABILITIES.includes(tool));
}

export function runtimeToolGrantStrategy(
  adapterKey: string | null | undefined,
): RuntimeToolGrantStrategy {
  if (adapterKey === "hermes") return "mode-profile";
  if (adapterKey === "codex-app-server") return "sandbox";
  return "none";
}

export function runtimeSupportsRuntimeToolGrants(
  adapterKey: string | null | undefined,
): boolean {
  return runtimeToolGrantStrategy(adapterKey) !== "none";
}

export function runtimeHostToolPolicyEnforced(
  adapterKey: string | null | undefined,
  config: unknown,
): boolean {
  if (adapterKey === "codex-app-server") return true;
  if (adapterKey === "local-daemon") return true;
  if (adapterKey === "hermes") return runtimeHostEnforcesModeToolPolicy(config);
  return false;
}

export function runtimeAllowedHostTools(
  adapterKey: string | null | undefined,
  config: unknown,
  mode: RuntimeEngagementMode,
): RuntimeToolCapability[] {
  if (adapterKey === "hermes") {
    return runtimeModeToolCapabilities(config, mode);
  }

  const surface = runtimeToolSurface(adapterKey, config);
  if (mode === "EXECUTE") return surface.capabilities;
  if (adapterKey === "codex-app-server" || adapterKey === "local-daemon") {
    return surface.capabilities;
  }
  return [];
}

export function runtimeToolSurface(
  adapterKey: string | null | undefined,
  config: unknown,
): {
  capabilities: RuntimeToolCapability[];
  hasRepoTools: boolean;
  localWorkspaceTools: boolean;
  workspaceRoot: string | null;
  label: string;
} {
  const workspaceRoot = runtimeWorkspaceRoot(config);
  const localWorkspaceTools =
    runtimeDeclaresLocalWorkspaceTools(config) ||
    adapterKey === "local-daemon" ||
    (adapterKey === "codex-app-server" && !!workspaceRoot);
  const explicit = declaredRuntimeToolCapabilities(config);
  const capabilities = localWorkspaceTools
    ? [...RUNTIME_TOOL_CAPABILITIES]
    : explicit;
  const hasRepoTools =
    localWorkspaceTools ||
    runtimeHasDeclaredRepoTools(config) ||
    adapterKey === "local-daemon" ||
    (adapterKey === "codex-app-server" && !!workspaceRoot);

  return {
    capabilities,
    hasRepoTools,
    localWorkspaceTools,
    workspaceRoot,
    label: hasRepoTools ? "repo tools declared" : "repo tools not declared",
  };
}
