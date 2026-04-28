/**
 * Minimal MCP (JSON-RPC 2.0 over HTTP) client for the Forge CLI.
 *
 * Forge speaks Streamable HTTP MCP at `${url}/api/mcp/rpc`. We don't pull
 * in `@modelcontextprotocol/sdk` because the wire format is small and
 * pulling the SDK doubles the install footprint of the CLI for ~50
 * lines of code. This wrapper covers the only two methods we use:
 *
 *   - `tools/list`  — capability discovery (rare; mostly for `whoami`).
 *   - `tools/call`  — every Forge action.
 *
 * The MCP server returns tool results as `content[0].text` containing
 * JSON; we parse that opportunistically and fall back to the raw string
 * when it's not JSON-shaped (e.g. error messages from `isError: true`).
 */

import type { AuthFile } from "./auth.js";

let nextId = 1;

export interface McpCallOptions {
  /** Override the configured token — used during `forge login` to validate. */
  token?: string;
  /** Override the configured URL — used during `forge login`. */
  url?: string;
  /** Suppress stderr noise on tool errors (caller will format their own). */
  silent?: boolean;
}

export interface McpToolResult<T = unknown> {
  /** Parsed JSON if the tool returned a JSON-shaped string, else null. */
  data: T | null;
  /** Raw text content[0].text from the server. */
  text: string;
  /** True if MCP marked the response as a tool execution failure. */
  isError: boolean;
}

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

function endpoint(url: string): string {
  return new URL("/api/mcp/rpc", url).toString();
}

async function rpc<T>(
  auth: Pick<AuthFile, "url" | "token">,
  method: string,
  params: unknown,
): Promise<T> {
  const id = nextId++;
  const res = await fetch(endpoint(auth.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok && res.status !== 200) {
    let detail = "";
    try {
      detail = ` — ${await res.text()}`;
    } catch {
      // ignore
    }
    throw new McpError(
      `MCP HTTP ${res.status} on ${method}${detail}`,
      undefined,
      res.status,
    );
  }
  const body = (await res.json()) as {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: T;
    error?: { code: number; message: string; data?: unknown };
  };
  if (body.error) {
    throw new McpError(body.error.message, body.error.code);
  }
  if (body.result === undefined) {
    throw new McpError(`MCP empty response for ${method}`);
  }
  return body.result;
}

export async function callTool<T = unknown>(
  auth: AuthFile,
  name: string,
  args: Record<string, unknown> = {},
  opts: McpCallOptions = {},
): Promise<McpToolResult<T>> {
  const merged: Pick<AuthFile, "url" | "token"> = {
    url: opts.url ?? auth.url,
    token: opts.token ?? auth.token,
  };
  type CallResult = {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const result = await rpc<CallResult>(merged, "tools/call", {
    name,
    arguments: args,
  });
  const text = result.content?.[0]?.text ?? "";
  let parsed: T | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      // tool returned a non-JSON message; that's fine.
    }
  }
  return { data: parsed, text, isError: !!result.isError };
}

export async function listTools(
  auth: Pick<AuthFile, "url" | "token">,
): Promise<Array<{ name: string; description?: string }>> {
  const result = await rpc<{
    tools: Array<{ name: string; description?: string }>;
  }>(auth, "tools/list", {});
  return result.tools;
}

/**
 * Cheap "does this token work" probe. Hits `tools/list` which doesn't
 * require auth on Forge but DOES require it for `tools/call`. So we
 * follow up with a `tools/call` to `agents.me` (linkedAgentId required)
 * OR `analytics.summary` (any workspace member); the first one that
 * returns non-error counts as a valid token. We try `agents.me` first
 * because it's cheaper and tells us whether the key is agent-linked.
 */
export async function validateToken(
  auth: Pick<AuthFile, "url" | "token">,
): Promise<{ ok: true; agent?: AgentMe } | { ok: false; reason: string }> {
  try {
    // `agents.me` needs READ_USERS scope and linkedAgentId. If the key
    // has no agent link, this throws — we then fall back to a tool call
    // that any member can make (analytics.summary needs READ_ANALYTICS;
    // not every key has it). Easiest universal probe is just
    // `tools/list` — it doesn't auth but at least confirms the URL is
    // a Forge MCP server. That doesn't validate the *token* though.
    //
    // Compromise: try `agents.me` first; on agent-link failure try a
    // no-op-ish READ_ISSUES probe via `issues.list` with a tiny limit.
    const me = await callTool<AgentMe>(auth as AuthFile, "agents.me", {});
    if (!me.isError && me.data) return { ok: true, agent: me.data };
    // agents.me failed (likely no linkedAgentId). Try issues.list with
    // a 1-row probe — needs READ_ISSUES, which most keys carry.
    const probe = await callTool(auth as AuthFile, "issues.list", { limit: 1 });
    if (!probe.isError) return { ok: true };
    return { ok: false, reason: probe.text || me.text || "tool call failed" };
  } catch (err) {
    if (err instanceof McpError) {
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface AgentMe {
  id: string;
  profileKey: string;
  name: string;
  provider: string;
  runtimeMode: string;
  status: string;
  capabilities: string[];
  webhookUrl: string | null;
  workspaceId: string;
}
