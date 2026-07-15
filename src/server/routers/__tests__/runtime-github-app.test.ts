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
  vi.unstubAllEnvs();
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

  it("configures a signed webhook without returning its secret", async () => {
    const { apps } = await setup("GHW");
    const prisma = getPrisma();
    const created = await apps.createManual({
      name: "Webhook App",
      appId: "1234567",
      installationId: "7654321",
      privateKey: PEM,
      slug: "webhook-app",
    });
    vi.stubEnv("AUTH_URL", "https://forge.example");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.github.com/app/hook/config") {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.url).toBe("https://forge.example/api/ingest/github");
          expect(body.secret).toEqual(expect.any(String));
          expect(String(body.secret)).toHaveLength(43);
          return new Response("{}", { status: 200 });
        }
        return Response.json({ url: "https://forge.example/api/ingest/github" });
      }
      if (url === "https://api.github.com/app") {
        return Response.json({
          events: [
            "issues",
            "issue_comment",
            "pull_request",
            "pull_request_review",
            "check_suite",
            "check_run",
            "status",
          ],
          permissions: {
            issues: "read",
            pull_requests: "write",
            checks: "write",
            statuses: "read",
            metadata: "read",
          },
        });
      }
      if (url.endsWith("/access_tokens")) {
        return Response.json(
          {
            token: "ghs_sync",
            expires_at: "2026-06-14T18:00:00Z",
            permissions: {
              issues: "read",
              pull_requests: "write",
              checks: "write",
              statuses: "read",
              metadata: "read",
            },
          },
          { status: 201 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apps.configureWebhook({ id: created.id });
    expect(result).toMatchObject({
      ok: true,
      url: "https://forge.example/api/ingest/github",
      readiness: { ready: true, missingEvents: [], missingPermissions: [] },
    });
    const row = await prisma.githubApp.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.webhookConfiguredAt).toBeTruthy();
    expect(row.webhookSecretPreviousEnc).toBeNull();
    expect(decryptSecret(row.webhookSecretEnc!)).toHaveLength(43);
    const listed = await apps.list();
    expect(listed[0]).not.toHaveProperty("webhookSecretEnc");
    expect(listed[0]).not.toHaveProperty("webhookSecretPreviousEnc");

    const beforeFailedRotation = row.webhookSecretEnc;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(apps.configureWebhook({ id: created.id })).rejects.toThrow(/GitHub API error/i);
    const afterFailedRotation = await prisma.githubApp.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(afterFailedRotation.webhookSecretEnc).toBe(beforeFailedRotation);
    expect(afterFailedRotation.webhookSecretPreviousEnc).toBeNull();
    expect(afterFailedRotation.webhookLastError).toMatch(/GitHub API error/i);
  });

  it("refreshes end-to-end sync status without rotating the webhook secret", async () => {
    const { apps } = await setup("GHR");
    const prisma = getPrisma();
    const created = await apps.createManual({
      name: "Refresh App",
      appId: "1234567",
      installationId: "7654321",
      privateKey: PEM,
    });
    vi.stubEnv("AUTH_URL", "https://forge.example");
    await prisma.githubApp.update({
      where: { id: created.id },
      data: {
        webhookConfiguredAt: new Date(),
        webhookSecretEnc: "unchanged-ciphertext",
        webhookLastError: "stale warning",
      },
    });

    const appResponse = {
      events: [
        "issues",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "check_suite",
        "check_run",
        "status",
      ],
      permissions: {
        issues: "read",
        pull_requests: "write",
        checks: "write",
        statuses: "read",
        metadata: "read",
      },
    };
    let installationPermissions: Record<string, string> = {
      pull_requests: "write",
      metadata: "read",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/app")) return Response.json(appResponse);
        if (url.endsWith("/app/hook/config")) {
          return Response.json({ url: "https://forge.example/api/ingest/github" });
        }
        if (url.endsWith("/access_tokens")) {
          return Response.json(
            {
              token: "ghs_refresh",
              expires_at: "2026-06-14T18:00:00Z",
              permissions: installationPermissions,
            },
            { status: 201 },
          );
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const pending = await apps.refreshSyncStatus({ id: created.id });
    expect(pending.ready).toBe(false);
    expect(pending.missingInstallationPermissions).toEqual([
      "issues:read",
      "checks:write",
      "statuses:read",
    ]);
    let row = await prisma.githubApp.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.webhookLastError).toMatch(/installation approval/i);
    expect(row.webhookLastCheckedAt).not.toBeNull();
    expect(row.webhookSecretEnc).toBe("unchanged-ciphertext");

    installationPermissions = appResponse.permissions;
    const ready = await apps.refreshSyncStatus({ id: created.id });
    expect(ready.ready).toBe(true);
    row = await prisma.githubApp.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.webhookLastError).toBeNull();
    expect(row.webhookSecretEnc).toBe("unchanged-ciphertext");
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
            JSON.stringify({
              token: "ghs_x",
              expires_at: "2026-06-14T18:00:00Z",
              repository_selection: "all",
            }),
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
