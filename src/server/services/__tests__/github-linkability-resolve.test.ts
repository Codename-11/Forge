import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { ConnectionProvider, ConnectionStatus } from "@prisma/client";
import {
  mapGitHubRepo,
  resolveRepoLinkability,
} from "@/server/services/github/linkability";
import type { GitHubRepoResponse } from "@/server/services/github/client";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

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

function repos(...names: string[]): GitHubRepoResponse[] {
  return names.map((full_name, i) => ({ id: i + 1, full_name, html_url: `https://github.com/${full_name}` }));
}

async function githubConnection(ownerId: string) {
  return getPrisma().connection.create({
    data: {
      ownerId,
      provider: ConnectionProvider.GITHUB,
      label: "GitHub App - octo",
      account: "github.com/octo",
      status: ConnectionStatus.CONNECTED,
      config: { authKind: "github_app_installation", installationId: "123", accountLogin: "octo" },
    },
    select: { id: true },
  });
}

describe("resolveRepoLinkability — admin gating (private-repo oracle guard)", () => {
  it("never probes installations for a non-admin caller", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GL" });
    fixtures.push(fixture);
    await githubConnection(fixture.user.id);
    const listRepos = vi.fn(async () => repos("octo/secret"));

    const result = await resolveRepoLinkability({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.secondUser.id,
      isAdmin: false,
      repoFullName: "octo/secret",
      listRepos,
    });

    expect(result.status).toBe("not_ready");
    expect(listRepos).not.toHaveBeenCalled();
  });

  it("probes and returns mappable for an admin when the installation has the repo", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GL" });
    fixtures.push(fixture);
    const conn = await githubConnection(fixture.user.id);
    const listRepos = vi.fn(async () => repos("octo/secret"));

    const result = await resolveRepoLinkability({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      isAdmin: true,
      repoFullName: "octo/secret",
      listRepos,
    });

    expect(listRepos).toHaveBeenCalled();
    expect(result.status).toBe("mappable");
    if (result.status === "mappable") {
      expect(result.connections.map((c) => c.connectionId)).toContain(conn.id);
    }
  });

  it("returns ready for any member when an active mapping already covers the repo (no probe)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GL" });
    fixtures.push(fixture);
    const conn = await githubConnection(fixture.user.id);
    await getPrisma().connectionMapping.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionId: conn.id,
        kind: "repo",
        target: "octo/mapped",
        status: "active",
      },
    });
    const listRepos = vi.fn(async () => repos("octo/mapped"));

    const result = await resolveRepoLinkability({
      db: getPrisma(),
      workspaceId: fixture.workspace.id,
      userId: fixture.secondUser.id,
      isAdmin: false,
      repoFullName: "OCTO/MAPPED", // case-insensitive match
      listRepos,
    });

    expect(result.status).toBe("ready");
    expect(listRepos).not.toHaveBeenCalled();
  });
});

describe("mapGitHubRepo — idempotency + multi-repo per connection", () => {
  it("is idempotent for the same repo and keeps distinct repos on one connection", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GM" });
    fixtures.push(fixture);
    const conn = await githubConnection(fixture.user.id);
    const listRepos = vi.fn(async () => repos("octo/one", "octo/two"));
    const db = getPrisma();
    const common = {
      db,
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      connectionId: conn.id,
      listRepos,
    };

    const first = await mapGitHubRepo({ ...common, repoFullName: "octo/one" });
    expect(first.reactivated).toBe(false);

    // Same repo again → reuse the existing row, don't create a duplicate.
    const again = await mapGitHubRepo({ ...common, repoFullName: "octo/one" });
    expect(again.id).toBe(first.id);

    // A second repo on the same connection must not clobber or collide with the first.
    const second = await mapGitHubRepo({ ...common, repoFullName: "octo/two" });
    expect(second.id).not.toBe(first.id);

    const rows = await db.connectionMapping.findMany({
      where: { workspaceId: fixture.workspace.id, connectionId: conn.id, kind: "repo" },
      select: { target: true },
    });
    expect(rows.map((r) => r.target).sort()).toEqual(["octo/one", "octo/two"]);
  });

  it("re-activates a paused mapping instead of duplicating it", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GM" });
    fixtures.push(fixture);
    const conn = await githubConnection(fixture.user.id);
    const db = getPrisma();
    const paused = await db.connectionMapping.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionId: conn.id,
        kind: "repo",
        target: "octo/one",
        status: "paused",
      },
      select: { id: true },
    });

    const result = await mapGitHubRepo({
      db,
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      connectionId: conn.id,
      repoFullName: "octo/one",
      listRepos: vi.fn(async () => repos("octo/one")),
    });

    expect(result.id).toBe(paused.id);
    expect(result.reactivated).toBe(true);
    const row = await db.connectionMapping.findUnique({
      where: { id: paused.id },
      select: { status: true },
    });
    expect(row?.status).toBe("active");
  });

  it("rejects mapping a repo the installation can't access", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GM" });
    fixtures.push(fixture);
    const conn = await githubConnection(fixture.user.id);

    await expect(
      mapGitHubRepo({
        db: getPrisma(),
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        connectionId: conn.id,
        repoFullName: "octo/forbidden",
        listRepos: vi.fn(async () => repos("octo/one")),
      }),
    ).rejects.toThrow(/can't access/i);
  });
});
