import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  mcpToolNamespace,
  mcpTools,
  selectMcpToolNames,
  type McpContext,
  type McpToolName,
} from "@/server/services/mcp";
import { executeMcpTool, type McpExecutionFailure } from "@/server/services/mcp-exec";
import { mcpToolPolicy } from "@/server/services/mcp-policy";
import { authenticateApiKey, ApiKeyError } from "@/server/services/api-key-auth";
import { rateLimit } from "@/server/rate-limit";
import { logger } from "@/server/logger";
import { mcpServerInfo } from "@/server/build-info";
import { FORGE_MCP_INSTRUCTIONS } from "@/server/services/mcp-instructions";
import { db } from "@/server/db";
import { touchAgentConnection, upsertAgentConnection } from "@/server/services/agent-connection";
import { reconcileFreshMcpQuietRequestsForConnection } from "@/server/services/work-session";

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
const TOOL_LIST_PAGE_SIZE = 100;

const catalogToolNames = ["catalog.search", "catalog.describe", "catalog.call"] as const;
type CatalogToolName = (typeof catalogToolNames)[number];
type ToolListName = McpToolName | CatalogToolName;

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

function mcpJsonSchema(schema: z.ZodTypeAny) {
  return zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
}

function toolDescriptor(name: McpToolName) {
  const t = mcpTools[name];
  const inputSchema = mcpJsonSchema(t.input);
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

const catalogToolDefs = {
  "catalog.search": {
    input: z.object({
      query: z.string().max(120).optional(),
      namespace: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    description:
      "Search the full authorized Forge MCP catalog without advertising every tool directly. Use this when the compact tool list does not expose the operation you need.",
  },
  "catalog.describe": {
    input: z.object({
      names: z.array(z.string().max(120)).min(1).max(20),
    }),
    description:
      "Return full MCP descriptors, including input schemas, for authorized Forge tools by name.",
  },
  "catalog.call": {
    input: z.object({
      name: z.string().max(120),
      arguments: z.record(z.unknown()).default({}),
    }),
    description:
      "Invoke any authorized Forge MCP tool by name. Use catalog.search and catalog.describe first when the tool is not advertised directly.",
  },
} satisfies Record<CatalogToolName, { input: z.ZodTypeAny; description: string }>;

function isCatalogToolName(name: string): name is CatalogToolName {
  return (catalogToolNames as readonly string[]).includes(name);
}

function catalogToolDescriptor(name: CatalogToolName) {
  const def = catalogToolDefs[name];
  return {
    name,
    description: def.description,
    annotations: {
      forgePolicy: {
        actor: "api-key",
        allowedModes: "ANY",
        notes: "Catalog helpers preserve the target tool's scopes and runtime policy.",
      },
    },
    inputSchema: mcpJsonSchema(def.input),
  };
}

function listToolDescriptor(name: ToolListName) {
  return isCatalogToolName(name) ? catalogToolDescriptor(name) : toolDescriptor(name);
}

/** `tools/list` narrowing parsed from the request URL query string. */
type ListOptions = { profile: string | null; namespaces: string[] | null };
type CatalogToolRunResult =
  | { ok: false; rpcError: JsonRpcError }
  | { ok: true; result: unknown; isError?: boolean };

function mcpContext(
  auth: NonNullable<Awaited<ReturnType<typeof authenticateApiKey>>>,
  connectionId?: string | null,
): McpContext {
  return {
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    pluginId: auth.pluginId,
    apiKey: auth,
    connectionId: connectionId ?? null,
  };
}

type McpClientInfo = { name: string; version?: string };

function initializeClient(
  body: unknown,
): { clientInfo: McpClientInfo | null; protocol?: string } | null {
  const messages = Array.isArray(body) ? body : [body];
  const initialize = messages.find(
    (item): item is JsonRpcRequest =>
      !!item && typeof item === "object" && (item as JsonRpcRequest).method === "initialize",
  );
  if (!initialize) return null;
  const params =
    initialize.params && typeof initialize.params === "object" && !Array.isArray(initialize.params)
      ? (initialize.params as Record<string, unknown>)
      : {};
  const raw =
    params.clientInfo && typeof params.clientInfo === "object" && !Array.isArray(params.clientInfo)
      ? (params.clientInfo as Record<string, unknown>)
      : null;
  const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 120) : "";
  const version = typeof raw?.version === "string" ? raw.version.trim().slice(0, 80) : undefined;
  return {
    clientInfo: name ? { name, ...(version ? { version } : {}) } : null,
    ...(typeof params.protocolVersion === "string"
      ? { protocol: params.protocolVersion.slice(0, 40) }
      : {}),
  };
}

async function resolveMcpConnection(
  auth: NonNullable<Awaited<ReturnType<typeof authenticateApiKey>>>,
  body: unknown,
  suppliedSessionId: string | null,
) {
  const agentId = auth.linkedAgentId;
  if (!agentId) return null;
  const initialize = initializeClient(body);
  const sessionId = suppliedSessionId?.trim().slice(0, 255) || null;

  let connection: Awaited<ReturnType<typeof upsertAgentConnection>> | null = null;
  if (!initialize && sessionId) {
    const existing = await db.agentConnection.findFirst({
      where: {
        workspaceId: auth.workspaceId,
        agentId,
        kind: "MCP_CLIENT",
        instanceKey: sessionId,
        revokedAt: null,
      },
    });
    if (existing) connection = await touchAgentConnection(db, existing.id);
  }

  if (!connection) {
    const clientName = initialize?.clientInfo?.name ?? null;
    connection = await upsertAgentConnection(db, {
      workspaceId: auth.workspaceId,
      agentId,
      kind: "MCP_CLIENT",
      livenessModel: "LEASE",
      apiKeyId: auth.keyId,
      instanceKey: sessionId ?? (initialize ? `mcp-${randomUUID()}` : `legacy-${auth.keyId}`),
      displayName: clientName || "Unidentified MCP client",
      clientName,
      clientVersion: initialize?.clientInfo?.version ?? null,
      capabilities: ["TOOL_ACTIVITY"],
      metadata: {
        transport: "streamable-http",
        protocolVersion: initialize?.protocol ?? PROTOCOL_VERSION,
        identified: Boolean(clientName),
      },
    });
  }
  await reconcileFreshMcpQuietRequestsForConnection(db, auth.workspaceId, connection.id);
  return connection;
}

function toolContent(result: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    return typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : null;
  } catch {
    return null;
  }
}

function listCursor(
  params: unknown,
): { ok: true; offset: number } | { ok: false; message: string } {
  if (params == null) return { ok: true, offset: 0 };
  if (typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, message: "tools/list params must be an object." };
  }
  const cursor = (params as { cursor?: unknown }).cursor;
  if (cursor == null) return { ok: true, offset: 0 };
  if (typeof cursor !== "string")
    return { ok: false, message: "tools/list cursor must be a string." };
  const offset = decodeCursor(cursor);
  return offset == null
    ? { ok: false, message: "Invalid tools/list cursor." }
    : { ok: true, offset };
}

