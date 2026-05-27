import chalk from "chalk";
import { requireAuth } from "../auth.js";
import { callTool } from "../mcp.js";

/**
 * `forge agents list` — two views over the agent layering:
 *
 *  - default: per-workspace **bindings** (`Agent`), backed by `agents.list`.
 *    Filterable by runtimeId for daemons enumerating their own roster.
 *  - `--global`: the user-owned global **profiles** (`AgentProfile`), backed
 *    by `agents.profiles.list` — the definitions a workspace adopts by
 *    creating a binding. Shows owned + instance-shared profiles.
 *
 * `--json` emits the raw rows for piping.
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

interface ProfileRow {
  id: string;
  ownerId: string;
  profileKey: string;
  name: string;
  provider: string;
  runEngine: string | null;
  runtimeMode: string;
  role: string;
  baseCapabilities: string[];
  runtimeId: string | null;
  instanceShared: boolean;
  approvedAt: string | null;
  archivedAt: string | null;
  mine: boolean;
  _count?: { bindings: number };
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

export async function agentsListCommand(opts: {
  runtimeId?: string;
  archived?: boolean;
  json?: boolean;
  global?: boolean;
  mine?: boolean;
}): Promise<void> {
  const auth = await requireAuth();

  if (opts.global) {
    return profilesListCommand(opts);
  }

  // agents.list returns a list envelope { data: [...] }; tolerate a bare
  // array too for forward/back-compat.
  const r = await callTool<AgentRow[] | { data?: AgentRow[] }>(auth, "agents.list", {
    includeArchived: !!opts.archived,
    ...(opts.runtimeId ? { runtimeId: opts.runtimeId } : {}),
  });
  if (r.isError) {
    console.error(chalk.red(`agents.list failed: ${r.text}`));
    process.exit(1);
  }
  const rows = Array.isArray(r.data)
    ? r.data
    : Array.isArray((r.data as { data?: AgentRow[] })?.data)
      ? (r.data as { data: AgentRow[] }).data
      : [];

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(
    chalk.bold(
      `Agent bindings (workspace=${auth.workspaceSlug}${opts.runtimeId ? `, runtime=${opts.runtimeId}` : ""})`,
    ),
  );
  console.log(chalk.gray(`  (per-workspace Agent rows — run \`forge agents list --global\` for profiles)`));
  console.log("");
  if (!rows.length) {
    console.log(chalk.gray(`  (no agents)`));
    return;
  }
  for (const a of rows) {
    const runtime = a.runtime ? `${a.runtime.kind}:${a.runtime.name}` : "—";
    const caps = a.capabilities?.length ? a.capabilities.join(",") : "—";
    console.log(
      `  ${chalk.cyan(pad(a.profileKey, 16))} ${pad(a.name, 24)} ${chalk.gray(pad(a.status ?? "—", 8))} ${chalk.gray(pad(a.provider ?? "—", 8))} ${chalk.gray(pad(a.runtimeMode ?? "—", 12))} ${chalk.gray(`runtime=${runtime}`)}  ${chalk.gray(`caps=${caps}`)}`,
    );
  }
}

/**
 * `forge agents list --global` — global AgentProfile definitions, backed by
 * `agents.profiles.list`. Distinct from the workspace bindings above.
 */
async function profilesListCommand(opts: {
  archived?: boolean;
  json?: boolean;
  mine?: boolean;
}): Promise<void> {
  const auth = await requireAuth();
  // agents.profiles.list returns the list envelope { data, instanceRole },
  // not a bare array.
  const r = await callTool<{ data?: ProfileRow[]; instanceRole?: string | null }>(
    auth,
    "agents.profiles.list",
    {
      includeArchived: !!opts.archived,
      mine: !!opts.mine,
    },
  );
  if (r.isError) {
    console.error(chalk.red(`agents.profiles.list failed: ${r.text}`));
    process.exit(1);
  }
  const rows = Array.isArray(r.data?.data) ? r.data!.data : [];

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(
    chalk.bold(`Agent profiles (global${opts.mine ? ", mine only" : ", owned + instance-shared"})`),
  );
  console.log(chalk.gray(`  (user-owned AgentProfile definitions — bindings adopt these per workspace)`));
  console.log("");
  if (!rows.length) {
    console.log(chalk.gray(`  (no profiles visible to this key)`));
    return;
  }
  for (const p of rows) {
    const flags: string[] = [];
    if (p.mine) flags.push(chalk.green("mine"));
    else if (p.instanceShared) flags.push(chalk.yellow("shared"));
    if (!p.approvedAt) flags.push(chalk.red("pending"));
    if (p.archivedAt) flags.push(chalk.gray("archived"));
    const flagStr = flags.length ? ` ${flags.join(" ")}` : "";
    const caps = p.baseCapabilities?.length ? p.baseCapabilities.join(",") : "—";
    const bindings = p._count?.bindings ?? 0;
    console.log(
      `  ${chalk.cyan(pad(p.profileKey, 16))} ${pad(p.name, 24)} ${chalk.gray(pad(p.provider, 8))} ${chalk.gray(pad(p.runtimeMode, 12))} ${chalk.gray(`bindings=${bindings}`)}  ${chalk.gray(`caps=${caps}`)}${flagStr}`,
    );
  }
}
