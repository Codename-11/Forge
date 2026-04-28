import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { writeAuth, type AuthFile } from "./auth.js";
import { validateToken } from "./mcp.js";

/**
 * v1 login: prompts for URL + workspace slug + bearer token (or accepts
 * them via flags). NO OAuth device-code flow — that's a planned follow-
 * up. Validates the token by issuing a `tools/call` MCP request and
 * persists everything to ~/.config/forge/auth.json (mode 600) on success.
 *
 * The token MUST be a Forge ApiKey (kind=AGENT, kind=PERSONAL, or
 * kind=SESSION). Mint one in Settings → API Keys (or via
 * `access.createSession` from a privileged context). Daemon use cases
 * want kind=AGENT with `linkedAgentId` set so chat dispatch and
 * `runs.recordUsage` can infer the agent automatically.
 */

export interface LoginOpts {
  url?: string;
  workspace?: string;
  token?: string;
  /** When --no-prompt is set, missing flags fail rather than asking. */
  prompt?: boolean;
}

export async function loginCommand(opts: LoginOpts): Promise<void> {
  const allowPrompt = opts.prompt !== false;
  let url = opts.url;
  let workspace = opts.workspace;
  let token = opts.token;

  if ((!url || !workspace || !token) && !allowPrompt) {
    throw new Error(
      "Missing --url / --workspace / --token and --no-prompt set; cannot continue.",
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    if (!url) url = await rl.question(`Forge URL [https://forge.axiom-labs.dev]: `);
    if (!url) url = "https://forge.axiom-labs.dev";
    url = url.trim().replace(/\/$/, "");

    if (!workspace) workspace = (await rl.question(`Workspace slug: `)).trim();
    if (!workspace) throw new Error("workspace slug is required");

    if (!token) token = (await rl.question(`API token: `)).trim();
    if (!token) throw new Error("token is required");
  } finally {
    rl.close();
  }

  console.log(chalk.gray(`validating token against ${url}...`));
  const v = await validateToken({ url, token });
  if (!v.ok) {
    throw new Error(`token validation failed: ${v.reason}`);
  }
  if (v.agent) {
    console.log(
      chalk.green(`  ✓ token valid (linked agent: ${v.agent.profileKey})`),
    );
  } else {
    console.log(chalk.green(`  ✓ token valid`));
  }

  const auth: AuthFile = {
    url,
    workspaceSlug: workspace,
    token,
  };
  await writeAuth(auth);
  console.log(chalk.green(`saved to ~/.config/forge/auth.json (mode 600)`));
}
