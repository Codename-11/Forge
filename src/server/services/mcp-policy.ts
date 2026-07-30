import "server-only";
import { AgentRunStatus, type EngagementMode } from "@prisma/client";
import { db } from "@/server/db";
import type { McpContext } from "@/server/services/mcp";

export type McpToolAccess = "read" | "write";
export type McpToolTarget =
  | "issue"
  | "comment"
  | "artifact"
  | "action-request"
  | "agent-run"
  | "runtime"
  | "workspace"
  | "canvas"
  | "plan"
  | "note";
export type McpMutationKind =
  | "issue-state"
  | "comment"
  | "artifact"
  | "run-lifecycle"
  | "runtime-config"
  | "workspace-config"
  | "canvas"
  | "plan"
  | "note";

export type McpToolPolicy = {
  access: McpToolAccess;
  targetType: McpToolTarget;
  mutationKind?: McpMutationKind;
  allowedModes: "ANY" | readonly EngagementMode[];
  actor: "agent-ok" | "human-only" | "linked-agent-required";
};

const EXECUTE_ONLY = ["EXECUTE"] as const;

export const EXPLICIT_MCP_TOOL_POLICIES = {
  "issues.update": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.bulkTransition": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.transition": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.assign": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.reassign": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.setLabels": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.create": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.claim": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.release": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.setQueued": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "issues.bulkSetLabels": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "artifacts.create": {
    access: "write",
    targetType: "artifact",
    mutationKind: "artifact",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "artifacts.update": {
    access: "write",
    targetType: "artifact",
    mutationKind: "artifact",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "artifacts.archive": {
    access: "write",
    targetType: "artifact",
    mutationKind: "artifact",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "actionRequests.accept": {
    access: "write",
    targetType: "action-request",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "cycles.addIssue": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "cycles.removeIssue": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "relations.add": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "artifacts.promote": {
    access: "write",
    targetType: "artifact",
    mutationKind: "artifact",
    allowedModes: EXECUTE_ONLY,
    actor: "agent-ok",
  },
  "runs.complete": {
    access: "write",
    targetType: "agent-run",
    mutationKind: "run-lifecycle",
    allowedModes: "ANY",
    actor: "linked-agent-required",
  },
  // The runtime fetches its OWN secrets + repo bindings to provision itself.
  // Linked-agent-required: only an agent's key can call, and it resolves to
  // that agent's runtime — never another's. Read-only, any engagement mode.
  "runtimes.provisioning": {
    access: "read",
    targetType: "runtime",
    allowedModes: "ANY",
    actor: "linked-agent-required",
  },
  "runs.setWaiting": {
    access: "write",
    targetType: "agent-run",
    mutationKind: "run-lifecycle",
    allowedModes: "ANY",
    actor: "linked-agent-required",
  },
  "runs.resumeWork": {
    access: "write",
    targetType: "agent-run",
    mutationKind: "run-lifecycle",
    allowedModes: "ANY",
    actor: "linked-agent-required",
  },
  "agent.inbox.ack": {
    access: "write",
    targetType: "agent-run",
    mutationKind: "run-lifecycle",
    allowedModes: "ANY",
    actor: "linked-agent-required",
  },
  "agent.inbox.outputStarted": {
    access: "write",
    targetType: "agent-run",
    mutationKind: "run-lifecycle",
    allowedModes: "ANY",
    actor: "linked-agent-required",
  },
  "workSessions.claim": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "linked-agent-required",
  },
  "workSessions.heartbeat": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "linked-agent-required",
  },
  "workSessions.abandon": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "linked-agent-required",
  },
  "workSessions.attachPullRequest": {
    access: "write",
    targetType: "issue",
    mutationKind: "issue-state",
    allowedModes: EXECUTE_ONLY,
    actor: "linked-agent-required",
  },
} as const satisfies Record<string, McpToolPolicy>;

