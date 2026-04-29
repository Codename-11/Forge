import chalk from "chalk";
import { requireAuth } from "../auth.js";
import { callTool } from "../mcp.js";

/**
 * `forge agents list` — backed by the `agents.list` MCP tool. Filterable
 * by runtimeId for daemons enumerating their own roster. Adds a
 * `--json` flag for piping into other tools.
 */

interface AgentRow {
  id: string;
  profileKey: string;
  name: string;
  status: string;
  runtimeMode: string;
  provider: string;
  capabilities: string[];
  archivedAt: string | null;
  runtime: { id: string; name: string; kind: string } | null;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

export async function agentsListCommand(opts: {
  runtimeId?: string;
  archived?: boolean;
  json?: boolean;
}): Promise<void> {
  const auth = await requireAuth();
  const r = await callTool<AgentRow[]>(auth, "agents.list", {
    includeArchived: !!opts.archived,
    ...(opts.runtimeId ? { runtimeId: opts.runtimeId } : {}),
  });
  if (r.isError) {
    console.error(chalk.red(`agents.list failed: ${r.text}`));
    process.exit(1);
  }
  const rows = Array.isArray(r.data) ? r.data : [];

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(
    chalk.bold(
      `Agents (workspace=${auth.workspaceSlug}${opts.runtimeId ? `, runtime=${opts.runtimeId}` : ""})`,
    ),
  );
  console.log("");
  if (!rows.length) {
    console.log(chalk.gray(`  (no agents)`));
    return;
  }
  for (const a of rows) {
    const runtime = a.runtime ? `${a.runtime.kind}:${a.runtime.name}` : "—";
    const caps = a.capabilities?.length ? a.capabilities.join(",") : "—";
    console.log(
      `  ${chalk.cyan(pad(a.profileKey, 16))} ${pad(a.name, 24)} ${chalk.gray(pad(a.status, 8))} ${chalk.gray(pad(a.provider, 8))} ${chalk.gray(pad(a.runtimeMode, 12))} ${chalk.gray(`runtime=${runtime}`)}  ${chalk.gray(`caps=${caps}`)}`,
    );
  }
}
