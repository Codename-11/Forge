import { NextResponse, type NextRequest } from "next/server";
import { mcpTools, describeMcp, type McpToolName } from "@/server/services/mcp";
import { authenticateApiKey, ApiKeyError } from "@/server/services/api-key-auth";
import { rateLimit } from "@/server/rate-limit";
import { logger } from "@/server/logger";

/**
 * MCP tool dispatch: `POST /api/mcp/:tool` with JSON body as the tool input.
 * `GET /api/mcp/describe` returns the catalog.
 *
 * Auth: `Authorization: Bearer <forge_sk_...>` — scoped API key.
 * Each tool declares required scopes; we reject early on missing scopes.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  if (tool === "describe") {
    return NextResponse.json(await describeMcp());
  }

  const def = mcpTools[tool as McpToolName];
  if (!def) return NextResponse.json({ error: "Unknown tool." }, { status: 404 });

  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: "Missing bearer token." }, { status: 401 });

  let principal: Awaited<ReturnType<typeof authenticateApiKey>>;
  try {
    principal = await authenticateApiKey(token, [...def.scopes]);
  } catch (err) {
    if (err instanceof ApiKeyError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }

  const rl = await rateLimit(`mcp:${principal.keyId}`, 300, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded." },
      { status: 429, headers: { "retry-after": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is OK for tools that take no input
  }

  const parsed = def.input.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input.", issues: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await def.run(parsed.data as never, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      pluginId: principal.pluginId,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    logger.error({ err, tool }, "mcp tool error");
    return NextResponse.json({ error: "Tool execution failed." }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  if (tool === "describe") return NextResponse.json(await describeMcp());
  return NextResponse.json({ error: "Use POST for tool invocation." }, { status: 405 });
}
