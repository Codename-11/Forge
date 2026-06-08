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
  /** Agent provider (HERMES | CLAUDE | CODEX | CUSTOM) — gates provider-specific commands. */
  provider?: string | null;
  /** How this agent's chat is actually served (from chatReadiness). */
  transport?: { mode: string; label: string } | null;
  /** Append a SYSTEM-role message to the current thread, locally (no server round-trip). */
  appendLocal: (body: string) => void;
  /** Clear the local SYSTEM messages emitted by slash commands. */
  clearLocal: () => void;
  /** Clear the current conversation on the server. */
  clearThread?: () => Promise<void> | void;
  /** Start a fresh conversation with the current agent. */
  newConversation?: (options?: { prompt?: string }) => Promise<void> | void;
  /** Send a structured prompt as if the user typed it. */
  sendPrompt: (body: string) => void;
  /** Request server-side compaction for the current conversation. */
  compactThread?: () => Promise<void> | void;
  /** Switch this agent's chat engine (admin only). */
  setEngine?: (engine: "COMPLETIONS" | "RUNS") => Promise<void> | void;
  /** Fetch live Hermes gateway data (skills/memory/health) as markdown. */
  hermesInfo?: (resource: "skills" | "memory" | "health") => Promise<string>;
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
  /**
   * Optional gate — when present and it returns false for the current agent,
   * the command is hidden from `/help` + autocomplete and rejected on run.
   * Used to make the command set runtime/provider-aware (e.g. Hermes-only
   * skills/memory). Omitted ⇒ always available.
   */
  available?: (ctx: SlashCommandContext) => boolean;
  /** Args parsed from after the command name (everything after first space). */
  run: (args: string, ctx: SlashCommandContext) => Promise<void> | void;
}

/** Commands that only make sense for a Hermes-backed agent. */
const isHermes = (ctx: SlashCommandContext) => ctx.provider === "HERMES";

