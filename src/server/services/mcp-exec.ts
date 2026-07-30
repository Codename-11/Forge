import "server-only";
import type { PluginScope } from "@prisma/client";
import { db } from "@/server/db";
import { mcpTools, type McpContext, type McpToolName } from "@/server/services/mcp";
import {
  EXPLICIT_MCP_TOOL_POLICIES,
  assertMcpIssueMutationsPolicy,
  assertMcpWorkspaceMutationPolicy,
  type ExplicitMcpPolicyToolName,
  type McpToolPolicy,
} from "@/server/services/mcp-policy";

export type McpExecutionSource = "json-rpc" | "rest" | "chat" | "test";

export type McpExecutionErrorCode =
  | "UNAUTHENTICATED"
  | "UNKNOWN_TOOL"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "POLICY_DENIED"
  | "TOOL_ERROR";

export type McpExecutionFailure = {
  code: McpExecutionErrorCode;
  message: string;
  status: number;
  data?: unknown;
  cause?: unknown;
};

export type McpExecutionResult =
  | {
      ok: true;
      toolName: McpToolName;
      result: unknown;
    }
  | {
      ok: false;
      toolName?: McpToolName;
      error: McpExecutionFailure;
    };

export type ExecuteMcpToolOptions = {
  name: string;
  input: unknown;
  ctx: McpContext;
  source?: McpExecutionSource;
  /**
   * HTTP MCP calls must be API-key authenticated. Session-backed in-process
   * callers, such as confirmed chat tools, pass false and still execute
   * through the same parse/policy/run path.
   */
  requireApiKey?: boolean;
};