function allowedMcpToolNames(
  auth: Awaited<ReturnType<typeof authenticateApiKey>> | null,
): McpToolName[] {
  return selectMcpToolNames({
    profile: "full",
    scopes: auth?.scopes ?? null,
  });
}

function compactDescription(name: McpToolName): string {
  const tool = mcpTools[name];
  const customDesc = (tool as { description?: string }).description;
  return (customDesc ?? "Forge tool.").split("\n")[0] ?? "Forge tool.";
}

async function handleCatalogTool(
  name: CatalogToolName,
  args: unknown,
  auth: NonNullable<Awaited<ReturnType<typeof authenticateApiKey>>>,
  connectionId?: string | null,
): Promise<CatalogToolRunResult> {
  const parsed = catalogToolDefs[name].input.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      rpcError: {
        code: -32602,
        message: "Invalid tool arguments.",
        data: parsed.error.flatten(),
      },
    };
  }

  const visible = allowedMcpToolNames(auth);

  if (name === "catalog.search") {
    const input = parsed.data as z.infer<(typeof catalogToolDefs)["catalog.search"]["input"]>;
    const query = input.query?.trim().toLowerCase();
    const namespace = input.namespace?.trim();
    const matches = visible
      .filter((toolName) => {
        if (namespace && mcpToolNamespace(toolName) !== namespace) return false;
        if (!query) return true;
        const haystack =
          `${toolName} ${compactDescription(toolName)} ${mcpTools[toolName].scopes.join(" ")}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, input.limit)
      .map((toolName) => ({
        name: toolName,
        namespace: mcpToolNamespace(toolName),
        description: compactDescription(toolName),
        scopes: mcpTools[toolName].scopes,
        policy: mcpToolPolicy(toolName, mcpTools[toolName].scopes),
      }));
    return { ok: true, result: { tools: matches, totalAuthorizedTools: visible.length } };
  }

  if (name === "catalog.describe") {
    const input = parsed.data as z.infer<(typeof catalogToolDefs)["catalog.describe"]["input"]>;
    const allowed = new Set<string>(visible);
    const descriptors = input.names
      .filter((toolName): toolName is McpToolName => allowed.has(toolName))
      .map(toolDescriptor);
    const missing = input.names.filter((toolName) => !allowed.has(toolName));
    return { ok: true, result: { tools: descriptors, unavailable: missing } };
  }

  const input = parsed.data as z.infer<(typeof catalogToolDefs)["catalog.call"]["input"]>;
  if (isCatalogToolName(input.name)) {
    return {
      ok: true,
      result: { error: "catalog.call cannot invoke catalog helper tools." },
      isError: true,
    };
  }

  const exec = await executeMcpTool({
    name: input.name,
    input: input.arguments,
    ctx: mcpContext(auth, connectionId),
    source: "json-rpc",
  });
  if (exec.ok) return { ok: true, result: { toolName: exec.toolName, result: exec.result } };
  return {
    ok: true,
    result: {
      toolName: input.name,
      error: exec.error.message,
      code: exec.error.code,
      data: exec.error.data,
    },
    isError: true,
  };
}

async function handleRpc(
  msg: JsonRpcRequest,
  auth: Awaited<ReturnType<typeof authenticateApiKey>> | null,
  authError: ApiKeyError | null,
  listOptions: ListOptions,
  connectionId?: string | null,
) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: await mcpServerInfo(),
        instructions: FORGE_MCP_INSTRUCTIONS,
      });

    case "notifications/initialized":
      return null; // notification; no response

    case "ping":
      return ok(id, {});

    case "tools/list": {
      const cursor = listCursor(params);
      if (!cursor.ok) return fail(id, { code: -32602, message: cursor.message });

      // Advertise a compact default surface so capped providers (e.g. xAI/Grok
      // at 200) aren't blown out by the full registry. `?profile=full` opts in
      // to the complete catalog; full/large lists are paginated per MCP.
      const names = selectMcpToolNames({
        profile: listOptions.profile,
        namespaces: listOptions.namespaces,
        scopes: auth?.scopes ?? null,
      });
      const allNames: ToolListName[] = [...names, ...catalogToolNames];
      const page = allNames.slice(cursor.offset, cursor.offset + TOOL_LIST_PAGE_SIZE);
      const nextOffset = cursor.offset + TOOL_LIST_PAGE_SIZE;
      return ok(id, {
        tools: page.map(listToolDescriptor),
        ...(nextOffset < allNames.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
      });
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

      if (isCatalogToolName(p.name)) {
        const catalog = await handleCatalogTool(p.name, p.arguments ?? {}, auth, connectionId);
        if (!catalog.ok) return fail(id, catalog.rpcError);
        return ok(id, toolContent(catalog.result, catalog.isError ?? false));
      }

      const exec = await executeMcpTool({
        name: p.name,
        input: p.arguments ?? {},
        ctx: mcpContext(auth, connectionId),
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

  // MCP Streamable HTTP is otherwise stateless. Negotiate a durable endpoint
  // identity on initialize and accept it on later requests via the standard
  // session header. Older clients that omit the header get one clearly marked
  // credential-level "Unidentified MCP client" connection.
  const connection = auth
    ? await resolveMcpConnection(auth, body, req.headers.get("mcp-session-id"))
    : null;
  const responseHeaders = connection?.instanceKey
    ? { "Mcp-Session-Id": connection.instanceKey }
    : undefined;

  // `tools/list` narrowing (AXI-82): default is the compact runtime profile.
  // `?profile=full` opts into the full direct catalog; `?tools=issues,comments,…`
  // hand-picks namespaces. Configure it on the MCP server URL when a client
  // needs a different advertised surface.
  const profileParam = req.nextUrl.searchParams.get("profile");
  const toolsParam = req.nextUrl.searchParams.get("tools");
  const listOptions: ListOptions = {
    profile: profileParam,
    namespaces: toolsParam
      ? toolsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
  };

  // Support both single requests and batched arrays (JSON-RPC 2.0 spec).
  if (Array.isArray(body)) {
    const responses = await Promise.all(
      body.map((msg) =>
        handleRpc(msg as JsonRpcRequest, auth, authError, listOptions, connection?.id),
      ),
    );
    const filtered = responses.filter((r) => r != null);
    return NextResponse.json(filtered, { headers: responseHeaders });
  }

  const result = await handleRpc(
    body as JsonRpcRequest,
    auth,
    authError,
    listOptions,
    connection?.id,
  );
  if (result == null) return new NextResponse(null, { status: 204, headers: responseHeaders });
  return NextResponse.json(result, { headers: responseHeaders });
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
