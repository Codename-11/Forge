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
  /** Append a SYSTEM-role message to the current thread, locally (no server round-trip). */
  appendLocal: (body: string) => void;
  /** Clear the local message list (cosmetic — server data unchanged). */
  clearLocal: () => void;
  /** Send a structured prompt as if the user typed it. */
  sendPrompt: (body: string) => void;
}

export interface SlashCommand {
  name: string; // canonical, leading slash NOT included
  aliases?: string[];
  description: string;
  category: "info" | "control" | "prompt";
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
        (c) => `- **/${c.name}** — ${c.description}`,
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
    name: "issue",
    description: "Look up an issue: `/issue AXI-31` (asks the agent to summarize).",
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
