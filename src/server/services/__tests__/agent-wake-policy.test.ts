import { describe, expect, it } from "vitest";
import {
  isActionableAssignedComment,
  isActionableExplicitMention,
  isActionablePriorityEscalation,
} from "@/server/services/agent-wake-policy";

describe("agent wake policy", () => {
  it("only treats upward moves into high or urgent as priority wakes", () => {
    expect(isActionablePriorityEscalation({ from: "MEDIUM", to: "HIGH" })).toBe(true);
    expect(isActionablePriorityEscalation({ from: "HIGH", to: "URGENT" })).toBe(true);
    expect(isActionablePriorityEscalation({ from: "HIGH", to: "LOW" })).toBe(false);
    expect(isActionablePriorityEscalation({ from: "URGENT", to: "HIGH" })).toBe(false);
    expect(isActionablePriorityEscalation({ from: "NONE", to: "MEDIUM" })).toBe(false);
  });

  it("separates human replies from self, agent, status, and system output", () => {
    const targetAgentId = "agent-victor";
    expect(
      isActionableAssignedComment({
        actorId: "user-bailey",
        actorAgentId: null,
        targetAgentId,
        payload: { kind: "BODY" },
      }),
    ).toBe(true);
    expect(
      isActionableAssignedComment({
        actorId: "key-owner",
        actorAgentId: targetAgentId,
        targetAgentId,
        payload: { kind: "BODY" },
      }),
    ).toBe(false);
    expect(
      isActionableAssignedComment({
        actorId: null,
        actorAgentId: null,
        targetAgentId,
        payload: { kind: "BODY" },
      }),
    ).toBe(false);
    expect(
      isActionableAssignedComment({
        actorId: "user-bailey",
        actorAgentId: null,
        targetAgentId,
        payload: { kind: "STATUS" },
      }),
    ).toBe(false);
  });

  it("requires an explicit mention for agent-to-agent wakes", () => {
    const base = {
      actorId: "key-owner",
      actorAgentId: "agent-coach",
      targetAgentId: "agent-victor",
    };
    expect(isActionableAssignedComment({ ...base, payload: { kind: "BODY" } })).toBe(false);
    expect(
      isActionableAssignedComment({
        ...base,
        payload: { kind: "BODY", mentions: { agentIds: ["agent-victor"] } },
      }),
    ).toBe(true);
    expect(
      isActionableExplicitMention({
        actorId: "key-owner",
        actorAgentId: "agent-victor",
        targetAgentId: "agent-victor",
        payload: { mentions: { agentIds: ["agent-victor"] } },
      }),
    ).toBe(false);
  });
});
