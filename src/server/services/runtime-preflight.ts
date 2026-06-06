import "server-only";
import type { AgentProvider, RuntimeKind } from "@prisma/client";
import { getRuntimeAdapter } from "@/server/runtimes/adapters";

export type RuntimePreflightSeverity = "info" | "warning";

export type RuntimePreflight = {
  severity: RuntimePreflightSeverity;
  title: string;
  description: string;
  recommendation: string;
  agentLabel: string;
  runtimeLabel: string;
  dispatchSurface: string;
  requiredSurface: string;
};

type RuntimeRef = {
  name: string | null;
  kind?: RuntimeKind | null;
  adapterKey: string | null;
  config?: unknown;
} | null;

type AgentRef = {
  name: string;
  profileKey: string;
  provider: AgentProvider;
  webhookUrl?: string | null;
  runtimeId?: string | null;
  runtime?: RuntimeRef;
} | null;

const CODE_WORK_HINTS = [
  "code",
  "repo",
  "repository",
  "terminal",
  "filesystem",
  "file system",
  "git",
  "patch",
  "commit",
  "push",
  "deploy",
  "test",
  "typecheck",
  "lint",
  "bug",
  "fix",
  "implement",
  "regression",
  "prisma",
  "database",
  "migration",
  "next.js",
  "typescript",
];

function configRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function declaredTools(config: unknown): Set<string> {
  const raw = configRecord(config);
  const values = [
    ...(Array.isArray(raw.toolCapabilities) ? raw.toolCapabilities : []),
    ...(Array.isArray(raw.tools) ? raw.tools : []),
    ...(raw.localWorkspaceTools === true ? ["local-workspace"] : []),
    ...(raw.terminal === true ? ["terminal"] : []),
    ...(raw.filesystem === true ? ["filesystem"] : []),
    ...(raw.git === true ? ["git"] : []),
  ];
  return new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase().replace(/[_\s]+/g, "-")),
  );
}

function hasDeclaredRepoTools(runtime: RuntimeRef): boolean {
  const tools = declaredTools(runtime?.config);
  return (
    tools.has("local-workspace") ||
    tools.has("local-repo") ||
    tools.has("repo") ||
    tools.has("terminal") ||
    tools.has("filesystem") ||
    tools.has("file-system") ||
    tools.has("git")
  );
}

function runtimeHasRepoTools(runtime: RuntimeRef): boolean {
  const adapterKey = runtime?.adapterKey ?? null;
  if (hasDeclaredRepoTools(runtime)) return true;
  if (adapterKey === "local-daemon") return true;
  if (adapterKey === "codex-app-server") {
    const cfg = configRecord(runtime?.config);
    return typeof cfg.workspaceRoot === "string" && cfg.workspaceRoot.trim().length > 0;
  }
  return false;
}

function issueNeedsRepoTools(input: {
  title: string;
  description: string | null;
  labels: string[];
}): boolean {
  const haystack = [input.title, input.description ?? "", ...input.labels].join(" ").toLowerCase();
  return CODE_WORK_HINTS.some((hint) => haystack.includes(hint));
}

function providerLabel(provider: AgentProvider): string {
  return provider
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function runtimeLabel(agent: AgentRef): string {
  if (!agent) return "No agent assigned";
  const adapter = getRuntimeAdapter(agent.runtime?.adapterKey);
  if (agent.runtime) {
    return agent.runtime.name || adapter?.title || agent.runtime.adapterKey || "Attached runtime";
  }
  if (agent.webhookUrl) return "Legacy webhook receiver";
  return "No runtime attached";
}

function dispatchSurface(agent: AgentRef): string {
  if (!agent) return "No dispatch target";
  const adapter = getRuntimeAdapter(agent.runtime?.adapterKey);
  if (adapter) return `${adapter.title} ${adapter.transport}`;
  if (agent.runtime?.adapterKey) return `${agent.runtime.adapterKey} runtime`;
  if (agent.webhookUrl) return "Webhook override";
  return `${providerLabel(agent.provider)} without runtime`;
}

export function runtimePreflightForIssue(input: {
  title: string;
  description: string | null;
  labels: string[];
  assignedAgent: AgentRef;
}): RuntimePreflight | null {
  if (!input.assignedAgent) return null;
  if (!issueNeedsRepoTools(input)) return null;
  if (runtimeHasRepoTools(input.assignedAgent.runtime ?? null)) return null;

  const agentName = input.assignedAgent.name || input.assignedAgent.profileKey;
  const runtime = runtimeLabel(input.assignedAgent);
  return {
    severity: "warning",
    title: "Runtime tool surface may not match this issue",
    description:
      `${agentName} is assigned through ${runtime}, but this issue looks like code/repo work and ` +
      "the runtime does not declare terminal, filesystem, or git access.",
    recommendation:
      `Use Wake/Kick only after ${runtime} is configured with the needed tools, or reassign ` +
      `${agentName} to a runtime that declares local repo tools. Execute mode changes the work contract, not the runtime tool surface.`,
    agentLabel: `${agentName} (@${input.assignedAgent.profileKey})`,
    runtimeLabel: runtime,
    dispatchSurface: dispatchSurface(input.assignedAgent),
    requiredSurface: "terminal · filesystem · git",
  };
}
