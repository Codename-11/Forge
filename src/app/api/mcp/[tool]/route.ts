import { NextResponse, type NextRequest } from "next/server";
import { describeMcp } from "@/server/services/mcp";
import { executeMcpTool } from "@/server/services/mcp-exec";
import { authenticateApiKey, ApiKeyError } from "@/server/services/api-key-auth";
import { rateLimit } from "@/server/rate-limit";
import { logger } from "@/server/logger";

function hasDataEnvelope(result: unknown): result is { data: unknown } {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.prototype.hasOwnProperty.call(result, "data")
  );
}

/**
 * MCP tool dispatch: `POST /api/mcp/:tool` with JSON body as the tool input.
 * `GET /api/mcp/describe` returns the catalog.
 *
 * Auth: `Authorization: Bearer <forge_sk_...>` — scoped API key.
 * Each tool declares required scopes; shared execution rejects missing scopes.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  if (tool === "describe") {
    return NextResponse.json(await describeMcp());
  }

  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: "Missing bearer token." }, { status: 401 });

  let principal: Awaited<ReturnType<typeof authenticateApiKey>>;
  try {
    principal = await authenticateApiKey(token);
  } catch (err) {
    if (err instanceof ApiKeyError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }

  const rl = await rateLimit(`mcp:${principal.keyId}`, 300, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded." },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is OK for tools that take no input
  }

  const exec = await executeMcpTool({
    name: tool,
    input: body,
    ctx: {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      pluginId: principal.pluginId,
      apiKey: principal,
    },
    source: "rest",
  });

  if (!exec.ok) {
    if (exec.error.code === "INVALID_INPUT") {
      return NextResponse.json(
        { error: "Invalid input.", issues: exec.error.data },
        { status: 400 },
      );
    }
    if (exec.error.code === "TOOL_ERROR") {
      logger.error({ err: exec.error.cause, tool }, "mcp tool error");
      return NextResponse.json({ error: "Tool execution failed." }, { status: 500 });
    }
    return NextResponse.json({ error: exec.error.message }, { status: exec.error.status });
  }

  try {
    return NextResponse.json(hasDataEnvelope(exec.result) ? exec.result : { data: exec.result });
  } catch (err) {
    logger.error({ err, tool }, "mcp response serialization error");
    return NextResponse.json({ error: "Tool execution failed." }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  if (tool === "describe") return NextResponse.json(await describeMcp());
  return NextResponse.json({ error: "Use POST for tool invocation." }, { status: 405 });
}
