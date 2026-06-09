import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentRunStatus } from "@prisma/client";
import {
  runtimeHostEnforcesModeToolPolicy,
  runtimeToolSurface,
  type RuntimeToolCapability,
} from "@/lib/runtime-tools";
import { STALE_RUN_MS } from "@/server/services/agent-presence";
import { runtimeConfigStatus } from "@/server/services/runtime-config";
import { deriveRuntimeHealthStatus } from "@/server/services/runtime-status";
import { listRunRecoveryItems } from "@/server/services/agent-run-recovery";

type RuntimeComplianceTone = "ok" | "warning" | "danger" | "muted";

type RuntimeRow = Prisma.RuntimeGetPayload<{
  select: {
    id: true;
    name: true;
    kind: true;
    adapterKey: true;
    endpoint: true;
    config: true;
    archivedAt: true;
    disabledAt: true;
    heartbeatAt: true;
    connectedAt: true;
    lastProbeAt: true;
    lastProbeAttempted: true;
    lastProbeReachable: true;
    lastProbeDetail: true;
  };
}>;

export type RuntimeComplianceSignal = {
  code: string;
  tone: RuntimeComplianceTone;
  label: string;
  detail: string;
};

export type AgentRuntimeCompliance = {
  agentId: string;
  profileKey: string;
  agentName: string;
  runtimeId: string | null;
  runtimeName: string | null;
  adapterKey: string | null;
  tools: RuntimeToolCapability[];
  hasRepoTools: boolean;
  workspaceRoot: string | null;
  hostToolPolicyEnforced: boolean;
  activeRuns: number;
  staleRuns: number;
  terminalFailures: number;
  protocolFailures: number;
  tone: RuntimeComplianceTone;
  signals: RuntimeComplianceSignal[];
};

export type RuntimeComplianceCard = {
  runtimeId: string;
  runtimeName: string;
  adapterKey: string | null;
  tools: RuntimeToolCapability[];
  hasRepoTools: boolean;
  workspaceRoot: string | null;
  hostToolPolicyEnforced: boolean;
  boundAgents: number;
  activeRuns: number;
  recoveryItems: number;
  health: ReturnType<typeof deriveRuntimeHealthStatus>;
  tone: RuntimeComplianceTone;
  signals: RuntimeComplianceSignal[];
};

function toneRank(tone: RuntimeComplianceTone): number {
  if (tone === "danger") return 3;
  if (tone === "warning") return 2;
  if (tone === "ok") return 1;
  return 0;
}

function worstTone(signals: RuntimeComplianceSignal[]): RuntimeComplianceTone {
  return signals.reduce<RuntimeComplianceTone>(
    (worst, signal) => (toneRank(signal.tone) > toneRank(worst) ? signal.tone : worst),
    signals.length ? "ok" : "muted",
  );
}

function runtimeHostEnforced(adapterKey: string | null, config: unknown): boolean {
  if (adapterKey === "codex-app-server") return true;
  if (adapterKey === "local-daemon") return true;
  if (adapterKey === "hermes") return runtimeHostEnforcesModeToolPolicy(config);
  return false;
}

function runtimeSignals(runtime: RuntimeRow | null): RuntimeComplianceSignal[] {
  if (!runtime) {
    return [
      {
        code: "no-runtime",
        tone: "warning",
        label: "No runtime",
        detail: "Agent is not attached to a managed runtime.",
      },
    ];
  }

  const health = deriveRuntimeHealthStatus(runtime);
  const surface = runtimeToolSurface(runtime.adapterKey, runtime.config);
  const configStatus = runtimeConfigStatus(runtime.adapterKey, runtime.config);
  const signals: RuntimeComplianceSignal[] = [];
  if (!configStatus.ok && configStatus.tone !== "muted") {
    signals.push({
      code: configStatus.code,
      tone: configStatus.tone,
      label: configStatus.label,
      detail: configStatus.detail,
    });
  }
  if (health.tone === "danger") {
    signals.push({
      code: `runtime-${health.kind}`,
      tone: "danger",
      label: health.label,
      detail: health.reason,
    });
  } else if (health.tone === "warning") {
    signals.push({
      code: `runtime-${health.kind}`,
      tone: "warning",
      label: health.label,
      detail: health.reason,
    });
  }
  if (!surface.hasRepoTools) {
    signals.push({
      code: "no-repo-tools",
      tone: "warning",
      label: "No repo tools",
      detail: "Runtime does not declare terminal, filesystem, or git access.",
    });
  }
  if (runtime.adapterKey === "hermes" && !runtimeHostEnforcesModeToolPolicy(runtime.config)) {
    signals.push({
      code: "prompt-only-tools",
      tone: "warning",
      label: "Prompt-only tools",
      detail: "Hermes is not marked as host-enforcing per-run tool allowlists.",
    });
  }
  return signals;
}

