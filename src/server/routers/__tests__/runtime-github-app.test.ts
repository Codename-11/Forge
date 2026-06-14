import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { RuntimeKind } from "@prisma/client";
import { generateKeyPairSync } from "node:crypto";
import { runtimeRouter } from "@/server/routers/runtime";
import { decryptSecret } from "@/server/crypto";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

// A real signable key — needed for the testGithubApp path (which signs a JWT).
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

afterEach(async () => {
  vi.unstubAllGlobals();
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup(keyPrefix: string) {
  const fixture = await createWorkspaceFixture({ keyPrefix });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const runtime = await getPrisma().runtime.create({
    data: {
      workspaceId: fixture.workspace.id,
      ownerId: fixture.user.id,
      name: "test runtime",
      kind: RuntimeKind.REMOTE_HTTP,
      adapterKey: "codex-app-server",
    },
    select: { id: true },
  });
  return { fixture, runtime, caller: runtimeRouter.createCaller(ctx) };
}

describe("runtime GitHub App", () => {
  it("stores app creds with a write-only private key and never returns the PEM", async () => {
    const { runtime, caller } = await setup("RGHA");
    const prisma = getPrisma();

    const saved = await caller.setGithubApp({
      runtimeId: runtime.id,
      appId: "123456",
      installationId: "42",
      slug: "forge-bot",
      privateKey: PEM,
    });
    expect(saved.appId).toBe("123456");
    expect(saved.installationId).toBe("42");
    expect(saved.slug).toBe("forge-bot");
    expect(saved).not.toHaveProperty("privateKey");
    expect(saved).not.toHaveProperty("privateKeyEnc");

    const got = await caller.getGithubApp({ runtimeId: runtime.id });
    expect(got?.appId).toBe("123456");
    expect(got).not.toHaveProperty("privateKey");
    expect(got).not.toHaveProperty("privateKeyEnc");

    // Ciphertext round-trips back to the PEM, and the PEM isn't stored raw.
    const row = await prisma.runtimeGithubApp.findUniqueOrThrow({
      where: { runtimeId: runtime.id },
      select: { privateKeyEnc: true },
    });
    expect(row.privateKeyEnc).not.toContain("PRIVATE KEY");
    // Input is trimmed (harmless — still signs); compare against the trimmed PEM.
    expect(decryptSecret(row.privateKeyEnc)).toBe(PEM.trim());
  });

  it("requires a private key on first set, then lets you keep it on update", async () => {
    const { runtime, caller } = await setup("RGHB");
    const prisma = getPrisma();

    await expect(
      caller.setGithubApp({ runtimeId: runtime.id, appId: "1", installationId: "2" }),
    ).rejects.toThrow(/private key is required/i);

    await caller.setGithubApp({
      runtimeId: runtime.id,
      appId: "1",
      installationId: "2",
      privateKey: PEM,
    });
    const before = await prisma.runtimeGithubApp.findUniqueOrThrow({
      where: { runtimeId: runtime.id },
      select: { privateKeyEnc: true },
    });

    // Update without a key keeps the stored ciphertext, changes other fields.
    const updated = await caller.setGithubApp({
      runtimeId: runtime.id,
      appId: "1",
      installationId: "99",
    });
    expect(updated.installationId).toBe("99");
    const after = await prisma.runtimeGithubApp.findUniqueOrThrow({
      where: { runtimeId: runtime.id },
      select: { privateKeyEnc: true },
    });
    expect(after.privateKeyEnc).toBe(before.privateKeyEnc);
  });

  it("rejects a non-PEM private key and a non-numeric app id", async () => {
    const { runtime, caller } = await setup("RGHC");
    await expect(
      caller.setGithubApp({
        runtimeId: runtime.id,
        appId: "123",
        installationId: "1",
        privateKey: "ghp_thats_a_token_not_a_key",
      }),
    ).rejects.toThrow(/PEM/i);
    await expect(
      caller.setGithubApp({
        runtimeId: runtime.id,
        appId: "not-numeric",
        installationId: "1",
        privateKey: PEM,
      }),
    ).rejects.toThrow();
  });

  it("deletes the app binding", async () => {
    const { runtime, caller } = await setup("RGHD");
    await caller.setGithubApp({
      runtimeId: runtime.id,
      appId: "1",
      installationId: "2",
      privateKey: PEM,
    });
    await caller.deleteGithubApp({ runtimeId: runtime.id });
    expect(await caller.getGithubApp({ runtimeId: runtime.id })).toBeNull();
  });

  it("does not let one workspace touch another's GitHub App", async () => {
    const a = await setup("RGHE");
    const b = await setup("RGHF");
    await a.caller.setGithubApp({
      runtimeId: a.runtime.id,
      appId: "1",
      installationId: "2",
      privateKey: PEM,
    });
    // B cannot read or mutate A's runtime app.
    await expect(b.caller.getGithubApp({ runtimeId: a.runtime.id })).rejects.toThrow(/not found/i);
    await expect(
      b.caller.setGithubApp({
        runtimeId: a.runtime.id,
        appId: "9",
        installationId: "9",
        privateKey: PEM,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("testGithubApp mints a token and stamps health (discovers slug)", async () => {
    const { runtime, caller } = await setup("RGHG");
    const prisma = getPrisma();
    await caller.setGithubApp({
      runtimeId: runtime.id,
      appId: "123456",
      installationId: "42",
      privateKey: PEM,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/app"))
          return new Response(JSON.stringify({ slug: "forge-bot", name: "Forge Bot" }), {
            status: 200,
          });
        if (url.endsWith("/access_tokens"))
          return new Response(
            JSON.stringify({
              token: "ghs_x",
              expires_at: "2026-06-14T18:00:00Z",
              repository_selection: "all",
            }),
            { status: 201 },
          );
        if (url.includes("/installation/repositories"))
          return new Response(
            JSON.stringify({ total_count: 2, repositories: [{ owner: { login: "acme" } }] }),
            { status: 200 },
          );
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const res = await caller.testGithubApp({ runtimeId: runtime.id });
    expect(res.account).toBe("acme");
    expect(res.repoCount).toBe(2);

    // Health stamped + slug backfilled.
    const row = await prisma.runtimeGithubApp.findUniqueOrThrow({
      where: { runtimeId: runtime.id },
      select: { lastMintedAt: true, lastError: true, slug: true },
    });
    expect(row.lastMintedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.slug).toBe("forge-bot");
  });

  it("testGithubApp records the error on a bad credential", async () => {
    const { runtime, caller } = await setup("RGHH");
    const prisma = getPrisma();
    await caller.setGithubApp({
      runtimeId: runtime.id,
      appId: "1",
      installationId: "2",
      privateKey: PEM,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 401 })),
    );
    await expect(caller.testGithubApp({ runtimeId: runtime.id })).rejects.toThrow();
    const row = await prisma.runtimeGithubApp.findUniqueOrThrow({
      where: { runtimeId: runtime.id },
      select: { lastError: true },
    });
    expect(row.lastError).toMatch(/401|credentials/i);
  });
});