function hasOwn<T extends object>(obj: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isMcpToolName(name: string): name is McpToolName {
  return hasOwn(mcpTools, name);
}

function inputObject(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function stringField(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return typeof value === "string" ? value : null;
}

function stringArrayField(input: Record<string, unknown>, field: string): string[] {
  const value = input[field];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function failure(
  code: McpExecutionErrorCode,
  message: string,
  status: number,
  opts: { data?: unknown; cause?: unknown } = {},
): McpExecutionResult {
  return {
    ok: false,
    error: {
      code,
      message,
      status,
      ...(opts.data === undefined ? {} : { data: opts.data }),
      ...(opts.cause === undefined ? {} : { cause: opts.cause }),
    },
  };
}

function assertMcpScopes(toolName: McpToolName, ctx: McpContext): McpExecutionFailure | null {
  const apiKey = ctx.apiKey;
  if (!apiKey) return null;

  const def = mcpTools[toolName];
  for (const scope of def.scopes) {
    if (!apiKey.scopes.includes(scope as PluginScope)) {
      return {
        code: "FORBIDDEN",
        message: `Missing required scope: ${scope}`,
        status: 403,
      };
    }
  }
  return null;
}

type PolicyTarget =
  | { kind: "none" }
  | { kind: "workspace" }
  | { kind: "issues"; issueIds: string[] };

async function resolveExplicitPolicyTarget(
  toolName: ExplicitMcpPolicyToolName,
  parsedInput: unknown,
  ctx: McpContext,
): Promise<PolicyTarget> {
  const input = inputObject(parsedInput);

  switch (toolName) {
    case "issues.create":
      return { kind: "workspace" };
    case "issues.claim": {
      const issueId = stringField(input, "issueId");
      return issueId ? { kind: "issues", issueIds: [issueId] } : { kind: "workspace" };
    }
    case "issues.update":
    case "issues.transition":
    case "issues.release":
    case "issues.setQueued": {
      const id = stringField(input, "id");
      return id ? { kind: "issues", issueIds: [id] } : { kind: "none" };
    }
    case "issues.assign":
    case "issues.reassign":
    case "issues.setLabels":
    case "cycles.addIssue":
    case "cycles.removeIssue": {
      const issueId = stringField(input, "issueId");
      return issueId ? { kind: "issues", issueIds: [issueId] } : { kind: "none" };
    }
    case "issues.bulkTransition": {
      return { kind: "issues", issueIds: stringArrayField(input, "ids") };
    }
    case "issues.bulkSetLabels": {
      return { kind: "issues", issueIds: stringArrayField(input, "issueIds") };
    }
    case "relations.add": {
      return {
        kind: "issues",
        issueIds: [stringField(input, "fromIssueId"), stringField(input, "toIssueId")].filter(
          (id): id is string => id !== null,
        ),
      };
    }
    case "artifacts.create": {
      const issueId = stringField(input, "issueId");
      return issueId ? { kind: "issues", issueIds: [issueId] } : { kind: "none" };
    }
    case "artifacts.update":
    case "artifacts.archive": {
      const id = stringField(input, "id");
      if (!id) return { kind: "none" };
      const artifact = await db.artifact.findFirst({
        where: { id, workspaceId: ctx.workspaceId },
        select: { issueId: true },
      });
      return artifact?.issueId
        ? { kind: "issues", issueIds: [artifact.issueId] }
        : { kind: "none" };
    }
    case "artifacts.promote": {
      const issueId = stringField(input, "issueId");
      if (issueId) return { kind: "issues", issueIds: [issueId] };
      if (stringField(input, "sourceType") === "issue") {
        const sourceId = stringField(input, "sourceId");
        return sourceId ? { kind: "issues", issueIds: [sourceId] } : { kind: "none" };
      }
      return { kind: "workspace" };
    }
    case "actionRequests.accept": {
      const id = stringField(input, "id");
      if (!id) return { kind: "none" };
      const request = await db.actionRequest.findFirst({
        where: { id, workspaceId: ctx.workspaceId },
        select: { issueId: true },
      });
      return request?.issueId ? { kind: "issues", issueIds: [request.issueId] } : { kind: "none" };
    }
    case "runs.complete":
    case "runs.setWaiting":
    case "runs.resumeWork":
    case "agent.inbox.ack":
    case "agent.inbox.outputStarted":
    case "runtimes.provisioning":
      return { kind: "none" };
    case "workSessions.claim":
      return { kind: "issues", issueIds: [input.issueId as string] };
    case "workSessions.heartbeat":
    case "workSessions.abandon":
    case "workSessions.attachPullRequest": {
      const sessionId = input.sessionId as string | undefined;
      if (!sessionId) return { kind: "none" };
      const session = await db.workSession.findFirst({
        where: { id: sessionId, workspaceId: ctx.workspaceId },
        select: { issueId: true },
      });
      return session ? { kind: "issues", issueIds: [session.issueId] } : { kind: "none" };
    }
  }
}

async function runExplicitPolicyPreflight(
  toolName: McpToolName,
  parsedInput: unknown,
  ctx: McpContext,
): Promise<McpExecutionFailure | null> {
  const policy = EXPLICIT_MCP_TOOL_POLICIES[toolName as ExplicitMcpPolicyToolName];
  if (!policy) return null;
  const actor = policy.actor as McpToolPolicy["actor"];

  if (actor === "linked-agent-required" && !ctx.apiKey?.linkedAgentId) {
    return {
      code: "POLICY_DENIED",
      message: `${toolName} requires an API key with linkedAgentId set.`,
      status: 403,
    };
  }
  if (actor === "human-only" && !ctx.userId) {
    return {
      code: "POLICY_DENIED",
      message: `${toolName} requires a human user context.`,
      status: 403,
    };
  }
  if (policy.allowedModes === "ANY") return null;

  try {
    const target = await resolveExplicitPolicyTarget(
      toolName as ExplicitMcpPolicyToolName,
      parsedInput,
      ctx,
    );
    if (target.kind === "workspace") {
      await assertMcpWorkspaceMutationPolicy(ctx, toolName as ExplicitMcpPolicyToolName);
    } else if (target.kind === "issues" && target.issueIds.length > 0) {
      await assertMcpIssueMutationsPolicy(
        ctx,
        toolName as ExplicitMcpPolicyToolName,
        target.issueIds,
      );
    }
    return null;
  } catch (err) {
    return {
      code: "POLICY_DENIED",
      message: err instanceof Error ? err.message : `Policy preflight failed for ${toolName}.`,
      status: 403,
      cause: err,
    };
  }
}

export async function executeMcpTool(opts: ExecuteMcpToolOptions): Promise<McpExecutionResult> {
  const requireApiKey = opts.requireApiKey ?? true;
  if (requireApiKey && !opts.ctx.apiKey) {
    return failure("UNAUTHENTICATED", "Missing bearer token.", 401);
  }

  if (!isMcpToolName(opts.name)) {
    return failure("UNKNOWN_TOOL", `Unknown tool: ${opts.name}`, 404);
  }

  const scopeFailure = assertMcpScopes(opts.name, opts.ctx);
  if (scopeFailure) return { ok: false, toolName: opts.name, error: scopeFailure };

  const def = mcpTools[opts.name];
  const parsed = def.input.safeParse(opts.input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      toolName: opts.name,
      error: {
        code: "INVALID_INPUT",
        message: `Invalid arguments for ${opts.name}.`,
        status: 400,
        data: parsed.error.flatten(),
        cause: parsed.error,
      },
    };
  }

  const policyFailure = await runExplicitPolicyPreflight(opts.name, parsed.data, opts.ctx);
  if (policyFailure) return { ok: false, toolName: opts.name, error: policyFailure };

  try {
    const run = def.run as (input: unknown, ctx: McpContext) => Promise<unknown>;
    return {
      ok: true,
      toolName: opts.name,
      result: await run(parsed.data, opts.ctx),
    };
  } catch (err) {
    return {
      ok: false,
      toolName: opts.name,
      error: {
        code: "TOOL_ERROR",
        message: err instanceof Error ? err.message : `Tool ${opts.name} failed.`,
        status: 500,
        cause: err,
      },
    };
  }
}
