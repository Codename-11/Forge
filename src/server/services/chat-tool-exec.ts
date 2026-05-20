import "server-only";
import { mcpTools, type McpToolName } from "@/server/services/mcp";
import { findChatTool } from "@/server/services/chat-tools-allowlist";
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
export async function executeChatTool(
  args: ExecuteChatToolArgs,
): Promise<ChatToolResult> {
  const tool = findChatTool(args.name);
  if (!tool) {
    return {
      ok: false,
      summary: `Tool ${args.name} is not on the chat allowlist.`,
    };
  }

  const def = (mcpTools as Record<string, unknown>)[tool.name] as
    | (typeof mcpTools)[McpToolName]
    | undefined;
  if (!def) {
    return {
      ok: false,
      summary: `Tool ${tool.name} is not a registered MCP tool.`,
    };
  }

  const parsed = def.input.safeParse(args.args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      summary: `Invalid arguments for ${tool.name}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .slice(0, 3)
        .join("; ")}`,
    };
  }

  try {
    const run = def.run as (
      input: unknown,
      ctx: {
        workspaceId: string;
        userId: string | null;
        pluginId: string | null;
        apiKey: null;
      },
    ) => Promise<unknown>;
    const result = await run(parsed.data, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      pluginId: null,
      apiKey: null,
    });
    return {
      ok: true,
      summary: summarize(tool.name, result),
      result,
    };
  } catch (err) {
    logger.warn(
      { err, tool: tool.name, workspaceId: args.workspaceId },
      "chat-tool-exec: tool run failed",
    );
    return {
      ok: false,
      summary: err instanceof Error ? err.message : `Tool ${tool.name} failed.`,
    };
  }
}
