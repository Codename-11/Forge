import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { ConnectionProvider, ConnectionStatus } from "@prisma/client";
import { encryptSecret } from "@/server/crypto";
import {
  connectGithubAppAsConnection,
  ensureGitHubRepoLinkable,
  listBrowsableGitHubRepos,
  resolveRepoLinkability,
} from "@/server/services/github/linkability";
import { resolveInstallationToken } from "@/server/services/github/installation-token";
import { invalidateInstallationToken } from "@/server/services/github-app";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];

// A throwaway RSA key so buildAppJwt can actually sign offline.
const { privateKey } = generateKeyPairSync("rsa", {
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

let appSeq = 0;
async function installedApp(workspaceId: string) {
  appSeq += 1;
  const installationId = String(900000 + appSeq);
  const app = await getPrisma().githubApp.create({
    data: {
      workspaceId,
      name: "forge-test-app",
      appId: String(4000000 + appSeq),
      installationId,
      slug: "forge-test",
      privateKeyEnc: encryptSecret(privateKey),
      createdViaManifest: true,
    },
    select: { id: true, installationId: true },
  });
  invalidateInstallationToken(app.id); // ensure no cross-test token cache
  return app;
}

describe("resolveRepoLinkability — app_available", () => {
  it("offers the installed GithubApp when there's no Connection yet (admin)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    await installedApp(fixture.workspace.id);
    const listRepos = vi.fn(async () => []);

    const result = await resolveRepoLinkability({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      isAdmin: true,
      repoFullName: "octo/hello",
      listRepos,
    });

    expect(result.status).toBe("app_available");
    if (result.status === "app_available") {
      expect(result.apps).toHaveLength(1);
      expect(result.apps[0].name).toBe("forge-test-app");
    }
  });

  it("stays not_ready (no app leak) for a non-admin even when an app exists", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    await installedApp(fixture.workspace.id);

    const result = await resolveRepoLinkability({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.secondUser.id,
      isAdmin: false,
      repoFullName: "octo/hello",
      listRepos: vi.fn(async () => []),
    });

    expect(result.status).toBe("not_ready");
  });
});

describe("resolveInstallationToken — GithubApp preferred over env app", () => {
  it("mints via the GithubApp that owns the installation", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    const app = await installedApp(fixture.workspace.id);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain(`/app/installations/${app.installationId}/access_tokens`);
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({ token: "ghs_from_app", expires_at: "2999-01-01T00:00:00Z" }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await resolveInstallationToken(app.installationId!);
    expect(token).toBe("ghs_from_app");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("falls back to the env app when no GithubApp owns the installation", async () => {
    // No GithubApp for this installation + no GITHUB_APP_ID env in tests → the
    // env path throws its config error, proving the fallback branch is taken.
    await expect(resolveInstallationToken("424242")).rejects.toThrow(/GITHUB_APP_ID/i);
  });
});

describe("connectGithubAppAsConnection", () => {
  it("creates a GITHUB Connection from an installed GithubApp", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    const app = await installedApp(fixture.workspace.id);

    // getInstallationAccountLogin → GET /app/installations/{id}
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ account: { login: "octo-org" } }), { status: 200 }),
      ),
    );

    const result = await connectGithubAppAsConnection({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      githubAppId: app.id,
    });

    expect(result.mapped).toBe(false);
    const conn = await getPrisma().connection.findUniqueOrThrow({
      where: { id: result.connectionId },
      select: { provider: true, status: true, ownerId: true, config: true },
    });
    expect(conn.provider).toBe(ConnectionProvider.GITHUB);
    expect(conn.status).toBe(ConnectionStatus.CONNECTED);
    expect(conn.ownerId).toBe(fixture.user.id);
    expect((conn.config as { installationId?: string }).installationId).toBe(app.installationId);
  });

  it("is idempotent — a second call reuses the same connection", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    const app = await installedApp(fixture.workspace.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ account: { login: "octo-org" } }), { status: 200 })),
    );

    const a = await connectGithubAppAsConnection({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      githubAppId: app.id,
    });
    const b = await connectGithubAppAsConnection({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      githubAppId: app.id,
    });
    expect(b.connectionId).toBe(a.connectionId);
    const count = await getPrisma().connection.count({
      where: { ownerId: fixture.user.id, provider: ConnectionProvider.GITHUB },
    });
    expect(count).toBe(1);
  });
});

describe("listBrowsableGitHubRepos — installation repos for admins", () => {
  it("unions in the installed App's repos (admin), marked unmapped", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    await installedApp(fixture.workspace.id);

    const repos = await listBrowsableGitHubRepos({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      isAdmin: true,
      listRepos: vi.fn(async () => [
        { id: 1, full_name: "octo/hello", html_url: "https://github.com/octo/hello" },
        { id: 2, full_name: "octo/world", html_url: "https://github.com/octo/world" },
      ]),
    });

    expect(repos.map((r) => r.repoFullName).sort()).toEqual(["octo/hello", "octo/world"]);
    expect(repos.every((r) => r.mapped === false && r.mappingId === null)).toBe(true);
  });

  it("returns only mapped repos for a non-admin (no installation probe)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    await installedApp(fixture.workspace.id);
    const listRepos = vi.fn(async () => [
      { id: 1, full_name: "octo/secret", html_url: "https://github.com/octo/secret" },
    ]);

    const repos = await listBrowsableGitHubRepos({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.secondUser.id,
      isAdmin: false,
      listRepos,
    });

    expect(repos).toEqual([]);
    expect(listRepos).not.toHaveBeenCalled();
  });
});

describe("ensureGitHubRepoLinkable — auto-map a browsed repo", () => {
  it("creates the connection + active mapping from the installed App", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    await installedApp(fixture.workspace.id);
    // getInstallationAccountLogin → GET /app/installations/{id}
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ account: { login: "octo-org" } }), { status: 200 })),
    );
    const listRepos = vi.fn(async () => [
      { id: 1, full_name: "octo/hello", html_url: "https://github.com/octo/hello" },
    ]);

    const result = await ensureGitHubRepoLinkable({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      repoFullName: "octo/hello",
      listRepos,
    });

    expect(result.created).toBe(true);
    expect(result.repoFullName).toBe("octo/hello");
    const mapping = await getPrisma().connectionMapping.findUniqueOrThrow({
      where: { id: result.mappingId },
      select: { kind: true, status: true, target: true },
    });
    expect(mapping.kind).toBe("repo");
    expect(mapping.status).toBe("active");
    expect(mapping.target).toBe("octo/hello");
  });

  it("is idempotent — a second call returns the same active mapping", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    fixtures.push(fixture);
    await installedApp(fixture.workspace.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ account: { login: "octo-org" } }), { status: 200 })),
    );
    const listRepos = vi.fn(async () => [
      { id: 1, full_name: "octo/hello", html_url: "https://github.com/octo/hello" },
    ]);

    const a = await ensureGitHubRepoLinkable({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      repoFullName: "octo/hello",
      listRepos,
    });
    const b = await ensureGitHubRepoLinkable({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      repoFullName: "octo/hello",
      listRepos,
    });
    expect(b.mappingId).toBe(a.mappingId);
    expect(b.created).toBe(false);
    const count = await getPrisma().connectionMapping.count({
      where: { workspaceId: fixture.workspace.id, kind: "repo" },
    });
    expect(count).toBe(1);
  });
});
