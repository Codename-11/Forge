import os from "node:os";
import chalk from "chalk";
import { requireAuth } from "../auth.js";
import { callTool, validateToken, type AgentMe } from "../mcp.js";
import { readState } from "./state.js";

/**
 * `forge whoami` — confirms the saved token still works, prints the
 * linked agent (if any), and reports daemon registration status by
 * matching ~/.config/forge/daemon.json against this hostname.
 */
export async function whoamiCommand(): Promise<void> {
  const auth = await requireAuth();
  console.log(chalk.bold(`url:       `) + auth.url);
  console.log(chalk.bold(`workspace: `) + auth.workspaceSlug);

  const v = await validateToken(auth);
  if (!v.ok) {
    console.log(chalk.red(`token:     invalid (${v.reason})`));
    process.exit(1);
  }
  console.log(chalk.green(`token:     valid`));

  // agents.me: requires linkedAgentId on the key.
  const me = await callTool<AgentMe>(auth, "agents.me", {});
  if (!me.isError && me.data) {
    console.log(`agent:     ${me.data.profileKey} (${me.data.name})`);
    console.log(`provider:  ${me.data.provider}`);
    console.log(`mode:      ${me.data.runtimeMode}`);
    console.log(`status:    ${me.data.status}`);
  } else {
    console.log(chalk.gray(`agent:     (key has no linkedAgentId)`));
  }

  const state = await readState();
  const hostname = os.hostname();
  if (
    state &&
    state.url === auth.url &&
    state.workspaceSlug === auth.workspaceSlug &&
    state.hostname === hostname
  ) {
    console.log(`runtime:   ${state.runtimeId} (host=${hostname})`);
  } else {
    console.log(
      chalk.gray(`runtime:   not yet registered for this host (${hostname})`),
    );
  }
}
