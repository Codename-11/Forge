import { describe, it, expect } from "vitest";
import {
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommandContext,
} from "@/lib/chat-slash-commands";

function ctx(provider: string): SlashCommandContext {
  return {
    agent: {
      id: "a1",
      name: "Agent",
      profileKey: "agent",
      runtimeMode: "PERSISTENT",
      status: "ONLINE",
      lastHeartbeatAt: null,
      capabilities: [],
      role: "",
    },
    thread: { id: "t1" },
    workspaceSlug: "ws",
    provider,
    appendLocal: () => {},
    clearLocal: () => {},
    sendPrompt: () => {},
  };
}

const names = (input: string, c?: SlashCommandContext) =>
  matchSlashCommands(input, c).map((cmd) => cmd.name);

describe("runtime/provider-aware slash commands", () => {
  it("hides Hermes-only commands for a non-Hermes agent", () => {
    const forCodex = names("/", ctx("CODEX"));
    expect(forCodex).not.toContain("skills");
    expect(forCodex).not.toContain("memory");
    expect(forCodex).not.toContain("hermes");
    // universal commands still present
    expect(forCodex).toContain("clear");
    expect(forCodex).toContain("new");
    expect(forCodex).toContain("compact");
    expect(forCodex).toContain("localclear");
    expect(forCodex).toContain("runtime");
    expect(forCodex).toContain("engine");
  });

  it("shows Hermes-only commands for a Hermes agent", () => {
    const forHermes = names("/", ctx("HERMES"));
    expect(forHermes).toContain("skills");
    expect(forHermes).toContain("memory");
    expect(forHermes).toContain("hermes");
  });

  it("filters by fragment AND availability", () => {
    expect(names("/sk", ctx("CODEX"))).not.toContain("skills");
    expect(names("/sk", ctx("HERMES"))).toContain("skills");
  });

  it("parses aliases for universal chat-control commands", () => {
    const forCodex = ctx("CODEX");
    expect(parseSlashCommand("/commands", forCodex)?.command.name).toBe("help");
    expect(parseSlashCommand("/reset", forCodex)?.command.name).toBe("clear");
    expect(parseSlashCommand("/newchat", forCodex)?.command.name).toBe("new");
    expect(parseSlashCommand("/summarize-context", forCodex)?.command.name).toBe("compact");
    expect(parseSlashCommand("/skills", forCodex)).toBeNull();
  });

  it("dispatches no-argument prompt commands as model prompts", async () => {
    const sent: string[] = [];
    const forHermes = { ...ctx("HERMES"), sendPrompt: (body: string) => sent.push(body) };

    await parseSlashCommand("/status", forHermes)?.command.run("", forHermes);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/currently working/i);
  });

  it("starts Hermes /new with a model-visible starter prompt", async () => {
    const prompts: Array<string | undefined> = [];
    const forHermes = {
      ...ctx("HERMES"),
      newConversation: (options?: { prompt?: string }) => {
        prompts.push(options?.prompt);
      },
    };

    await parseSlashCommand("/new", forHermes)?.command.run("", forHermes);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/fresh Hermes conversation/i);
  });

  it("keeps non-Hermes /new as a thread-control command only", async () => {
    const prompts: Array<string | undefined> = [];
    const forCodex = {
      ...ctx("CODEX"),
      newConversation: (options?: { prompt?: string }) => {
        prompts.push(options?.prompt);
      },
    };

    await parseSlashCommand("/new", forCodex)?.command.run("", forCodex);

    expect(prompts).toEqual([undefined]);
  });

  it("without ctx, all commands are returned (back-compat)", () => {
    expect(names("/")).toContain("skills");
    expect(names("/")).toContain("runtime");
  });
});
