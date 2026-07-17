import { describe, expect, it } from "vitest";
import { resolveDeliveryIdentity } from "@/lib/delivery-identity";

describe("resolveDeliveryIdentity", () => {
  it("leads with the registered agent and keeps the operator as context", () => {
    expect(
      resolveDeliveryIdentity({
        source: "FORGE_AGENT",
        ownerUser: { name: "Bailey" },
        ownerAgent: { name: "Codex", profileKey: "codex" },
      }),
    ).toEqual({
      agentLabel: "Codex · @codex",
      operatorLabel: "Bailey",
      primaryLabel: "Codex · @codex",
      summary: "Agent · Operator Bailey",
    });
  });

  it("uses a registered connection agent when the legacy owner field is absent", () => {
    expect(
      resolveDeliveryIdentity({
        source: "MCP",
        ownerUser: { name: "Bailey" },
        ownerConnection: { agent: { name: "Codex", profileKey: "codex" } },
      }).agentLabel,
    ).toBe("Codex · @codex");
  });

  it("does not attribute an unregistered desktop client to its operator", () => {
    expect(
      resolveDeliveryIdentity({
        source: "CODEX_DESKTOP",
        ownerUser: { name: "Bailey" },
      }),
    ).toEqual({
      agentLabel: "Unregistered Codex Desktop client",
      operatorLabel: "Bailey",
      primaryLabel: "Unregistered Codex Desktop client",
      summary: "Agent identity unverified · Operator Bailey",
    });
  });

  it("marks an unregistered MCP client without inventing a profile", () => {
    expect(resolveDeliveryIdentity({ source: "MCP" })).toMatchObject({
      agentLabel: "Unregistered MCP client",
      operatorLabel: null,
      summary: "Agent identity unverified",
    });
  });

  it("shows a manual human claim as operator-owned work", () => {
    expect(resolveDeliveryIdentity({ source: "MANUAL", ownerUser: { name: "Bailey" } })).toEqual({
      agentLabel: null,
      operatorLabel: "Bailey",
      primaryLabel: "Bailey",
      summary: "Operator",
    });
  });

  it("keeps an unidentified contributor session unassigned", () => {
    expect(resolveDeliveryIdentity({ source: "CONTRIBUTOR" })).toEqual({
      agentLabel: null,
      operatorLabel: null,
      primaryLabel: "Unassigned",
      summary: null,
    });
  });
});
