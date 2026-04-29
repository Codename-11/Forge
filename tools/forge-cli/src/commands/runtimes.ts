import chalk from "chalk";
import { requireAuth } from "../auth.js";
import { callTool } from "../mcp.js";
import { readState } from "./state.js";

/**
 * `forge runtimes list` — backed by the `runtimes.list` MCP tool. Renders
 * one row per Runtime with kind, name, providers, last heartbeat, agent
 * count. The local view (read from `daemon.json`) is annotated as
 * "(this host)" when it matches.
 */

interface RuntimeRow {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  providersAvailable: string[];
  heartbeatAt: string | null;
  connectedAt: string | null;
  archivedAt: string | null;
  ownerId: string | null;
  owner?: { id: string; name: string | null } | null;
  _count?: { agents: number };
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "?";
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export async function runtimesListCommand(opts: {
  json?: boolean;
  archived?: boolean;
}): Promise<void> {
  const auth = await requireAuth();
  const state = await readState();
  const localId =
    state &&
    state.url === auth.url &&
    state.workspaceSlug === auth.workspaceSlug
      ? state.runtimeId
      : null;

  const r = await callTool<RuntimeRow[]>(auth, "runtimes.list", {
    includeArchived: !!opts.archived,
  });
  if (r.isError) {
    console.error(chalk.red(`runtimes.list failed: ${r.text}`));
    process.exit(1);
  }
  const rows = Array.isArray(r.data) ? r.data : [];

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(chalk.bold(`Runtimes (workspace=${auth.workspaceSlug})`));
  console.log("");
  if (!rows.length) {
    console.log(
      chalk.gray(
        `  (no runtimes — run \`forge daemon start\` to register one for this host)`,
      ),
    );
    return;
  }
  for (const row of rows) {
    const tag = row.id === localId ? chalk.green(" (this host)") : "";
    const providers = row.providersAvailable?.length
      ? row.providersAvailable.join(",")
      : "—";
    const agents = row._count?.agents ?? 0;
    console.log(
      `  ${chalk.cyan(pad(row.id.slice(0, 8), 10))} ${chalk.gray(pad(row.kind, 14))} ${pad(row.name, 28)} ${chalk.gray(`hb=${relativeTime(row.heartbeatAt)}`)}  ${chalk.gray(`agents=${agents}`)}  ${chalk.gray(`providers=${providers}`)}${tag}`,
    );
  }
}
