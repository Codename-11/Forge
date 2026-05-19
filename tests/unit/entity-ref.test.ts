import { describe, expect, it } from "vitest";
import {
  FORGE_ENTITY_TOKEN_RE,
  FORGE_ENTITY_TYPES,
  entityRefKey,
  entityRefToToken,
  forgeEntityRefSchema,
  forgeEntityTypeSchema,
  parseEntityToken,
} from "@/lib/entity-ref";

describe("forge entity-ref schema", () => {
  it("enumerates the known entity types and stays in sync with the const list", () => {
    expect(FORGE_ENTITY_TYPES).toEqual(forgeEntityTypeSchema.options);
    // Spot-check a few — keep the catalogue stable across refactors.
    expect(FORGE_ENTITY_TYPES).toContain("issue");
    expect(FORGE_ENTITY_TYPES).toContain("artifact");
    expect(FORGE_ENTITY_TYPES).toContain("context-set");
    expect(FORGE_ENTITY_TYPES).toContain("execution-plan");
    expect(FORGE_ENTITY_TYPES).toContain("action-request");
  });

  it("validates a well-formed ref", () => {
    const parsed = forgeEntityRefSchema.parse({
      type: "issue",
      id: "cl0000000000000000000",
      workspaceId: "ws_abc",
      label: "AXI-42",
    });
    expect(parsed.type).toBe("issue");
    expect(parsed.id).toBe("cl0000000000000000000");
  });

  it("rejects an unknown type", () => {
    const result = forgeEntityRefSchema.safeParse({ type: "totally-fake", id: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty id", () => {
    const result = forgeEntityRefSchema.safeParse({ type: "issue", id: "" });
    expect(result.success).toBe(false);
  });

  it("makes deterministic (type:id) keys", () => {
    expect(entityRefKey({ type: "issue", id: "abc" })).toBe("issue:abc");
    expect(entityRefKey({ type: "artifact", id: "xyz" })).toBe("artifact:xyz");
  });

  it("round-trips ref ↔ token", () => {
    const ref = { type: "issue" as const, id: "cl0000000000000000000" };
    const token = entityRefToToken(ref);
    expect(token).toBe("forge:issue:cl0000000000000000000");
    expect(parseEntityToken(token)).toEqual({ type: "issue", id: "cl0000000000000000000" });
  });

  it("parses tokens with cuid-shaped ids", () => {
    const parsed = parseEntityToken("forge:artifact:abcdefghijklmnopqrstuv");
    expect(parsed).toEqual({ type: "artifact", id: "abcdefghijklmnopqrstuv" });
  });

  it("returns null for malformed tokens", () => {
    expect(parseEntityToken("not-a-token")).toBeNull();
    expect(parseEntityToken("forge:issue:")).toBeNull();
    expect(parseEntityToken("forge::abc")).toBeNull();
  });

  it("scans tokens in inline text", () => {
    const text =
      "see forge:issue:abcdefghijklmnopqrstuv and forge:artifact:0123456789abcdefghij for context";
    FORGE_ENTITY_TOKEN_RE.lastIndex = 0;
    const matches = [...text.matchAll(FORGE_ENTITY_TOKEN_RE)].map((m) => ({
      type: m[1],
      id: m[2],
    }));
    expect(matches).toEqual([
      { type: "issue", id: "abcdefghijklmnopqrstuv" },
      { type: "artifact", id: "0123456789abcdefghij" },
    ]);
  });
});
