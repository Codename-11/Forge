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
  adapterKey: string | null;
  endpoint: string | null;
  config?: unknown;
  providersAvailable: string[];
  heartbeatAt: string | null;
  connectedAt: string | null;
  archivedAt: string | null;
  ownerId: string | null;
  owner?: { id: string; name: string | null } | null;
  _count?: { agents: number };
}

interface RuntimeConfigureResult {
  id: string;
  name: string;
  adapterKey: string | null;
  config: unknown;
  updatedAt: string;
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

function configRecord(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function declaredTools(config: unknown, adapterKey: string | null): string[] {
  const c = configRecord(config);
  const tools = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.toLowerCase().replace(/[_\s]+/g, "-");
    if (["terminal", "filesystem", "git"].includes(normalized)) tools.add(normalized);
  };
  if (Array.isArray(c.toolCapabilities)) c.toolCapabilities.forEach(add);
  if (Array.isArray(c.tools)) c.tools.forEach(add);
  for (const key of ["terminal", "filesystem", "git"]) {
    if (c[key] === true) tools.add(key);
  }
  const workspaceRoot = typeof c.workspaceRoot === "string" && c.workspaceRoot.trim();
  if (c.localWorkspaceTools === true || adapterKey === "local-daemon" || (adapterKey === "codex-app-server" && workspaceRoot)) {
    tools.add("terminal");
    tools.add("filesystem");
    tools.add("git");
  }
  return ["terminal", "filesystem", "git"].filter((tool) => tools.has(tool));
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
    const tools = declaredTools(row.config, row.adapterKey);
    const toolText = tools.length ? tools.join(",") : "no-repo-tools";
    const modeTools =
      configRecord(row.config).modeToolPolicyEnforced === true
        ? "mode-tools=enforced"
        : "mode-tools=prompt-only";
    console.log(
      `  ${chalk.cyan(pad(row.id.slice(0, 8), 10))} ${chalk.gray(pad(row.kind, 14))} ${pad(row.name, 28)} ${chalk.gray(`hb=${relativeTime(row.heartbeatAt)}`)}  ${chalk.gray(`agents=${agents}`)}  ${chalk.gray(`providers=${providers}`)}  ${chalk.gray(`tools=${toolText}`)}  ${chalk.gray(modeTools)}${tag}`,
    );
  }
}

function collectTool(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export const runtimeToolCollector = collectTool;

export async function runtimesConfigureCommand(
  runtimeId: string,
  opts: {
    json?: boolean;
    localWorkspaceTools?: boolean;
    tool?: string[];
    workspaceRoot?: string;
    modeToolPolicyEnforced?: boolean;
    replace?: boolean;
  },
): Promise<void> {
  const auth = await requireAuth();
  const config: Record<string, unknown> = {};
  if (opts.localWorkspaceTools !== undefined) {
    config.localWorkspaceTools = !!opts.localWorkspaceTools;
  }
  if (opts.tool && opts.tool.length > 0) {
    config.toolCapabilities = opts.tool.map((tool) => tool.toLowerCase());
  }
  if (opts.workspaceRoot) {
    config.workspaceRoot = opts.workspaceRoot;
  }
  if (opts.modeToolPolicyEnforced !== undefined) {
    config.modeToolPolicyEnforced = !!opts.modeToolPolicyEnforced;
  }
  if (Object.keys(config).length === 0) {
    throw new Error(
      "Nothing to configure. Pass --local-workspace-tools, --tool, --workspace-root, or --mode-tool-policy-enforced.",
    );
  }

  const r = await callTool<RuntimeConfigureResult>(
    auth,
    "runtimes.configure",
    {
      runtimeId,
      config,
      merge: !opts.replace,
    },
  );
  if (r.isError || !r.data) {
    console.error(chalk.red(`runtimes.configure failed: ${r.text}`));
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  const tools = declaredTools(r.data.config, r.data.adapterKey);
  const root = configRecord(r.data.config).workspaceRoot;
  console.log(chalk.green(`Runtime configured: ${r.data.name} (${r.data.id})`));
  console.log(`  adapter: ${r.data.adapterKey ?? "unknown"}`);
  console.log(`  tools:   ${tools.length ? tools.join(", ") : "none declared"}`);
  console.log(
    `  mode tools: ${
      configRecord(r.data.config).modeToolPolicyEnforced === true ? "host-enforced" : "prompt-only"
    }`,
  );
  if (typeof root === "string" && root.trim()) {
    console.log(`  root:    ${root.trim()}`);
  }
}
