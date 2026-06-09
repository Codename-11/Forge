import { NextResponse, type NextRequest } from "next/server";
import { zodToJsonSchema } from "zod-to-json-schema";
import { mcpTools, type McpToolName } from "@/server/services/mcp";
import { executeMcpTool, type McpExecutionFailure } from "@/server/services/mcp-exec";
import { mcpToolPolicy } from "@/server/services/mcp-policy";
import { authenticateApiKey, ApiKeyError } from "@/server/services/api-key-auth";
import { rateLimit } from "@/server/rate-limit";
import { logger } from "@/server/logger";
import { mcpServerInfo } from "@/server/build-info";

/**
 * Standard MCP (Model Context Protocol) endpoint — Streamable HTTP transport
 * per spec 2025-03-26. Speaks JSON-RPC 2.0 over HTTP.
 *
 * Methods supported:
 *   - initialize           — handshake. Returns serverInfo + capabilities.
 *   - notifications/initialized (notification, no response)
 *   - ping                 — liveness.
 *   - tools/list           — enumerate tools with JSON Schema input shapes.
 *   - tools/call           — invoke a tool. Returns MCP content[] blocks.
 *
 * Auth: `Authorization: Bearer <forge_sk_…>` — scoped per tool.
 *
 * This sits alongside the simpler REST-style `/api/mcp/[tool]` dispatcher.
 * REST stays for curl/debugging; this route is the one branded as MCP.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-03-26";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
};

type JsonRpcError = { code: number; message: string; data?: unknown };

function ok(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function fail(id: JsonRpcRequest["id"], err: JsonRpcError) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: err };
}

function rpcErrorCode(error: McpExecutionFailure): number {
  switch (error.code) {
    case "UNKNOWN_TOOL":
      return -32601;
    case "INVALID_INPUT":
      return -32602;
    case "UNAUTHENTICATED":
      return -32001;
    case "FORBIDDEN":
    case "POLICY_DENIED":
      return -32002;
    case "TOOL_ERROR":
      return -32000;
  }
}

function toolDescriptor(name: McpToolName) {
  const t = mcpTools[name];
  const inputSchema = zodToJsonSchema(t.input, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  // Tools may optionally export a richer `description` field; fall back
  // to the auto-generated scope-only summary when one isn't supplied.
  const customDesc = (t as { description?: string }).description;
  const description = customDesc
    ? `${customDesc}\n\nRequired scopes: ${t.scopes.join(", ")}.`
    : `Forge tool. Required scopes: ${t.scopes.join(", ")}.`;
  return {
    name,
    description,
    annotations: {
      forgePolicy: mcpToolPolicy(name, t.scopes),
    },
    inputSchema,
  };
}

async function handleRpc(
  msg: JsonRpcRequest,
  auth: Awaited<ReturnType<typeof authenticateApiKey>> | null,
  authError: ApiKeyError | null,
) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: await mcpServerInfo(),
        instructions:
          "Forge - project management. Tools cover issues, projects, comments, analytics, and the agent queue.",
      });

    case "notifications/initialized":
      return null; // notification; no response

    case "ping":
      return ok(id, {});

    case "tools/list": {
      const tools = (Object.keys(mcpTools) as McpToolName[]).map(toolDescriptor);
      return ok(id, { tools });
    }

    case "tools/call": {
      if (!auth) {
        return fail(id, {
          code: -32001,
          message: authError?.message ?? "Unauthenticated. Send Bearer token.",
        });
      }
      const p = (params ?? {}) as { name?: string; arguments?: unknown };
      if (!p.name) return fail(id, { code: -32602, message: "Missing tool name." });

      const exec = await executeMcpTool({
        name: p.name,
        input: p.arguments ?? {},
        ctx: {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          pluginId: auth.pluginId,
          apiKey: auth,
        },
        source: "json-rpc",
      });

      if (!exec.ok && exec.error.code === "INVALID_INPUT") {
        return fail(id, {
          code: -32602,
          message: "Invalid tool arguments.",
          data: exec.error.data,
        });
      }
      if (!exec.ok && exec.error.code !== "TOOL_ERROR") {
        return fail(id, {
          code: rpcErrorCode(exec.error),
          message: exec.error.message,
          data: exec.error.data,
        });
      }
      if (exec.ok) {
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(exec.result, null, 2) }],
          isError: false,
        });
      }

      logger.error({ err: exec.error.cause, tool: p.name }, "mcp tool error");
      return ok(id, {
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${exec.error.message}`,
          },
        ],
        isError: true,
      });
    }

    default:
      return fail(id, { code: -32601, message: `Method not found: ${method}` });
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // Authentication is optional for `initialize` / `tools/list` so clients can
  // inspect the server before wiring credentials. `tools/call` forces it.
  let auth: Awaited<ReturnType<typeof authenticateApiKey>> | null = null;
  let authError: ApiKeyError | null = null;
  if (token) {
    try {
      auth = await authenticateApiKey(token);
    } catch (err) {
      if (err instanceof ApiKeyError) authError = err;
      else throw err;
    }
  }

  const rlKey = auth?.keyId ?? `anon:${req.headers.get("x-forwarded-for") ?? "local"}`;
  const rl = await rateLimit(`mcp-rpc:${rlKey}`, 600, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32003, message: "Rate limit exceeded." } },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } },
      { status: 400 },
    );
  }

  // Support both single requests and batched arrays (JSON-RPC 2.0 spec).
  if (Array.isArray(body)) {
    const responses = await Promise.all(
      body.map((msg) => handleRpc(msg as JsonRpcRequest, auth, authError)),
    );
    const filtered = responses.filter((r) => r != null);
    return NextResponse.json(filtered);
  }

  const result = await handleRpc(body as JsonRpcRequest, auth, authError);
  if (result == null) return new NextResponse(null, { status: 204 });
  return NextResponse.json(result);
}

/**
 * Optional SSE endpoint for server-initiated messages. For now we don't push
 * anything; returning 200 with a keep-alive stream satisfies clients that
 * probe `GET` as part of the Streamable HTTP handshake.
 */
export async function GET() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": forge-mcp\n\n"));
    },
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
