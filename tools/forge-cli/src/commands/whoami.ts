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

  // agents.me: requires linkedAgentId on the key. Carries the owning
  // user's instanceRole; capture it so we can report the role even when
  // there's no linked agent (fallback below).
  let instanceRole: string | null = null;
  const me = await callTool<AgentMe>(auth, "agents.me", {});
  if (!me.isError && me.data) {
    instanceRole = me.data.instanceRole ?? null;
    console.log(`agent:     ${me.data.profileKey} (${me.data.name})`);
    console.log(`provider:  ${me.data.provider}`);
    console.log(`mode:      ${me.data.runtimeMode}`);
    console.log(`status:    ${me.data.status}`);
    if (me.data.profileId) console.log(`profile:   ${me.data.profileId}`);
  } else {
    console.log(chalk.gray(`agent:     (key has no linkedAgentId)`));
  }

  // instanceRole: surface the user's role even without a linked agent.
  // `agents.profiles.list` returns it alongside the global profiles the
  // key can see.
  if (instanceRole === null) {
    const profiles = await callTool<unknown>(auth, "agents.profiles.list", {});
    if (!profiles.isError && profiles.text) {
      try {
        const parsed = JSON.parse(profiles.text) as {
          instanceRole?: string | null;
          data?: unknown[];
        };
        instanceRole = parsed.instanceRole ?? null;
        const count = Array.isArray(parsed.data) ? parsed.data.length : 0;
        console.log(chalk.gray(`profiles:  ${count} visible (\`forge agents list --global\`)`));
      } catch {
        // non-JSON; ignore
      }
    }
  }
  if (instanceRole) {
    console.log(`role:      ${instanceRole}`);
  } else {
    console.log(chalk.gray(`role:      (unknown — key has no owning user)`));
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
