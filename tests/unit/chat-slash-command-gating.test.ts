import { describe, it, expect } from "vitest";
import {
  matchSlashCommands,
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

  it("without ctx, all commands are returned (back-compat)", () => {
    expect(names("/")).toContain("skills");
    expect(names("/")).toContain("runtime");
  });
});
