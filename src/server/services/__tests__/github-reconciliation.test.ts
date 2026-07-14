import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GitHubRequestError } from "@/server/services/github/client";
import {
  claimGitHubManualSync,
  gitHubPartialChecksError,
  persistGitHubManualSyncFailure,
  upsertExternalResource,
} from "@/server/services/github/resource-sync";
import {
  claimGitHubReconciliationCandidate,
  sweepGitHubStatusReconciliation,
} from "@/server/services/github/reconciliation";
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
      githubRequestTimeoutSeconds: 10,
      githubSweepBudgetSeconds: 45,
      githubClosedReprobeMinutes: 1440,
      githubManualCooldownSeconds: 30,
    },
  });
  const connection = await prisma.connection.create({
    data: {
      ownerId: fixture.user.id,
      provider: "GITHUB",
      label: "GitHub test",
      status: "CONNECTED",
      config: { installationId: "1" },
    },
  });
  const mapping = await prisma.connectionMapping.create({
    data: {
      workspaceId: fixture.workspace.id,
      connectionId: connection.id,
      kind: "repo",
      target: "acme/forge",
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
      connectionMappingId: mapping.id,
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
  return { fixture, prisma, resource, mapping };
}

describe("GitHub status reconciliation", () => {
  it("promotes partial checks metadata into a mapping-wide manual failure", () => {
    const retryAt = "2026-07-14T13:00:00.000Z";
    expect(
      gitHubPartialChecksError({
        checks: {
          partial: true,
          rateLimited: true,
          timedOut: false,
          diagnostic: "Checks API rate limit exceeded",
          retryAt,
        },
      }),
    ).toMatchObject({
      message: "Checks API rate limit exceeded",
      status: 429,
      retryAt: new Date(retryAt),
      rateLimited: true,
      timedOut: false,
    });
    expect(gitHubPartialChecksError({ checks: { partial: false } })).toBeNull();
    expect(
      gitHubPartialChecksError({
        checks: {
          partial: true,
          rateLimited: false,
          timedOut: false,
          permissionDenied: false,
          diagnostic: "Check suites require another page",
        },
      }),
    ).toMatchObject({ status: 503, rateLimited: false, timedOut: false });
  });

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

  it("slowly re-probes closed PRs so a missed reopen webhook self-heals", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    await prisma.externalResource.update({
      where: { id: resource.id },
      data: {
        state: "closed",
        syncTerminalAt: new Date("2026-07-12T10:00:00.000Z"),
      },
    });
    const syncResource = async () =>
      prisma.externalResource.update({
        where: { id: resource.id },
        data: {
          state: "open",
          syncTerminalAt: null,
          lastSyncedAt: now,
          syncRetryAt: null,
          metadata: {
            checks: {
              source: "api-aggregate",
              status: "pending",
              conclusion: null,
              partial: false,
            },
          },
        },
      });

    await expect(
      sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).resolves.toMatchObject({ inspected: 1, reconciled: 1 });
    expect(
      (await prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } })).state,
    ).toBe("open");
  });

  it("backs off partial open PR snapshots and opens a rate-limit circuit", async () => {
    const { fixture, prisma, resource, mapping } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    const retryAt = new Date("2026-07-14T13:00:00.000Z");
    const sibling = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 99,
        url: "https://github.com/acme/forge/pull/99",
        title: "Same installation",
        state: "open",
        connectionMappingId: mapping.id,
      },
    });
    const syncResource = async () =>
      prisma.externalResource.update({
        where: { id: resource.id },
        data: {
          lastSyncedAt: now,
          syncRetryAt: null,
          syncFailureCount: 0,
          metadata: {
            checks: {
              source: "api-aggregate",
              status: "unknown",
              conclusion: null,
              partial: true,
              rateLimited: true,
              retryAt: retryAt.toISOString(),
              diagnostic: "API rate limit exceeded",
            },
          },
        },
      });

    await expect(
      sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now,
        syncResource,
      }),
    ).resolves.toMatchObject({
      reconciled: 1,
      partial: 1,
      rateLimited: 1,
      circuitBroken: true,
    });
    const row = await prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(row.syncRetryAt).toEqual(retryAt);
    expect(row.syncFailureCount).toBe(1);
    expect(
      (await prisma.externalResource.findUniqueOrThrow({ where: { id: sibling.id } })).syncRetryAt,
    ).toEqual(retryAt);
  });

  it("rechecks snapshot freshness in the lease claim to close manual-sync races", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    const candidate = await prisma.externalResource.findUniqueOrThrow({
      where: { id: resource.id },
    });
    await prisma.externalResource.update({
      where: { id: resource.id },
      data: { lastSyncedAt: now },
    });

    await expect(
      claimGitHubReconciliationCandidate({
        db: prisma,
        workspaceId: fixture.workspace.id,
        candidate,
        now,
        staleBefore: new Date("2026-07-14T11:45:00.000Z"),
        dormantBefore: new Date("2026-07-13T12:00:00.000Z"),
        leaseUntil: new Date("2026-07-14T12:01:00.000Z"),
      }),
    ).resolves.toBe(false);
  });

  it("limits manual refreshes with one atomic cooldown/lease claim", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    const input = {
      db: prisma,
      workspaceId: fixture.workspace.id,
      externalResourceId: resource.id,
      now,
      cooldownSeconds: 30,
      leaseUntil: new Date("2026-07-14T12:00:10.000Z"),
    };
    await expect(claimGitHubManualSync(input)).resolves.toBe(true);
    await expect(claimGitHubManualSync(input)).resolves.toBe(false);
    await expect(
      claimGitHubManualSync({
        ...input,
        now: new Date("2026-07-14T12:00:31.000Z"),
        leaseUntil: new Date("2026-07-14T12:00:41.000Z"),
      }),
    ).resolves.toBe(true);
  });

  it("persists provider retry timing and diagnostics after a manual refresh failure", async () => {
    const { fixture, prisma, resource, mapping } = await setupResource();
    const now = new Date("2026-07-14T12:00:00.000Z");
    const reset = new Date("2026-07-14T13:00:00.000Z");
    const laterReset = new Date("2026-07-14T14:00:00.000Z");
    const sibling = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 99,
        url: "https://github.com/acme/forge/pull/99",
        title: "Same mapping",
        state: "open",
        connectionMappingId: mapping.id,
      },
    });
    const siblingWithLaterGate = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 100,
        url: "https://github.com/acme/forge/pull/100",
        title: "Same mapping with a later gate",
        state: "open",
        connectionMappingId: mapping.id,
        syncRetryAt: laterReset,
        syncLastError: "Existing longer provider reset",
      },
    });
    await prisma.externalResource.update({
      where: { id: resource.id },
      data: { syncRetryAt: laterReset },
    });

    await expect(
      persistGitHubManualSyncFailure({
        db: prisma,
        workspaceId: fixture.workspace.id,
        externalResourceId: resource.id,
        connectionMappingId: mapping.id,
        currentFailureCount: 0,
        now,
        baseMinutes: 5,
        maxMinutes: 1440,
        error: new GitHubRequestError("API rate limit exceeded", 429, reset, true),
      }),
    ).resolves.toEqual({ retryAt: laterReset, failureCount: 1, mappingWide: true });

    const [failed, mappedSibling, mappedSiblingWithLaterGate] = await Promise.all([
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
      prisma.externalResource.findUniqueOrThrow({ where: { id: sibling.id } }),
      prisma.externalResource.findUniqueOrThrow({ where: { id: siblingWithLaterGate.id } }),
    ]);
    expect(failed).toMatchObject({
      syncRetryAt: laterReset,
      syncFailureCount: 1,
      syncLastError: "API rate limit exceeded",
    });
    expect(mappedSibling).toMatchObject({
      syncRetryAt: reset,
      syncFailureCount: 0,
      syncLastError: "API rate limit exceeded",
    });
    expect(mappedSiblingWithLaterGate).toMatchObject({
      syncRetryAt: laterReset,
      syncFailureCount: 0,
      syncLastError: "Existing longer provider reset",
    });

    await expect(
      persistGitHubManualSyncFailure({
        db: prisma,
        workspaceId: fixture.workspace.id,
        externalResourceId: resource.id,
        connectionMappingId: mapping.id,
        currentFailureCount: 1,
        now: new Date("2026-07-14T12:05:00.000Z"),
        baseMinutes: 5,
        maxMinutes: 1440,
        error: new GitHubRequestError("Partial checks already counted", 403, null),
        incrementFailureCount: false,
      }),
    ).resolves.toMatchObject({ failureCount: 1, mappingWide: true });
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({ syncFailureCount: 1 });
  });

  it("stops starting resources after the workspace sweep budget is exhausted", async () => {
    const { fixture, prisma, resource } = await setupResource();
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const second = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 43,
        url: "https://github.com/acme/forge/pull/43",
        title: "Second PR",
        state: "open",
        lastSyncedAt: new Date("2026-07-14T10:00:00.000Z"),
      },
    });
    await prisma.externalResourceLink.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        externalResourceId: second.id,
        kind: "IMPLEMENTS",
      },
    });
    let clockMs = 0;
    let calls = 0;
    const syncResource = async ({ externalResourceId }: { externalResourceId: string }) => {
      calls += 1;
      clockMs += 50_000;
      return prisma.externalResource.update({
        where: { id: externalResourceId },
        data: {
          lastSyncedAt: new Date("2026-07-14T12:00:00.000Z"),
          syncRetryAt: null,
          metadata: {
            checks: {
              source: "api-aggregate",
              status: "pending",
              conclusion: null,
              partial: false,
            },
          },
        },
      });
    };

    await expect(
      sweepGitHubStatusReconciliation(prisma, {
        workspaceId: fixture.workspace.id,
        now: new Date("2026-07-14T12:00:00.000Z"),
        clock: () => clockMs,
        syncResource: syncResource as never,
      }),
    ).resolves.toMatchObject({ budgetExhausted: true, reconciled: 1 });
    expect(calls).toBe(1);
    const rows = await prisma.externalResource.findMany({
      where: { id: { in: [resource.id, second.id] } },
      select: { lastSyncedAt: true },
    });
    expect(
      rows.filter((row) => row.lastSyncedAt?.getTime() === Date.parse("2026-07-14T12:00:00.000Z")),
    ).toHaveLength(1);
  });
});
