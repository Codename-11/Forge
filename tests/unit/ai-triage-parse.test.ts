import { describe, expect, it } from "vitest";
import { parseTriageMessage } from "@/server/services/ai";

const LABEL_BUG = "cmofy50kw0001o107hc8dzsft";
const LABEL_UI = "cmofy50kw0002o107aaaaaaaa";
const AGENT_VICTOR = "cmagent0001victorxxxxxxxx";

const validLabels = new Set([LABEL_BUG, LABEL_UI]);
const validAgents = new Set([AGENT_VICTOR]);

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
    const out = parseTriageMessage(message, validLabels, validAgents);
    expect(out).toEqual({
      priority: "HIGH",
      labelIds: [LABEL_BUG],
      agentId: AGENT_VICTOR,
      reasoning: "Clear regression with an owner.",
    });
  });

  it("falls back to prose when the provider ignores tool_choice (the Hermes case)", () => {
    // Verbatim shape of what the Hermes gateway returned in prod: plain prose,
    // no tool call, but a usable recommendation that names the valid label id.
    const message = {
      role: "assistant",
      content:
        "I couldn't submit the triage because the backend tool “submit_triage” " +
        "isn't available in this environment.\n\nRecommended triage:\n" +
        `Priority: LOW\nLabels: Bug (${LABEL_BUG})\nAgent: none\n\n` +
        "Reasoning: Pinned issues being hard to remove is a UI bug but shows no urgency.",
    };
    const out = parseTriageMessage(message, validLabels, validAgents);
    expect(out).not.toBeNull();
    expect(out!.priority).toBe("LOW");
    expect(out!.labelIds).toEqual([LABEL_BUG]);
    expect(out!.agentId).toBeNull();
    expect(out!.reasoning).toContain("Pinned issues");
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
    const out = parseTriageMessage(message, validLabels, validAgents);
    expect(out).toMatchObject({
      priority: "MEDIUM",
      labelIds: [LABEL_UI],
      agentId: null,
    });
  });

  it("extracts a valid agent id mentioned in prose", () => {
    const message = {
      role: "assistant",
      content: `Priority: URGENT. Assign agent ${AGENT_VICTOR}. Reasoning: outage.`,
    };
    const out = parseTriageMessage(message, validLabels, validAgents);
    expect(out!.priority).toBe("URGENT");
    expect(out!.agentId).toBe(AGENT_VICTOR);
  });

  it("drops label/agent ids that aren't in the workspace", () => {
    const message = {
      role: "assistant",
      content:
        "Priority: HIGH. Labels: cmNOTAREALLABELxxxxxxxxxx. " +
        "Agent: cmNOTAREALAGENTxxxxxxxxxx. Reasoning: bogus ids.",
    };
    const out = parseTriageMessage(message, validLabels, validAgents);
    expect(out!.labelIds).toEqual([]);
    expect(out!.agentId).toBeNull();
  });

  it("returns null when the model refuses with no usable priority", () => {
    const message = {
      role: "assistant",
      content:
        "I can't submit the triage because the required submit_triage tool isn't available.",
    };
    expect(parseTriageMessage(message, validLabels, validAgents)).toBeNull();
  });

  it("returns null for an empty / contentless message", () => {
    expect(parseTriageMessage(undefined, validLabels, validAgents)).toBeNull();
    expect(
      parseTriageMessage({ role: "assistant", content: "" }, validLabels, validAgents),
    ).toBeNull();
  });
});
