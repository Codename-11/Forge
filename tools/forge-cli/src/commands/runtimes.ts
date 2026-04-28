import os from "node:os";
import chalk from "chalk";
import { requireAuth } from "../auth.js";
import { callTool } from "../mcp.js";
import { readState } from "./state.js";

/**
 * `forge runtimes list` — best-effort. There is no `runtimes.list` MCP
 * tool today (Stream A only shipped register/heartbeat). The web UI's
 * `/settings/runtimes` page goes through the tRPC `runtime.list`
 * procedure which requires a NextAuth session, not an API key — so we
 * can't reach it from the CLI.
 *
 * For v1 we just print whatever the daemon stored locally + a reminder
 * to use the web UI for the full list. Once a `runtimes.list` MCP tool
 * lands this command becomes a real listing.
 */
export async function runtimesListCommand(): Promise<void> {
  const auth = await requireAuth();
  const state = await readState();
  const hostname = os.hostname();

  console.log(chalk.bold(`Runtimes (local view)`));
  console.log(chalk.gray(`workspace: ${auth.workspaceSlug}`));
  console.log("");

  if (
    state &&
    state.url === auth.url &&
    state.workspaceSlug === auth.workspaceSlug
  ) {
    console.log(`  ${chalk.cyan(state.runtimeId)}  ${state.hostname}  (this host)`);
    // Try a heartbeat probe so we can show liveness.
    const hb = await callTool<{ id: string; heartbeatAt: string }>(
      auth,
      "runtimes.heartbeat",
      { runtimeId: state.runtimeId },
    );
    if (!hb.isError && hb.data?.heartbeatAt) {
      console.log(
        chalk.gray(`     last heartbeat: ${hb.data.heartbeatAt}`),
      );
    } else {
      console.log(
        chalk.yellow(`     warning: heartbeat probe failed (${hb.text})`),
      );
    }
  } else {
    console.log(
      chalk.gray(
        `  no runtime registered for this host (${hostname}). Run \`forge daemon start\` to register one.`,
      ),
    );
  }

  console.log("");
  console.log(
    chalk.gray(
      `(For the full multi-host runtime list, visit ${auth.url}/w/${auth.workspaceSlug}/settings/runtimes — there is no runtimes.list MCP tool yet.)`,
    ),
  );
}
