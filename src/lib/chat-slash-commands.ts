export interface SlashCommandContext {
  agent: {
    id: string;
    name: string;
    profileKey: string;
    runtimeMode: string;
    status: string;
    lastHeartbeatAt: Date | string | null;
    capabilities: string[];
    role: string;
  };
  thread: { id: string };
  workspaceSlug: string;
  /** Current chat engine for this agent (COMPLETIONS | RUNS), if known. */
  currentEngine?: string | null;
  /** Append a SYSTEM-role message to the current thread, locally (no server round-trip). */
  appendLocal: (body: string) => void;
  /** Clear the local message list (cosmetic — server data unchanged). */
  clearLocal: () => void;
  /** Send a structured prompt as if the user typed it. */
  sendPrompt: (body: string) => void;
  /** Request server-side compaction for the current conversation. */
  compactThread?: () => Promise<void> | void;
  /** Switch this agent's chat engine (admin only). */
  setEngine?: (engine: "COMPLETIONS" | "RUNS") => Promise<void> | void;
}

export interface SlashCommand {
  name: string; // canonical, leading slash NOT included
  aliases?: string[];
  description: string;
  category: "info" | "control" | "prompt";
  /** Optional usage hint shown in the autocomplete (e.g. "<KEY>"). */
  args?: string;
  /** When true, the command is dispatched as a structured prompt (not local). */
  promptDispatch?: boolean;
  /** Args parsed from after the command name (everything after first space). */
  run: (args: string, ctx: SlashCommandContext) => Promise<void> | void;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    aliases: ["?"],
    description: "List available commands.",
    category: "info",
    run: (_args, ctx) => {
      const lines = SLASH_COMMANDS.filter((c) => c.name !== "help").map(
        (c) => `- **/${c.name}${c.args ? ` ${c.args}` : ""}** — ${c.description}`,
      );
      ctx.appendLocal(
        `### Commands\n\n${lines.join("\n")}\n\n_Tip: type \`/\` to see this menu inline._`,
      );
    },
  },
  {
    name: "clear",
    description:
      "Clear the visible thread (server history unchanged; refresh to restore).",
    category: "control",
    run: (_args, ctx) => {
      ctx.clearLocal();
    },
  },
  {
    name: "info",
    description: "Show this agent's profile + presence.",
    category: "info",
    run: (_args, ctx) => {
      const a = ctx.agent;
      const seen = a.lastHeartbeatAt
        ? new Date(a.lastHeartbeatAt).toLocaleString()
        : "never";
      ctx.appendLocal(
        `### ${a.name} (@${a.profileKey})\n\n` +
          `- **status:** ${a.status}\n` +
          `- **runtime:** ${a.runtimeMode === "PERSISTENT" ? "persistent" : "session"}\n` +
          `- **role:** ${a.role}\n` +
          `- **capabilities:** ${a.capabilities.join(", ") || "_none_"}\n` +
          `- **last heartbeat:** ${seen}\n`,
      );
    },
  },
  {
    name: "agents",
    description: "List agents in this workspace.",
    category: "info",
    run: (_args, ctx) => {
      ctx.appendLocal(
        `Open the [Agents page](/w/${ctx.workspaceSlug}/agents) for the full list — or hit \`Mission Control → Agents\` (chord 3).`,
      );
    },
  },
  {
    name: "engine",
    description: "Show or switch this agent's chat engine.",
    args: "[completions|runs]",
    category: "control",
    run: async (args, ctx) => {
      const current = (ctx.currentEngine ?? "default").toLowerCase();
      const choice = args.trim().toLowerCase();
      if (!choice) {
        ctx.appendLocal(
          `**${ctx.agent.name}** is on the **${current}** engine.\n\n` +
            "- **completions** — Forge owns the loop (stateless, fast).\n" +
            "- **runs** — the agent runs as itself (memory + its own tools).\n\n" +
            "_Switch with_ `/engine runs` _or_ `/engine completions`.",
        );
        return;
      }
      if (choice !== "completions" && choice !== "runs") {
        ctx.appendLocal("_Usage:_ `/engine runs` or `/engine completions`.");
        return;
      }
      if (!ctx.setEngine) {
        ctx.appendLocal("_Switching the engine isn't available here (admin only)._");
        return;
      }
      try {
        await ctx.setEngine(choice.toUpperCase() as "COMPLETIONS" | "RUNS");
        ctx.appendLocal(`Switched **${ctx.agent.name}** to the **${choice}** engine.`);
      } catch (e) {
        ctx.appendLocal(`_Couldn't switch engine: ${e instanceof Error ? e.message : "error"}._`);
      }
    },
  },
  {
    name: "assign",
    description: "Ask this agent to take an issue: `/assign AXI-31`.",
    args: "<KEY>",
    category: "prompt",
    promptDispatch: true,
    run: (args, ctx) => {
      const key = args.trim();
      if (!key) {
        ctx.appendLocal("_Usage:_ `/assign AXI-31`");
        return;
      }
      ctx.sendPrompt(
        `Please take ownership of ${key}: assign it to yourself, review it, and start working it.`,
      );
    },
  },
  {
    name: "issue",
    description: "Look up an issue: `/issue AXI-31` (asks the agent to summarize).",
    args: "<KEY>",
    category: "prompt",
    promptDispatch: true,
    run: (args, ctx) => {
      const key = args.trim();
      if (!key) {
        ctx.appendLocal(`_Usage:_ \`/issue AXI-31\``);
        return;
      }
      ctx.sendPrompt(
        `Summarize ${key} — current status, blockers, recent activity.`,
      );
    },
  },
  {
    name: "status",
    description: "Ask the agent for a quick status of its current work.",
    category: "prompt",
    promptDispatch: true,
    run: (_args, ctx) => {
      ctx.sendPrompt(
        `What are you currently working on? Reply with a quick summary of active runs and any blockers.`,
      );
    },
  },
  {
    name: "summarize",
    description: "Ask the agent to summarize this conversation.",
    category: "prompt",
    promptDispatch: true,
    run: (_args, ctx) => {
      ctx.sendPrompt("Summarize this conversation: durable facts, decisions, blockers, and next actions.");
    },
  },
  {
    name: "compact",
    description: "Compact this conversation into Forge-owned summary context.",
    category: "control",
    run: async (_args, ctx) => {
      if (!ctx.compactThread) {
        ctx.appendLocal("_Compaction is not available in this surface._");
        return;
      }
      await ctx.compactThread();
      ctx.appendLocal("_Conversation compacted. Future agent context will include the summary plus recent messages._");
    },
  },
  {
    name: "hermes",
    description: "Safe Hermes bridge: `/hermes status`, `/hermes usage`, `/hermes skills`.",
    args: "<status|usage|skills>",
    category: "prompt",
    promptDispatch: true,
    run: (args, ctx) => {
      const allowed = new Set(["status", "usage", "skills"]);
      const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase();
      if (!subcommand || !allowed.has(subcommand)) {
        ctx.appendLocal("_Allowed Hermes commands:_ `/hermes status`, `/hermes usage`, `/hermes skills`.");
        return;
      }
      ctx.sendPrompt(`Run the safe Hermes ${subcommand} check for this Forge conversation and summarize the result.`);
    },
  },
];

const COMMAND_INDEX: Map<string, SlashCommand> = new Map();
for (const c of SLASH_COMMANDS) {
  COMMAND_INDEX.set(c.name, c);
  for (const a of c.aliases ?? []) COMMAND_INDEX.set(a, c);
}

export interface ParsedCommand {
  command: SlashCommand;
  args: string;
}

export function parseSlashCommand(input: string): ParsedCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  const name = (
    spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
  ).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const command = COMMAND_INDEX.get(name);
  if (!command) return null;
  return { command, args };
}

export function isSlashInput(input: string): boolean {
  const trimmed = input.trimStart();
  return trimmed.startsWith("/");
}

export function matchSlashCommands(input: string): SlashCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const fragment = trimmed.slice(1).split(" ")[0]?.toLowerCase() ?? "";
  if (!fragment) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (c) =>
      c.name.startsWith(fragment) ||
      (c.aliases ?? []).some((a) => a.startsWith(fragment)),
  );
}