export type ExplicitMcpPolicyToolName = keyof typeof EXPLICIT_MCP_TOOL_POLICIES;

export function mcpToolPolicy(name: string, scopes: readonly string[] = []): McpToolPolicy {
  const explicit = EXPLICIT_MCP_TOOL_POLICIES[name as ExplicitMcpPolicyToolName];
  if (explicit) return explicit;

  const isWrite = scopes.some((scope) => scope.startsWith("WRITE_") || scope === "ADMIN");
  if (!isWrite) {
    return {
      access: "read",
      targetType: "workspace",
      allowedModes: "ANY",
      actor: "agent-ok",
    };
  }
  if (name.startsWith("comments.") || name.startsWith("chat.")) {
    return {
      access: "write",
      targetType: "comment",
      mutationKind: "comment",
      allowedModes: "ANY",
      actor: "agent-ok",
    };
  }
  if (name.startsWith("runtimes.")) {
    return {
      access: "write",
      targetType: "runtime",
      mutationKind: "runtime-config",
      allowedModes: "ANY",
      actor: "human-only",
    };
  }
  if (scopes.includes("WRITE_ISSUES")) {
    return {
      access: "write",
      targetType: "issue",
      mutationKind: "issue-state",
      allowedModes: EXECUTE_ONLY,
      actor: "agent-ok",
    };
  }
  if (scopes.includes("ADMIN")) {
    return {
      access: "write",
      targetType: "workspace",
      mutationKind: "workspace-config",
      allowedModes: "ANY",
      actor: "human-only",
    };
  }
  return {
    access: "write",
    targetType: "workspace",
    mutationKind: "workspace-config",
    allowedModes: "ANY",
    actor: "agent-ok",
  };
}

function allowedModesLabel(policy: McpToolPolicy): string {
  return policy.allowedModes === "ANY" ? "any mode" : policy.allowedModes.join(", ");
}

export async function assertMcpIssueMutationPolicy(
  ctx: McpContext,
  toolName: ExplicitMcpPolicyToolName,
  issueId: string,
): Promise<void> {
  const policy = EXPLICIT_MCP_TOOL_POLICIES[toolName];
  const agentId = ctx.apiKey?.linkedAgentId ?? null;
  if (!agentId || policy.allowedModes === "ANY") return;

  const run = await db.agentRun.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      issueId,
      agentId,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      engagementMode: { notIn: [...policy.allowedModes] },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, engagementMode: true },
  });
  if (!run) return;

  throw new Error(
    `Engagement mode ${run.engagementMode} does not allow ${toolName}. ` +
      `Allowed modes for this MCP mutation: ${allowedModesLabel(policy)}. ` +
      "Post a comment/verdict, set the run waiting, or ask the operator to stop and restart with EXECUTE.",
  );
}

export async function assertMcpIssueMutationsPolicy(
  ctx: McpContext,
  toolName: ExplicitMcpPolicyToolName,
  issueIds: Iterable<string>,
): Promise<void> {
  for (const issueId of new Set(issueIds)) {
    await assertMcpIssueMutationPolicy(ctx, toolName, issueId);
  }
}

export async function assertMcpWorkspaceMutationPolicy(
  ctx: McpContext,
  toolName: ExplicitMcpPolicyToolName,
): Promise<void> {
  const policy = EXPLICIT_MCP_TOOL_POLICIES[toolName];
  const agentId = ctx.apiKey?.linkedAgentId ?? null;
  if (!agentId || policy.allowedModes === "ANY") return;

  const run = await db.agentRun.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      agentId,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      engagementMode: { notIn: [...policy.allowedModes] },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, engagementMode: true },
  });
  if (!run) return;

  throw new Error(
    `Engagement mode ${run.engagementMode} does not allow ${toolName}. ` +
      `Allowed modes for this MCP mutation: ${allowedModesLabel(policy)}. ` +
      "Post a comment/verdict, set the run waiting, or ask the operator to stop and restart with EXECUTE.",
  );
}