const HERMES_NEW_CONVERSATION_PROMPT =
  "Start a fresh Hermes conversation in this new Forge thread. Reply with a short acknowledgement that the new chat is ready, mention any current page/context you can see, and ask what to work on next.";

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    aliases: ["?", "commands"],
    description: "List available commands.",
    category: "info",
    run: (_args, ctx) => {
      const lines = SLASH_COMMANDS.filter(
        (c) => c.name !== "help" && (!c.available || c.available(ctx)),
      ).map((c) => `- **/${c.name}${c.args ? ` ${c.args}` : ""}** — ${c.description}`);
      ctx.appendLocal(
        `### Commands\n\n${lines.join("\n")}\n\n_Tip: type \`/\` to see this menu inline._`,
      );
    },
  },
  {
    name: "clear",
    aliases: ["reset"],
    description: "Clear this conversation's messages and summary context.",
    category: "control",
    run: async (_args, ctx) => {
      if (!ctx.clearThread) {
        ctx.clearLocal();
        ctx.appendLocal("_Only local slash-command messages were cleared in this surface._");
        return;
      }
      await ctx.clearThread();
      ctx.clearLocal();
      ctx.appendLocal(
        "_Conversation cleared. Server history and summary context for this thread were reset._",
      );
    },
  },
  {
    name: "localclear",
    aliases: ["clear-local"],
    description: "Clear only local slash-command output.",
    category: "control",
    run: (_args, ctx) => {
      ctx.clearLocal();
    },
  },
  {
    name: "new",
    aliases: ["newchat", "conversation"],
    description: "Start a fresh conversation with this agent.",
    category: "control",
    run: async (_args, ctx) => {
      if (!ctx.newConversation) {
        ctx.appendLocal("_Starting a new conversation isn't available in this surface._");
        return;
      }
      await ctx.newConversation({
        prompt: isHermes(ctx) ? HERMES_NEW_CONVERSATION_PROMPT : undefined,
      });
    },
  },
  {
    name: "info",
    description: "Show this agent's profile + presence.",
    category: "info",
    run: (_args, ctx) => {
      const a = ctx.agent;
      const seen = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).toLocaleString() : "never";
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
    name: "runtime",
    description: "Show how this agent's chat is served (engine + runtime/transport).",
    category: "info",
    run: (_args, ctx) => {
      const t = ctx.transport;
      const engine = (ctx.currentEngine ?? "default").toLowerCase();
      if (!t) {
        ctx.appendLocal(
          `**${ctx.agent.name}** · provider ${ctx.provider ?? "?"} · engine ${engine}.\n\n` +
            "_Transport detail isn't available in this surface._",
        );
        return;
      }
      const how =
        t.mode === "runs"
          ? `**Runs** — \`${t.label}\` owns the loop; the agent answers as itself (its own memory + tools).`
          : t.mode === "completions"
            ? `**Streaming** — Forge runs a stateless loop against \`${t.label}\`.`
            : t.mode === "dispatch"
              ? `**Dispatch** — served by the agent's \`${t.label}\` (its runtime/daemon replies via chat drafts; ensure it's running).`
              : "**Not chat-capable** — no model or runtime can serve a turn yet.";
      ctx.appendLocal(
        `### ${ctx.agent.name} — chat transport\n\n` +
          `- **provider:** ${ctx.provider ?? "?"}\n` +
          `- **engine:** ${engine}\n` +
          `- **served via:** ${how}\n`,
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
      ctx.sendPrompt(`Summarize ${key} — current status, blockers, recent activity.`);
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
      ctx.sendPrompt(
        "Summarize this conversation: durable facts, decisions, blockers, and next actions.",
      );
    },
  },
  {
    name: "compact",
    aliases: ["summarize-context"],
    description: "Compact this conversation into Forge-owned summary context.",
    category: "control",
    run: async (_args, ctx) => {
      if (!ctx.compactThread) {
        ctx.appendLocal("_Compaction is not available in this surface._");
        return;
      }
      await ctx.compactThread();
      ctx.appendLocal(
        "_Conversation compacted. Future agent context will include the summary plus recent messages._",
      );
    },
  },
  {
    name: "skills",
    description: "List this agent's live Hermes skills.",
    category: "info",
    available: isHermes,
    run: async (_args, ctx) => {
      if (!ctx.hermesInfo) {
        ctx.appendLocal("_Live skills aren't available here._");
        return;
      }
      ctx.appendLocal(await ctx.hermesInfo("skills"));
    },
  },
  {
    name: "memory",
    description: "Show this agent's live Hermes memory.",
    category: "info",
    available: isHermes,
    run: async (_args, ctx) => {
      if (!ctx.hermesInfo) {
        ctx.appendLocal("_Live memory isn't available here._");
        return;
      }
      ctx.appendLocal(await ctx.hermesInfo("memory"));
    },
  },
  {
    name: "hermes",
    description: "Hermes bridge: `/hermes status` (live), `/hermes usage` (asks the agent).",
    args: "<status|usage>",
    category: "info",
    available: isHermes,
    run: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase();
      if (sub === "status") {
        if (!ctx.hermesInfo) {
          ctx.appendLocal("_Live status isn't available here._");
          return;
        }
        ctx.appendLocal(await ctx.hermesInfo("health"));
        return;
      }
      if (sub === "usage") {
        // No gateway API for usage — ask the agent to run its own check.
        ctx.sendPrompt(
          "Run the safe Hermes usage check for this conversation and summarize the token usage.",
        );
        return;
      }
      ctx.appendLocal(
        "_Usage:_ `/hermes status` (live gateway health) · `/hermes usage` (agent token report). " +
          "See also `/skills` and `/memory`.",
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

export function slashCommandAvailable(command: SlashCommand, ctx?: SlashCommandContext): boolean {
  return !command.available || !ctx || command.available(ctx);
}

export function parseSlashCommand(input: string, ctx?: SlashCommandContext): ParsedCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const command = COMMAND_INDEX.get(name);
  if (!command) return null;
  if (!slashCommandAvailable(command, ctx)) return null;
  return { command, args };
}

export function isSlashInput(input: string): boolean {
  const trimmed = input.trimStart();
  return trimmed.startsWith("/");
}

export function matchSlashCommands(input: string, ctx?: SlashCommandContext): SlashCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const available = (c: SlashCommand) => slashCommandAvailable(c, ctx);
  const fragment = trimmed.slice(1).split(" ")[0]?.toLowerCase() ?? "";
  if (!fragment) return SLASH_COMMANDS.filter(available);
  return SLASH_COMMANDS.filter(
    (c) =>
      available(c) &&
      (c.name.startsWith(fragment) || (c.aliases ?? []).some((a) => a.startsWith(fragment))),
  );
}