export async function runtimeComplianceScorecard(
  db: PrismaClient,
  input: { workspaceId: string },
): Promise<{
  agents: AgentRuntimeCompliance[];
  runtimes: RuntimeComplianceCard[];
  counts: {
    agents: number;
    runtimes: number;
    warnings: number;
    danger: number;
    staleRuns: number;
    terminalFailures: number;
    protocolFailures: number;
  };
}> {
  const [agents, activeRuns, recovery] = await Promise.all([
    db.agent.findMany({
      where: { workspaceId: input.workspaceId, archivedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        profileKey: true,
        runtime: {
          select: {
            id: true,
            name: true,
            kind: true,
            adapterKey: true,
            endpoint: true,
            config: true,
            archivedAt: true,
            disabledAt: true,
            heartbeatAt: true,
            connectedAt: true,
            lastProbeAt: true,
            lastProbeAttempted: true,
            lastProbeReachable: true,
            lastProbeDetail: true,
          },
        },
      },
    }),
    db.agentRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      },
      select: { agentId: true, lastEventAt: true },
    }),
    listRunRecoveryItems(db, { workspaceId: input.workspaceId, limit: 100 }),
  ]);

  const activeByAgent = new Map<string, number>();
  const staleByAgent = new Map<string, number>();
  const runCutoff = new Date(Date.now() - STALE_RUN_MS);
  for (const run of activeRuns) {
    activeByAgent.set(run.agentId, (activeByAgent.get(run.agentId) ?? 0) + 1);
    if (run.lastEventAt < runCutoff) {
      staleByAgent.set(run.agentId, (staleByAgent.get(run.agentId) ?? 0) + 1);
    }
  }
  const terminalFailuresByAgent = new Map<string, number>();
  const protocolFailuresByAgent = new Map<string, number>();
  const recoveryByRuntime = new Map<string, number>();
  for (const item of recovery.items) {
    if (item.reason === "terminal-failure") {
      terminalFailuresByAgent.set(
        item.run.agentId,
        (terminalFailuresByAgent.get(item.run.agentId) ?? 0) + 1,
      );
    }
    if (item.reason === "protocol-failed") {
      protocolFailuresByAgent.set(
        item.run.agentId,
        (protocolFailuresByAgent.get(item.run.agentId) ?? 0) + 1,
      );
    }
    const runtimeId = item.run.agent.runtime?.id;
    if (runtimeId) recoveryByRuntime.set(runtimeId, (recoveryByRuntime.get(runtimeId) ?? 0) + 1);
  }

  const cards = agents.map((agent) => {
    const runtime = agent.runtime;
    const surface = runtimeToolSurface(runtime?.adapterKey ?? null, runtime?.config);
    const signals = runtimeSignals(runtime);
    const staleRuns = staleByAgent.get(agent.id) ?? 0;
    const terminalFailures = terminalFailuresByAgent.get(agent.id) ?? 0;
    const protocolFailures = protocolFailuresByAgent.get(agent.id) ?? 0;
    if (staleRuns > 0) {
      signals.push({
        code: "stale-runs",
        tone: "warning",
        label: `${staleRuns} stale`,
        detail: "One or more active runs have not emitted recent events.",
      });
    }
    if (terminalFailures > 0) {
      signals.push({
        code: "terminal-failures",
        tone: "danger",
        label: `${terminalFailures} failed`,
        detail: "One or more stalled/abandoned runs are still uncleared.",
      });
    }
    if (protocolFailures > 0) {
      signals.push({
        code: "protocol-failures",
        tone: "danger",
        label: `${protocolFailures} protocol`,
        detail: "One or more completed runs failed the completion contract.",
      });
    }
    return {
      agentId: agent.id,
      profileKey: agent.profileKey,
      agentName: agent.name,
      runtimeId: runtime?.id ?? null,
      runtimeName: runtime?.name ?? null,
      adapterKey: runtime?.adapterKey ?? null,
      tools: surface.capabilities,
      hasRepoTools: surface.hasRepoTools,
      workspaceRoot: surface.workspaceRoot,
      hostToolPolicyEnforced: runtimeHostEnforced(runtime?.adapterKey ?? null, runtime?.config),
      activeRuns: activeByAgent.get(agent.id) ?? 0,
      staleRuns,
      terminalFailures,
      protocolFailures,
      tone: worstTone(signals),
      signals,
    };
  });

  const runtimeMap = new Map<string, RuntimeComplianceCard>();
  for (const agent of agents) {
    const runtime = agent.runtime;
    if (!runtime) continue;
    const existing = runtimeMap.get(runtime.id);
    if (existing) {
      existing.boundAgents += 1;
      existing.activeRuns += activeByAgent.get(agent.id) ?? 0;
      continue;
    }
    const surface = runtimeToolSurface(runtime.adapterKey, runtime.config);
    const signals = runtimeSignals(runtime);
    const recoveryItems = recoveryByRuntime.get(runtime.id) ?? 0;
    if (recoveryItems > 0) {
      signals.push({
        code: "recovery-items",
        tone: "warning",
        label: `${recoveryItems} recovery`,
        detail: "Runs on this runtime need operator cleanup or reconciliation.",
      });
    }
    runtimeMap.set(runtime.id, {
      runtimeId: runtime.id,
      runtimeName: runtime.name,
      adapterKey: runtime.adapterKey,
      tools: surface.capabilities,
      hasRepoTools: surface.hasRepoTools,
      workspaceRoot: surface.workspaceRoot,
      hostToolPolicyEnforced: runtimeHostEnforced(runtime.adapterKey, runtime.config),
      boundAgents: 1,
      activeRuns: activeByAgent.get(agent.id) ?? 0,
      recoveryItems,
      health: deriveRuntimeHealthStatus(runtime),
      tone: worstTone(signals),
      signals,
    });
  }

  const danger = cards.filter((card) => card.tone === "danger").length;
  const warnings = cards.filter((card) => card.tone === "warning").length;
  return {
    agents: cards,
    runtimes: [...runtimeMap.values()].sort((a, b) => {
      const tone = toneRank(b.tone) - toneRank(a.tone);
      if (tone !== 0) return tone;
      return a.runtimeName.localeCompare(b.runtimeName);
    }),
    counts: {
      agents: cards.length,
      runtimes: runtimeMap.size,
      warnings,
      danger,
      staleRuns: recovery.counts.activeStale,
      terminalFailures: recovery.counts.terminalFailures,
      protocolFailures: recovery.counts.protocolFailed,
    },
  };
}
