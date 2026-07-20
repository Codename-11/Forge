import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentConnectionIdSchema, agentIdSchema } from "@/server/validators";

/**
 * Regression guard: agents are NOT always Prisma cuids. Hermes-seeded
 * agents (Victor, Mizu) keep hex handles that `z.string().cuid()`
 * rejects — which silently broke crew membership, goal planner
 * assignment, and step assignment. These IDs MUST validate.
 */
describe("agentIdSchema", () => {
  it("accepts non-cuid hex agent handles (the bug that shipped)", () => {
    const hexIds = [
      "6ea973a47af8fd626d298823d", // Victor
      "b4f8cf5fe57b40e6a8be27c31", // Mizu
    ];
    for (const id of hexIds) {
      expect(agentIdSchema.safeParse(id).success).toBe(true);
      // The schema must be strictly more permissive than .cuid() here.
      expect(z.string().cuid().safeParse(id).success).toBe(false);
    }
  });

  it("still accepts classic cuids", () => {
    expect(agentIdSchema.safeParse("cmohnxz9h0001n407mytknqgv").success).toBe(true);
  });

  it("rejects empty, overlong, and unsafe strings", () => {
    expect(agentIdSchema.safeParse("").success).toBe(false);
    expect(agentIdSchema.safeParse("a".repeat(41)).success).toBe(false);
    expect(agentIdSchema.safeParse("has spaces").success).toBe(false);
    expect(agentIdSchema.safeParse("drop;table").success).toBe(false);
  });
});

describe("agentConnectionIdSchema", () => {
  it("accepts both historical backfill ids and current cuids", () => {
    expect(
      agentConnectionIdSchema.safeParse("ac_269a426f3d6cf83523c051e35f1adf93").success,
    ).toBe(true);
    expect(agentConnectionIdSchema.safeParse("cmohnxz9h0001n407mytknqgv").success).toBe(true);
  });

  it("rejects empty, overlong, and unsafe identifiers", () => {
    expect(agentConnectionIdSchema.safeParse("").success).toBe(false);
    expect(agentConnectionIdSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(agentConnectionIdSchema.safeParse("connection/id").success).toBe(false);
    expect(agentConnectionIdSchema.safeParse("connection id").success).toBe(false);
  });
});
