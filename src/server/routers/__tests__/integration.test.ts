import { describe, it, expect, afterAll, afterEach } from "vitest";
import { integrationRouter } from "@/server/routers/integration";
import {
  createWorkspaceFixture,
  buildContext,
  disconnectPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});
afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "ITG" });
  fixtures.push(fixture);
  const caller = integrationRouter.createCaller(await buildContext(fixture));
  return { caller };
}

describe("integrationRouter.list (registry-backed)", () => {
  it("returns the canonical adapters with tier + chatMode, including the new ones", async () => {
    const { caller } = await setup();
    const rows = await caller.list();
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // Tier 1 managed runs adapters.
    expect(byKey.get("hermes")?.tier).toBe(1);
    expect(byKey.get("hermes")?.chatMode).toBe("runs");
    expect(byKey.get("codex-app-server")?.tier).toBe(1);
    expect(byKey.get("codex-app-server")?.managed).toBe(true);

    // Tier 2 session connections (incl. the shipped ACP adapter).
    expect(byKey.get("acp")?.tier).toBe(2);
    expect(byKey.get("acp")?.transport).toBe("acp");
    expect(byKey.get("codex")?.tier).toBe(2);

    // Tier 3 basic.
    expect(byKey.get("custom-http")?.tier).toBe(3);

    // Every row carries the fields the page renders.
    for (const r of rows) {
      expect(typeof r.title).toBe("string");
      expect([1, 2, 3]).toContain(r.tier);
      expect(["runs", "completions", "acp", "none"]).toContain(r.chatMode);
      expect(Array.isArray(r.agents)).toBe(true);
    }
  });

  it("a fresh workspace has no agents attached to any adapter", async () => {
    const { caller } = await setup();
    const rows = await caller.list();
    expect(rows.every((r) => r.agents.length === 0)).toBe(true);
  });
});
