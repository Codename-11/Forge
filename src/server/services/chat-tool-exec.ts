import "server-only";
import { findChatTool } from "@/server/services/chat-tools-allowlist";
import { executeMcpTool } from "@/server/services/mcp-exec";
import { logger } from "@/server/logger";

export interface ExecuteChatToolArgs {
  workspaceId: string;
  userId: string;
  /** Tool name the model emitted (dotted MCP form or underscored OpenAI form). */
  name: string;
  args: Record<string, unknown>;
}

export interface ChatToolResult {
  ok: boolean;
  summary: string;
  result?: unknown;
}

function summarize(name: string, result: unknown): string {
  if (result == null) return `${name} ok`;
  if (typeof result === "string") return result.slice(0, 200);
  if (typeof result === "number" || typeof result === "boolean") {
    return `${name} -> ${String(result)}`;
  }
  if (Array.isArray(result)) {
    return `${name} -> ${result.length} row${result.length === 1 ? "" : "s"}`;
  }
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if ("id" in obj && typeof obj.id === "string") {
      return `${name} -> id ${obj.id.slice(0, 12)}`;
    }
    const keys = Object.keys(obj).slice(0, 3);
    return `${name} ok (${keys.join(", ")})`;
  }
  return `${name} ok`;
}

/**
 * Run a chat-surfaced tool through the MCP registry. Mirrors the tools/call
 * branch in /api/mcp/rpc/route.ts but in-process with a synthetic
 * (apiKey-less) McpContext sourced from the authenticated session.
 */
export async function executeChatTool(args: ExecuteChatToolArgs): Promise<ChatToolResult> {
  const tool = findChatTool(args.name);
  if (!tool) {
    return {
      ok: false,
      summary: `Tool ${args.name} is not on the chat allowlist.`,
    };
  }

  const exec = await executeMcpTool({
    name: tool.name,
    input: args.args ?? {},
    ctx: {
      workspaceId: args.workspaceId,
      userId: args.userId,
      pluginId: null,
      apiKey: null,
    },
    source: "chat",
    requireApiKey: false,
  });

  if (exec.ok) {
    return {
      ok: true,
      summary: summarize(tool.name, exec.result),
      result: exec.result,
    };
  }

  if (exec.error.code === "TOOL_ERROR") {
    logger.warn(
      { err: exec.error.cause, tool: tool.name, workspaceId: args.workspaceId },
      "chat-tool-exec: tool run failed",
    );
  }
  return {
    ok: false,
    summary: exec.error.message,
  };
}
