import chalk from "chalk";
import { requireAuth } from "../auth.js";
import { callTool, type AgentMe } from "../mcp.js";

/**
 * `forge agents list` — there's no `agents.list` MCP tool today, so we
 * can only reliably show the agent the calling key is linked to (via
 * agents.me). For the full workspace agent roster, the operator should
 * use the web UI at /w/<slug>/agents.
 */
export async function agentsListCommand(): Promise<void> {
  const auth = await requireAuth();
  const me = await callTool<AgentMe>(auth, "agents.me", {});

  console.log(chalk.bold(`Agents (linked to this token)`));
  console.log("");
  if (me.isError || !me.data) {
    console.log(
      chalk.gray(
        `  this token has no linkedAgentId. The web UI lists every agent in the workspace.`,
      ),
    );
  } else {
    const a = me.data;
    console.log(`  ${chalk.cyan(a.profileKey.padEnd(16))} ${a.name}`);
    console.log(
      chalk.gray(
        `    provider=${a.provider}  mode=${a.runtimeMode}  status=${a.status}`,
      ),
    );
    if (a.capabilities?.length) {
      console.log(chalk.gray(`    capabilities: ${a.capabilities.join(", ")}`));
    }
  }
  console.log("");
  console.log(
    chalk.gray(
      `(For the full workspace roster, visit ${auth.url}/w/${auth.workspaceSlug}/agents — there is no agents.list MCP tool yet.)`,
    ),
  );
}
