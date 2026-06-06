#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loginCommand } from "./login.js";
import { whoamiCommand } from "./commands/whoami.js";
import {
  runtimesConfigureCommand,
  runtimesListCommand,
  runtimeToolCollector,
} from "./commands/runtimes.js";
import { agentsListCommand } from "./commands/agents.js";
import {
  issuesListCommand,
  issueAssignCommand,
} from "./commands/issues.js";
import { startDaemon, statusDaemon, stopDaemon } from "./daemon.js";

const program = new Command();

program
  .name("forge")
  .description(
    "Forge CLI — local daemon + read-only commands. See `forge daemon start` to host agents on this machine.",
  )
  .version("0.1.0");

// ---------------------------------------------------------------- login
program
  .command("login")
  .description(
    "Save URL + workspace slug + bearer token to ~/.config/forge/auth.json (mode 600).",
  )
  .option("--url <url>", "Forge instance URL (e.g. https://forge.axiom-labs.dev)")
  .option("--workspace <slug>", "Workspace slug (the URL segment in /w/<slug>)")
  .option("--token <token>", "Forge ApiKey (forge_sk_...)")
  .option("--no-prompt", "fail rather than prompting for missing values")
  .action(async (opts) => {
    try {
      await loginCommand(opts);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program
  .command("whoami")
  .description("Print the saved auth + linked agent + daemon registration state.")
  .action(async () => {
    try {
      await whoamiCommand();
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------- daemon
const daemon = program
  .command("daemon")
  .description("Local runtime daemon. Auto-detects CLIs, registers a Runtime, dispatches events.");

daemon
  .command("start")
  .description("Start the daemon (background by default; use --fg for foreground).")
  .option("--fg", "run in the foreground (don't detach; print events to stdout)")
  .action(async (opts) => {
    try {
      await startDaemon({ fg: !!opts.fg });
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

daemon
  .command("stop")
  .description("Send SIGTERM to the running daemon (PID file in ~/.config/forge/daemon.pid).")
  .action(async () => {
    try {
      await stopDaemon();
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

daemon
  .command("status")
  .description("Show daemon PID + saved auth + last-known runtime registration.")
  .action(async () => {
    try {
      await statusDaemon();
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------- listing
const runtimes = program
  .command("runtimes")
  .description("Runtime listing — backed by `runtimes.list` MCP.");
runtimes
  .command("list")
  .option("--json", "emit raw JSON instead of a table")
  .option("--archived", "include archived runtimes")
  .action(async (opts) => {
    try {
      await runtimesListCommand(opts);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });
runtimes
  .command("configure")
  .argument("<runtimeId>", "Runtime id to configure")
  .option("--local-workspace-tools", "declare that this runtime has local repo tools")
  .option("--tool <tool>", "declare a tool capability (terminal, filesystem, git); repeatable", runtimeToolCollector, [])
  .option("--workspace-root <path>", "workspace/repo root exposed to the runtime")
  .option("--replace", "replace config instead of merging with existing config")
  .option("--json", "emit raw JSON")
  .action(async (runtimeId, opts) => {
    try {
      await runtimesConfigureCommand(runtimeId, {
        json: opts.json,
        localWorkspaceTools: opts.localWorkspaceTools,
        tool: opts.tool,
        workspaceRoot: opts.workspaceRoot,
        replace: opts.replace,
      });
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

const agents = program
  .command("agents")
  .description(
    "Agent listing — workspace bindings (`agents.list`) or global profiles (`--global`, `agents.profiles.list`).",
  );
agents
  .command("list")
  .option("--json", "emit raw JSON instead of a table")
  .option("--archived", "include archived agents/profiles")
  .option("--runtime <id>", "filter bindings to a single runtime")
  .option("--global", "list global AgentProfile definitions instead of workspace bindings")
  .option("--mine", "with --global: only profiles you own (exclude instance-shared)")
  .action(async (opts) => {
    try {
      await agentsListCommand({
        json: opts.json,
        archived: opts.archived,
        runtimeId: opts.runtime,
        global: opts.global,
        mine: opts.mine,
      });
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

const issues = program
  .command("issues")
  .description("Issue listing.");
issues
  .command("list")
  .option("--mine", "show only issues assigned to your linked agent")
  .action(async (opts) => {
    try {
      await issuesListCommand(opts);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

const issue = program
  .command("issue")
  .description("Single-issue actions.");
issue
  .command("assign")
  .description("Assign an issue to an agent by profileKey.")
  .argument("<key>", "issue id (cuid) or identifier (e.g. AXI-42)")
  .argument("<profileKey>", "agent profileKey (e.g. victor)")
  .action(async (key: string, profileKey: string) => {
    try {
      await issueAssignCommand(key, profileKey);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
