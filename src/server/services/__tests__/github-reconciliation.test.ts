import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GitHubRequestError } from "@/server/services/github/client";
import { upsertExternalResource } from "@/server/services/github/resource-sync";
import { sweepGitHubStatusReconciliation } from "@/server/services/github/reconciliation";
import {
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setupResource() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "GR" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
  await prisma.workspace.update({
    where: { id: fixture.workspace.id },
    data: {
      githubSyncEnabled: true,
      githubSyncStaleMinutes: 15,
      githubSyncBatchSize: 10,
      githubSyncBackoffMinutes: 5,
      githubSyncMaxBackoffMinutes: 1440,
    },
  });
  const resource = await prisma.externalResource.create({
    data: {
      workspaceId: fixture.workspace.id,
      provider: "GITHUB",
      resourceType: "PULL_REQUEST",
      repoFullName: "acme/forge",
      number: 42,
      url: "https://github.com/acme/forge/pull/42",
      title: "Ship it",
      state: "open",
      lastSyncedAt: new Date("2026-07-14T10:00:00.000Z"),
    },
  });
  await prisma.externalResourceLink.create({
    data: {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      kind: "IMPLEMENTS",
      createdById: fixture.user.id,
    },
  });
  return { fixture, prisma, resource };
}

describe("GitHub status reconciliation", () => {
  it("polls only stale native implementation links and is a no-op once fresh", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    let calls = 0;
    const syncResource = async () => {
      calls += 1;
      return prisma.externalResource.update({
        where: { id: resource.id },
        data: {
          lastSyncedAt: now,
          syncAttemptedAt: now,
          syncRetryAt: null,
          syncFailureCount: 0,
          syncLastError: null,
        },
      });
    };

    await expect(
      sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).resolves.toMatchObject({ inspected: 1, reconciled: 1, failed: 0 });
    await expect(
      sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).resolves.toMatchObject({ inspected: 0, reconciled: 0 });
    expect(calls).toBe(1);
    expect(await prisma.activityEvent.count({ where: { workspaceId: fixture.workspace.id } })).toBe(
      0,
    );
  });

  it("persists rate-limit backoff and skips the resource until reset", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    const reset = new Date("2026-07-14T13:00:00.000Z");
    let calls = 0;
    const syncResource = async (): Promise<never> => {
      calls += 1;
      throw new GitHubRequestError("API rate limit exceeded", 429, reset);
    };

    await expect(
      sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).resolves.toMatchObject({ inspected: 1, failed: 1, rateLimited: 1 });
    const failed = await prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(failed.syncRetryAt).toEqual(reset);
    expect(failed.syncFailureCount).toBe(1);
    await sweepGitHubStatusReconciliation(prisma, {
      workspaceId: fixture.workspace.id,
      now: new Date("2026-07-14T12:30:00.000Z"),
      syncResource,
    });
    expect(calls).toBe(1);
  });

  it("backs off merged PRs with no checks and re-enables terminal rows when reopened", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    const syncResource = async () =>
      prisma.externalResource.update({
        where: { id: resource.id },
        data: {
          state: "merged",
          metadata: { checks: { status: "unknown", conclusion: null } },
          lastSyncedAt: now,
          syncRetryAt: null,
          syncFailureCount: 0,
        },
      });

    await sweepGitHubStatusReconciliation(prisma, {
      workspaceId: fixture.workspace.id,
      now,
      syncResource,
    });
    const held = await prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(held.syncFailureCount).toBe(1);
    expect(held.syncRetryAt).toEqual(new Date("2026-07-14T12:05:00.000Z"));

    await prisma.externalResource.update({
      where: { id: resource.id },
      data: { state: "closed", syncTerminalAt: now },
    });
    const reopened = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: resource.url,
        title: resource.title,
        state: "open",
        labels: [],
        assignees: [],
        metadata: {},
      },
    });
    expect(reopened.syncTerminalAt).toBeNull();
    expect(reopened.syncFailureCount).toBe(0);

    await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: resource.url,
        title: resource.title,
        state: "open",
        labels: [],
        assignees: [],
        metadata: {
          head: { sha: "old-head" },
          checks: { status: "completed", conclusion: "success", headSha: "old-head" },
        },
      },
    });
    const newHead = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: resource.url,
        title: resource.title,
        state: "open",
        labels: [],
        assignees: [],
        metadata: { head: { sha: "new-head" } },
      },
    });
    expect(newHead.metadata).not.toHaveProperty("checks");
  });

  it("does not inspect disabled workspaces, terminal PRs, or an active retry lease", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    let calls = 0;
    const syncResource = async () => {
      calls += 1;
      return prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } });
    };

    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { githubSyncEnabled: false },
    });
    expect(
      await sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).toMatchObject({ workspaces: 0, inspected: 0 });

    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { githubSyncEnabled: true },
    });
    await prisma.externalResource.update({
      where: { id: resource.id },
      data: { syncTerminalAt: now },
    });
    expect(
      await sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).toMatchObject({ inspected: 0 });

    await prisma.externalResource.update({
      where: { id: resource.id },
      data: { syncTerminalAt: null, syncRetryAt: new Date("2026-07-14T12:02:00.000Z") },
    });
    expect(
      await sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).toMatchObject({ inspected: 0 });
    expect(calls).toBe(0);
  });
});
