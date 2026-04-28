import chalk from "chalk";
import { requireAuth } from "../auth.js";
import { callTool } from "../mcp.js";

/**
 * `forge issues list [--mine]` — backed by `issues.list` and
 * `issues.assigned` MCP tools. Output is a small column layout, mono
 * for IDs and short status badges.
 *
 * `forge issue assign <key> <profileKey>` — backed by `issues.assign`.
 */

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  status?: { name: string; category?: string } | null;
  priority?: number | null;
  assignedAgent?: { profileKey: string } | null;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

function priorityLabel(p: number | null | undefined): string {
  switch (p) {
    case 1:
      return "URGENT";
    case 2:
      return "HIGH";
    case 3:
      return "MED";
    case 4:
      return "LOW";
    case 5:
      return "—";
    default:
      return "?";
  }
}

function printRows(rows: IssueRow[]): void {
  if (!rows.length) {
    console.log(chalk.gray("  (no issues)"));
    return;
  }
  for (const r of rows) {
    const id = chalk.cyan(pad(r.identifier ?? r.id.slice(0, 8), 10));
    const status = pad((r.status?.name ?? "—").slice(0, 14), 14);
    const pri = pad(priorityLabel(r.priority), 6);
    const agent = pad(r.assignedAgent?.profileKey ?? "—", 12);
    const title = (r.title ?? "(untitled)").slice(0, 60);
    console.log(`  ${id} ${chalk.gray(status)} ${chalk.gray(pri)} ${chalk.gray(agent)} ${title}`);
  }
}

export async function issuesListCommand(opts: { mine?: boolean }): Promise<void> {
  const auth = await requireAuth();
  if (opts.mine) {
    const r = await callTool<IssueRow[]>(auth, "issues.assigned", {});
    if (r.isError) {
      console.error(chalk.red(r.text));
      process.exit(1);
    }
    console.log(chalk.bold(`Issues assigned to your linked agent`));
    console.log("");
    printRows(r.data ?? []);
    return;
  }

  const r = await callTool<IssueRow[] | { issues?: IssueRow[] }>(
    auth,
    "issues.list",
    { limit: 25, includeDone: false },
  );
  if (r.isError) {
    console.error(chalk.red(r.text));
    process.exit(1);
  }
  // issues.list returns an array directly; defensive shape check.
  const rows = Array.isArray(r.data)
    ? r.data
    : Array.isArray((r.data as { issues?: IssueRow[] })?.issues)
      ? (r.data as { issues: IssueRow[] }).issues
      : [];
  console.log(chalk.bold(`Issues (workspace=${auth.workspaceSlug}, limit=25)`));
  console.log("");
  printRows(rows);
}

export async function issueAssignCommand(
  key: string,
  profileKey: string,
): Promise<void> {
  const auth = await requireAuth();
  // issues.assign takes the issue id (cuid). The MCP tool accepts either
  // an id or an identifier on `issues.get`, but `issues.assign` wants
  // the id — so look up first if the user passed something that looks
  // like an identifier (e.g. AXI-42).
  let issueId = key;
  if (/^[A-Z]+-\d+$/.test(key)) {
    const lookup = await callTool<{ id: string }>(auth, "issues.list", {
      query: key,
      limit: 5,
      includeDone: true,
    });
    const arr = Array.isArray(lookup.data)
      ? (lookup.data as Array<{ identifier?: string; id: string }>)
      : [];
    const match = arr.find((i) => i.identifier === key);
    if (!match) {
      console.error(chalk.red(`could not resolve issue identifier ${key}`));
      process.exit(1);
    }
    issueId = match.id;
  }
  const r = await callTool(auth, "issues.assign", {
    id: issueId,
    profileKey,
  });
  if (r.isError) {
    console.error(chalk.red(r.text));
    process.exit(1);
  }
  console.log(chalk.green(`assigned ${key} → ${profileKey}`));
}
