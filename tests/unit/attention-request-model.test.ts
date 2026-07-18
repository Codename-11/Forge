import { describe, expect, it } from "vitest";
import {
  safeAttentionActions,
  type AttentionAction,
  type AttentionRequestPresentation,
} from "@/components/action-requests/attention-request-model";

function action(id: string): AttentionAction {
  return {
    id,
    label: id,
    description: `${id} outcome`,
    tone: "NEUTRAL",
    requiresConfirmation: false,
    enabled: true,
    disabledReason: null,
  };
}

function presentation(protocol: string, actions: AttentionAction[]): AttentionRequestPresentation {
  return {
    category: "DECISION_REQUIRED",
    protocol,
    summary: null,
    replyTarget: null,
    actions,
    details: [],
    technicalDetails: [],
  };
}

describe("safeAttentionActions", () => {
  it("allows only registered delivery-conflict decisions", () => {
    const result = safeAttentionActions(
      presentation("DELIVERY_CONNECTION_CONFLICT", [
        action("JOIN_CONTRIBUTOR"),
        action("HANDOFF_PRIMARY"),
        action("DISMISS"),
        action("OPEN_ISSUE"),
        action("ARBITRARY_CLIENT_COMMAND"),
      ]),
    );

    expect(result.map((item) => item.id)).toEqual([
      "JOIN_CONTRIBUTOR",
      "HANDOFF_PRIMARY",
      "DISMISS",
      "OPEN_ISSUE",
    ]);
  });

  it("keeps generic responses narrow and rejects unknown commands", () => {
    const result = safeAttentionActions(
      presentation("SINGLE_DECISION", [
        action("ACCEPT"),
        action("DECLINE"),
        action("DISMISS"),
        action("RESPOND"),
        action("DELETE_WORKSPACE"),
      ]),
    );

    expect(result.map((item) => item.id)).toEqual(["ACCEPT", "DECLINE", "DISMISS", "RESPOND"]);
  });

  it("falls back safely when no presentation is registered", () => {
    expect(safeAttentionActions(null)).toEqual([]);
    expect(safeAttentionActions(undefined)).toEqual([]);
  });
});
