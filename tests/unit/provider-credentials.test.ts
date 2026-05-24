import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  workspaceChatProviderAvailability,
  resolveWorkspaceProviderClient,
} from "@/server/services/ai-providers";
import { encryptSecret } from "@/server/crypto";

/**
 * DB-backed provider credentials let the Streaming engine work with no env
 * vars. These cover the precedence + availability logic with a light fake db
 * (the live Prisma path is exercised by integration tests).
 */
function fakeDb(rows: Array<Record<string, unknown>>): PrismaClient {
  return {
    providerCredential: {
      findMany: async () => rows.filter((r) => r.enabled && r.apiKeyEnc),
      findUnique: async ({ where }: { where: { workspaceId_providerId: { providerId: string } } }) =>
        rows.find((r) => r.providerId === where.workspaceId_providerId.providerId) ?? null,
    },
  } as unknown as PrismaClient;
}

describe("workspaceChatProviderAvailability", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("counts an enabled DB credential as available even with no env key", async () => {
    const db = fakeDb([
      { providerId: "openai", enabled: true, apiKeyEnc: encryptSecret("sk-x") },
    ]);
    const avail = await workspaceChatProviderAvailability(db, "ws1");
    expect(avail("openai")).toBe(true);
    expect(avail("anthropic")).toBe(false);
  });

  it("ignores a disabled or keyless credential", async () => {
    const db = fakeDb([
      { providerId: "openai", enabled: false, apiKeyEnc: encryptSecret("sk-x") },
      { providerId: "anthropic", enabled: true, apiKeyEnc: null },
    ]);
    const avail = await workspaceChatProviderAvailability(db, "ws1");
    expect(avail("openai")).toBe(false);
    expect(avail("anthropic")).toBe(false);
  });

  it("unions with env availability", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const db = fakeDb([]);
    const avail = await workspaceChatProviderAvailability(db, "ws1");
    expect(avail("anthropic")).toBe(true); // from env
  });
});

describe("resolveWorkspaceProviderClient", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("builds a client from a DB credential (no env key)", async () => {
    const db = fakeDb([
      {
        providerId: "openai",
        enabled: true,
        apiKeyEnc: encryptSecret("sk-db"),
        baseUrl: null,
        defaultModel: "gpt-4o",
      },
    ]);
    const ctx = await resolveWorkspaceProviderClient(db, "ws1", "openai");
    expect(ctx).not.toBeNull();
    expect(ctx!.providerId).toBe("openai");
    expect(ctx!.defaultModel).toBe("gpt-4o");
  });

  it("returns null when neither DB nor env is configured", async () => {
    const db = fakeDb([]);
    expect(await resolveWorkspaceProviderClient(db, "ws1", "openai")).toBeNull();
  });

  it("falls back to a custom credential's env when it lacks a base URL", async () => {
    // custom with no base URL is unusable → falls back to env getClient (also
    // unset here) → null, rather than throwing.
    const db = fakeDb([
      { providerId: "custom", enabled: true, apiKeyEnc: encryptSecret("k"), baseUrl: null },
    ]);
    expect(await resolveWorkspaceProviderClient(db, "ws1", "custom")).toBeNull();
  });
});
