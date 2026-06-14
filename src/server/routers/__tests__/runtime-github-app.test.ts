import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { RuntimeKind } from "@prisma/client";
import { generateKeyPairSync } from "node:crypto";
import { runtimeRouter } from "@/server/routers/runtime";
import { githubAppRouter } from "@/server/routers/github-app";
import { decryptSecret } from "@/server/crypto";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

// A real signable key — needed for the test (verify) path which signs a JWT.
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
  return {
    fixture,
    runtime,
    apps: githubAppRouter.createCaller(ctx),
    runtimes: runtimeRouter.createCaller(ctx),
  };
}

describe("workspace GitHub App router", () => {
  it("creates an app with a write-only key and never returns the PEM", async () => {
    const { apps } = await setup("GHA");
    const prisma = getPrisma();

    const created = await apps.createManual({
      name: "Axiom Bot",
      appId: "123456",
      installationId: "42",
      slug: "axiom-bot",
      privateKey: PEM,
    });
    expect(created.name).toBe("Axiom Bot");
    expect(created).not.toHaveProperty("privateKey");
    expect(created).not.toHaveProperty("privateKeyEnc");

    const listed = await apps.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].installed).toBe(true);
    expect(listed[0].runtimeCount).toBe(0);
    expect(listed[0]).not.toHaveProperty("privateKeyEnc");

    const row = await prisma.githubApp.findFirstOrThrow({
      where: { appId: "123456" },
      select: { privateKeyEnc: true },
    });
    expect(row.privateKeyEnc).not.toContain("PRIVATE KEY");
    expect(decryptSecret(row.privateKeyEnc)).toBe(PEM.trim());
  });

  it("update keeps the stored key when privateKey is omitted", async () => {
    const { apps } = await setup("GHB");
    const prisma = getPrisma();
    const created = await apps.createManual({
      name: "A",
      appId: "1",
      installationId: "2",
      privateKey: PEM,
    });
    const before = await prisma.githubApp.findFirstOrThrow({
      where: { id: created.id },
      select: { privateKeyEnc: true },
    });
    const updated = await apps.update({ id: created.id, installationId: "99" });
    expect(updated.installationId).toBe("99");
    const after = await prisma.githubApp.findFirstOrThrow({
      where: { appId: "1" },
      select: { privateKeyEnc: true },
    });
    expect(after.privateKeyEnc).toBe(before.privateKeyEnc);
  });

  it("rejects a non-PEM key and a non-numeric app id", async () => {
    const { apps } = await setup("GHC");
    await expect(
      apps.createManual({ name: "x", appId: "1", installationId: "2", privateKey: "ghp_token" }),
    ).rejects.toThrow(/PEM/i);
    await expect(
      apps.createManual({ name: "x", appId: "nope", installationId: "2", privateKey: PEM }),
    ).rejects.toThrow();
  });

  it("isolates apps across workspaces", async () => {
    const a = await setup("GHD");
    const b = await setup("GHE");
    const created = await a.apps.createManual({
      name: "A app",
      appId: "1",
      installationId: "2",
      privateKey: PEM,
    });
    const id = (await a.apps.list())[0].id;
    expect(await b.apps.get({ id })).toBeNull();
    await expect(b.apps.update({ id, name: "hijack" })).rejects.toThrow(/not found/i);
    await expect(b.apps.delete({ id })).rejects.toThrow(/not found/i);
    expect(created.name).toBe("A app");
  });

  it("test mints a token, stamps health, and backfills the slug", async () => {
    const { apps } = await setup("GHF");
    const prisma = getPrisma();
    await apps.createManual({ name: "x", appId: "123456", installationId: "42", privateKey: PEM });
    const id = (await apps.list())[0].id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/app"))
          return new Response(JSON.stringify({ slug: "discovered-slug" }), { status: 200 });
        if (url.endsWith("/access_tokens"))
          return new Response(
            JSON.stringify({ token: "ghs_x", expires_at: "2026-06-14T18:00:00Z", repository_selection: "all" }),
            { status: 201 },
          );
        if (url.includes("/installation/repositories"))
          return new Response(
            JSON.stringify({ total_count: 4, repositories: [{ owner: { login: "acme" } }] }),
            { status: 200 },
          );
        throw new Error(`unexpected url ${url}`);
      }),
    );
    const res = await apps.test({ id });
    expect(res.account).toBe("acme");
    expect(res.repoCount).toBe(4);

    const row = await prisma.githubApp.findFirstOrThrow({
      where: { id },
      select: { lastMintedAt: true, lastError: true, slug: true },
    });
    expect(row.lastMintedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.slug).toBe("discovered-slug");
  });

  it("test refuses an app that isn't installed yet", async () => {
    const { apps, fixture } = await setup("GHG");
    const created = await getPrisma().githubApp.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "uninstalled",
        appId: "1",
        privateKeyEnc: "x", // never decrypted — install check fails first
      },
      select: { id: true },
    });
    await expect(apps.test({ id: created.id })).rejects.toThrow(/install/i);
  });
});

describe("runtime ↔ GitHub App link", () => {
  it("links a runtime to a workspace app and reads it back; unlink with null", async () => {
    const { apps, runtimes, runtime } = await setup("GHL");
    await apps.createManual({ name: "x", appId: "55", installationId: "66", privateKey: PEM });
    const appId = (await apps.list())[0].id;

    await runtimes.linkGithubApp({ runtimeId: runtime.id, githubAppId: appId });
    const linked = await runtimes.getGithubApp({ runtimeId: runtime.id });
    expect(linked?.appId).toBe("55");
    expect(linked?.installationId).toBe("66");
    expect(linked).not.toHaveProperty("privateKeyEnc");

    await runtimes.linkGithubApp({ runtimeId: runtime.id, githubAppId: null });
    expect(await runtimes.getGithubApp({ runtimeId: runtime.id })).toBeNull();
  });

  it("refuses to link an app from another workspace", async () => {
    const a = await setup("GHM");
    const b = await setup("GHN");
    await b.apps.createManual({ name: "b", appId: "1", installationId: "2", privateKey: PEM });
    const bAppId = (await b.apps.list())[0].id;
    await expect(
      a.runtimes.linkGithubApp({ runtimeId: a.runtime.id, githubAppId: bAppId }),
    ).rejects.toThrow(/not found/i);
  });
});
