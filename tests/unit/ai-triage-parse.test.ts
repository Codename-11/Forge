import { describe, expect, it } from "vitest";
import { parseTriageMessage, runTriage } from "@/server/services/ai";
import type { ResolvedProviderClient } from "@/server/services/ai-providers";

const LABEL_BUG = "cmofy50kw0001o107hc8dzsft";
const LABEL_UI = "cmofy50kw0002o107aaaaaaaa";
const LABEL_HERMES = "cmofy50kw0003o107bbbbbbbb";
const AGENT_VICTOR = "cmagent0001victorxxxxxxxx";

const labels = [
  { id: LABEL_BUG, name: "Bug" },
  { id: LABEL_UI, name: "UI" },
  { id: LABEL_HERMES, name: "Hermes" },
];
const agents = [{ id: AGENT_VICTOR, profileKey: "victor", name: "Victor" }];

describe("parseTriageMessage", () => {
  it("parses a well-formed submit_triage tool call", () => {
    const message = {
      role: "assistant",
      tool_calls: [
        {
          type: "function",
          function: {
            name: "submit_triage",
            arguments: JSON.stringify({
              priority: "HIGH",
              label_ids: [LABEL_BUG],
              agent_id: AGENT_VICTOR,
              reasoning: "Clear regression with an owner.",
            }),
          },
        },
      ],
    };
    const out = parseTriageMessage(message, labels, agents);
    expect(out).toEqual({
      priority: "HIGH",
      labelIds: [LABEL_BUG],
      agentId: AGENT_VICTOR,
      reasoning: "Clear regression with an owner.",
    });
  });

  it("recovers the exact AXI-104 name-only recommendation without exposing tool failure prose", () => {
    const message = {
      role: "assistant",
      content:
        "Triage submission failed because the project tool reported “Unknown tool: submit_triage.” " +
        "Recommended triage: LOW priority; labels Bug and Hermes; assign Victor. " +
        "The issue is a scoped Hermes-Relay configuration bug with no stated outage or data-loss impact.",
    };
    const out = parseTriageMessage(message, labels, agents);
    expect(out).toEqual({
      priority: "LOW",
      labelIds: [LABEL_BUG, LABEL_HERMES],
      agentId: AGENT_VICTOR,
      reasoning:
        "The issue is a scoped Hermes-Relay configuration bug with no stated outage or data-loss impact.",
    });
  });

  it("falls back to labelled prose when a provider ignores tool_choice", () => {
    const message = {
      role: "assistant",
      content:
        "I couldn't submit the triage because the backend tool “submit_triage” " +
        "isn't available in this environment.\n\nRecommended triage:\n" +
        `Priority: LOW\nLabels: Bug (${LABEL_BUG})\nAgent: none\n\n` +
        "Reasoning: Pinned issues being hard to remove is a UI bug but shows no urgency.",
    };
    const out = parseTriageMessage(message, labels, agents);
    expect(out).not.toBeNull();
    expect(out!.priority).toBe("LOW");
    expect(out!.labelIds).toEqual([LABEL_BUG]);
    expect(out!.agentId).toBeNull();
    expect(out!.reasoning).toBe(
      "Pinned issues being hard to remove is a UI bug but shows no urgency.",
    );
  });

  it("maps structured label names and agent handles when a compatible model returns names", () => {
    const message = {
      role: "assistant",
      content: JSON.stringify({
        priority: "medium",
        label_ids: ["UI"],
        agent_id: "victor",
        reasoning: "A focused interface repair.",
      }),
    };
    expect(parseTriageMessage(message, labels, agents)).toEqual({
      priority: "MEDIUM",
      labelIds: [LABEL_UI],
      agentId: AGENT_VICTOR,
      reasoning: "A focused interface repair.",
    });
  });

  it("does not infer an assignment from an agent name used only in reasoning", () => {
    const message = {
      role: "assistant",
      content:
        "Priority: LOW. Labels: Bug. Reasoning: Victor reported the issue but ownership is unclear.",
    };
    expect(parseTriageMessage(message, labels, agents)?.agentId).toBeNull();
  });

  it("refuses ambiguous name-only agent matches", () => {
    const duplicateNames = [
      ...agents,
      { id: "cmagent0002victorxxxxxxxx", profileKey: "victor-2", name: "Victor" },
    ];
    const message = { role: "assistant", content: "Priority: HIGH. Assign Victor." };
    expect(parseTriageMessage(message, labels, duplicateNames)?.agentId).toBeNull();
  });

  it("parses a fenced JSON block embedded in content", () => {
    const message = {
      role: "assistant",
      content:
        "Here is my triage:\n```json\n" +
        JSON.stringify({
          priority: "MEDIUM",
          label_ids: [LABEL_UI],
          agent_id: null,
          reasoning: "Minor UI polish.",
        }) +
        "\n```",
    };
    expect(parseTriageMessage(message, labels, agents)).toMatchObject({
      priority: "MEDIUM",
      labelIds: [LABEL_UI],
      agentId: null,
    });
  });

  it("drops label/agent ids that aren't in the workspace", () => {
    const message = {
      role: "assistant",
      content:
        "Priority: HIGH. Labels: cmNOTAREALLABELxxxxxxxxxx. " +
        "Agent: cmNOTAREALAGENTxxxxxxxxxx. Reasoning: bogus ids.",
    };
    const out = parseTriageMessage(message, labels, agents);
    expect(out!.labelIds).toEqual([]);
    expect(out!.agentId).toBeNull();
  });

  it("returns null when the model refuses with no usable priority", () => {
    const message = {
      role: "assistant",
      content: "I can't submit the triage because the required submit_triage tool isn't available.",
    };
    expect(parseTriageMessage(message, labels, agents)).toBeNull();
  });

  it("returns null for an empty or contentless message", () => {
    expect(parseTriageMessage(undefined, labels, agents)).toBeNull();
    expect(parseTriageMessage({ role: "assistant", content: "" }, labels, agents)).toBeNull();
  });
});

describe("runTriage", () => {
  it("requests plain JSON from Hermes without registering a server-side tool", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = {
      providerId: "hermes",
      defaultModel: "test-model",
      supportsImageInput: true,
      client: {
        chat: {
          completions: {
            create: async (request: Record<string, unknown>) => {
              captured = request;
              return {
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: JSON.stringify({
                        priority: "LOW",
                        label_ids: [LABEL_BUG],
                        agent_id: AGENT_VICTOR,
                        reasoning: "Scoped bug.",
                      }),
                    },
                  },
                ],
              };
            },
          },
        },
      },
    } as unknown as ResolvedProviderClient;

    const result = await runTriage(provider, {
      title: "Hermes configuration bug",
      description: null,
      workspaceLabels: labels.map((label) => ({ ...label, color: "#000000" })),
      agents: agents.map((agent) => ({ ...agent, capabilities: ["hermes"] })),
    });

    expect(result?.agentId).toBe(AGENT_VICTOR);
    expect(captured).not.toHaveProperty("tools");
    expect(captured).not.toHaveProperty("tool_choice");
    expect(captured).toMatchObject({ model: "test-model" });
  });
});
