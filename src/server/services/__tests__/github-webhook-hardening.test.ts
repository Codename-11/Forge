import { afterAll, afterEach, describe, expect, it } from "vitest";
import { gitHubReviewDecision } from "@/server/services/github/client";
import { claimGitHubWebhookDelivery, processGitHubWebhook } from "@/server/services/github/webhook";
import {
  gitHubResourceVersionMatches,
  recoverGenericGitHubAttachments,
  resolveGitHubRepoMapping,
  upsertExternalResource,
  upsertExternalResourceFromWebhook,
} from "@/server/services/github/resource-sync";
import {
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];
const deliveryIds: string[] = [];

function delivery(label: string): string {
  const id = `gh-hardening-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  deliveryIds.push(id);
  return id;
}

afterEach(async () => {
  const prisma = getPrisma();
  if (deliveryIds.length) {
    await prisma.externalWebhookEvent.deleteMany({
      where: { deliveryId: { in: deliveryIds.splice(0) } },
    });
  }
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup(options: { syncComments?: boolean; autoCreateIssues?: boolean } = {}) {
  const fixture = await createWorkspaceFixture({ keyPrefix: "GH" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
  const connection = await prisma.connection.create({
    data: {
      ownerId: fixture.user.id,
      provider: "GITHUB",
      label: "GitHub webhook test",
      status: "CONNECTED",
      config: { installationId: "101" },
    },
  });
  const mapping = await prisma.connectionMapping.create({
    data: {
      workspaceId: fixture.workspace.id,
      connectionId: connection.id,
      kind: "repo",
      target: "acme/forge",
      config:
        options.syncComments || options.autoCreateIssues
          ? {
              github: {
                syncComments: options.syncComments ?? false,
                autoCreateIssues: options.autoCreateIssues ?? false,
              },
            }
          : undefined,
    },
  });
  return { fixture, prisma, issue, mapping };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 4200,
    node_id: "PR_node_42",
    number: 42,
    title: "Ship GitHub hardening",
    body: null,
    state: "open" as const,
    html_url: "https://github.com/acme/forge/pull/42",
    url: "https://api.github.com/repos/acme/forge/pulls/42",
    draft: false,
    merged: false,
    mergeable_state: "clean",
    head: { ref: "hardening", sha: "head-new", repo: { full_name: "acme/forge" } },
    base: { ref: "main", sha: "base", repo: { full_name: "acme/forge" } },
    created_at: "2026-07-14T09:00:00Z",
    updated_at: "2026-07-14T12:00:00Z",
    ...overrides,
  };
}

describe("GitHub webhook hardening", () => {
  it("keeps outstanding review requests ahead of approvals", () => {
    expect(
      gitHubReviewDecision({
        approvedCount: 1,
        changesRequestedCount: 0,
        requestedCount: 2,
      }),
    ).toBe("REVIEW_REQUESTED");
    expect(
      gitHubReviewDecision({
        approvedCount: 1,
        changesRequestedCount: 1,
        requestedCount: 2,
      }),
    ).toBe("CHANGES_REQUESTED");
  });

  it("rejects a mapping id paired with a different repository", async () => {
    const { fixture, prisma, mapping } = await setup();
    await expect(
      resolveGitHubRepoMapping({
        db: prisma,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        repoFullName: "other/repository",
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it("requires the payload installation to match the mapped connection", async () => {
    const { prisma } = await setup();
    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("wrong-installation"),
      event: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 202 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest(),
      },
    });
    expect(result).toMatchObject({ processed: 0, skipped: "no-mapping" });
  });

  it("canonicalizes repository casing without orphaning existing issue links", async () => {
    const { fixture, prisma, issue, mapping } = await setup();
    const legacy = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        connectionMappingId: mapping.id,
        resourceType: "PULL_REQUEST",
        repoFullName: "Acme/Forge",
        number: 42,
        url: "https://github.com/Acme/Forge/pull/42",
        title: "Legacy casing",
        state: "open",
      },
    });
    const link = await prisma.externalResourceLink.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        externalResourceId: legacy.id,
        kind: "IMPLEMENTS",
      },
    });

    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Canonical casing",
        state: "open",
      },
    });

    expect(resource).toMatchObject({ id: legacy.id, repoFullName: "acme/forge" });
    await expect(
      prisma.externalResourceLink.findUniqueOrThrow({ where: { id: link.id } }),
    ).resolves.toMatchObject({ externalResourceId: resource.id, issueId: issue.id });
    await expect(
      prisma.externalResource.count({
        where: {
          workspaceId: fixture.workspace.id,
          provider: "GITHUB",
          resourceType: "PULL_REQUEST",
          number: 42,
        },
      }),
    ).resolves.toBe(1);
  });

  it("applies webhook freshness guards across repository casing", async () => {
    const { fixture, prisma, mapping } = await setup();
    const merged = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        connectionMappingId: mapping.id,
        resourceType: "PULL_REQUEST",
        repoFullName: "Acme/Forge",
        number: 42,
        url: "https://github.com/Acme/Forge/pull/42",
        title: "Newest merged state",
        state: "merged",
        externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
      },
    });

    const result = await upsertExternalResourceFromWebhook(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Delayed open state",
        state: "open",
        externalUpdatedAt: new Date("2026-07-14T11:00:00Z"),
      },
    });

    expect(result).toMatchObject({ applied: false });
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: merged.id } }),
    ).resolves.toMatchObject({
      repoFullName: "acme/forge",
      title: "Newest merged state",
      state: "merged",
      externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
    });
  });

  it("does not let an older PR webhook regress a newer merged snapshot", async () => {
    const { fixture, prisma, issue, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Merged title",
        state: "merged",
        metadata: { merged: true, head: { sha: "head-new" } },
        externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
      },
    });
    await prisma.externalResourceLink.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        externalResourceId: resource.id,
        kind: "IMPLEMENTS",
      },
    });
    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("out-of-order"),
      event: "pull_request",
      payload: {
        action: "reopened",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest({ updated_at: "2026-07-14T11:00:00Z" }),
      },
    });
    expect(result.processed).toBe(0);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      state: "merged",
      title: "Merged title",
      externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
    });
  });

  it("does not regress merged state for same-timestamp events", async () => {
    const { fixture, prisma, mapping } = await setup();
    await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Merged title",
        state: "merged",
        metadata: { merged: true },
        externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("equal-timestamp"),
      event: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest({ updated_at: "2026-07-14T13:00:00Z" }),
      },
    });

    expect(result.processed).toBe(0);
    const staleReopen = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("equal-timestamp-reopen-after-merge"),
      event: "pull_request",
      payload: {
        action: "reopened",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest({ updated_at: "2026-07-14T13:00:00Z" }),
      },
    });
    expect(staleReopen.processed).toBe(0);
    await expect(
      prisma.externalResource.findFirstOrThrow({
        where: { workspaceId: fixture.workspace.id, number: 42 },
      }),
    ).resolves.toMatchObject({ state: "merged", title: "Merged title" });
  });

  it("accepts an explicit reopen when GitHub timestamps share a second", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Closed title",
        state: "closed",
        metadata: { merged: false },
        externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("same-second-reopen"),
      event: "pull_request",
      payload: {
        action: "reopened",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest({ updated_at: "2026-07-14T13:00:00Z" }),
      },
    });

    expect(result.processed).toBe(1);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({ state: "open", title: "Ship GitHub hardening" });
  });

  it("serializes concurrent snapshots so the newest provider state wins", async () => {
    const { fixture, prisma, mapping } = await setup();
    const base = {
      provider: "GITHUB" as const,
      resourceType: "PULL_REQUEST" as const,
      repoFullName: "acme/forge",
      number: 42,
      url: "https://github.com/acme/forge/pull/42",
    };

    await Promise.all([
      upsertExternalResourceFromWebhook(prisma, {
        workspaceId: fixture.workspace.id,
        connectionMappingId: mapping.id,
        snapshot: {
          ...base,
          title: "Stale open title",
          state: "open",
          metadata: { merged: false },
          externalUpdatedAt: new Date("2026-07-14T11:00:00Z"),
        },
      }),
      upsertExternalResourceFromWebhook(prisma, {
        workspaceId: fixture.workspace.id,
        connectionMappingId: mapping.id,
        snapshot: {
          ...base,
          title: "Newest merged title",
          state: "merged",
          metadata: { merged: true },
          externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
        },
      }),
    ]);

    await expect(
      prisma.externalResource.findUniqueOrThrow({
        where: {
          workspaceId_provider_repoFullName_resourceType_number: {
            workspaceId: fixture.workspace.id,
            provider: "GITHUB",
            repoFullName: "acme/forge",
            resourceType: "PULL_REQUEST",
            number: 42,
          },
        },
      }),
    ).resolves.toMatchObject({
      title: "Newest merged title",
      state: "merged",
      externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
    });
  });

  it("keeps lifecycle side effects eligible across metadata-only check races", async () => {
    const expected = {
      externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
      title: "Merged PR",
      state: "merged",
      metadata: { merged: true, head: { sha: "head-new" }, checks: { status: "completed" } },
    };
    expect(
      gitHubResourceVersionMatches(
        {
          ...expected,
          metadata: {
            merged: true,
            head: { sha: "head-new" },
            checks: { status: "dirty", source: "webhook-hint" },
          },
        },
        expected,
      ),
    ).toBe(true);
    expect(
      gitHubResourceVersionMatches(
        {
          ...expected,
          metadata: { merged: true, head: { sha: "different-head" } },
        },
        expected,
      ),
    ).toBe(false);
  });

  it("invalidates trusted checks when a same-SHA rerun starts and emits issue activity", async () => {
    const { fixture, prisma, issue, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Checks rerun",
        state: "open",
        metadata: {
          head: { sha: "head-new" },
          checks: {
            status: "completed",
            conclusion: "success",
            source: "api-aggregate",
            headSha: "head-new",
          },
        },
      },
    });
    await prisma.externalResourceLink.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        externalResourceId: resource.id,
        kind: "IMPLEMENTS",
      },
    });
    const unrelated = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 43,
        url: "https://github.com/acme/forge/pull/43",
        title: "Other head",
        state: "open",
        metadata: {
          head: { sha: "head-other" },
          checks: { status: "completed", conclusion: "success", source: "api-aggregate" },
        },
      },
    });

    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("check-rerun"),
      event: "check_suite",
      payload: {
        action: "rerequested",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        check_suite: {
          head_sha: "head-new",
          status: "queued",
          conclusion: null,
          pull_requests: [],
        },
      },
    });

    const refreshed = await prisma.externalResource.findUniqueOrThrow({
      where: { id: resource.id },
    });
    expect(refreshed.lastSyncedAt).toBeNull();
    expect(refreshed.metadata).toMatchObject({
      checks: { status: "dirty", source: "webhook-hint", headSha: "head-new" },
    });
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: unrelated.id } }),
    ).resolves.toMatchObject({
      metadata: { checks: { status: "completed", source: "api-aggregate" } },
    });
    const events = await prisma.activityEvent.findMany({
      where: { workspaceId: fixture.workspace.id, subjectType: "issue", subjectId: issue.id },
    });
    expect(
      events.some(
        (event) => (event.payload as { change?: string }).change === "external-resource-state",
      ),
    ).toBe(true);

    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("commit-status"),
      event: "status",
      payload: {
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        sha: "head-new",
        state: "success",
      },
    });
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      metadata: {
        checks: {
          status: "dirty",
          source: "webhook-hint",
          event: "status",
          lastStatusState: "success",
        },
      },
    });
  });

  it("does not apply a stale failed conclusion from a check rerun request", async () => {
    const { fixture, prisma, issue, mapping } = await setup();
    const failedStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "CANCELED" },
    });
    await prisma.connectionMapping.update({
      where: { id: mapping.id },
      data: {
        config: { github: { statusRules: { checksFailedStatusId: failedStatus.id } } },
      },
    });
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Rerequest failed check",
        state: "open",
        metadata: {
          head: { sha: "head-new" },
          checks: { status: "completed", conclusion: "failure", source: "api-aggregate" },
        },
      },
    });
    await prisma.externalResourceLink.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        externalResourceId: resource.id,
        kind: "IMPLEMENTS",
      },
    });

    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("check-run-rerequested-stale-failure"),
      event: "check_run",
      payload: {
        action: "rerequested",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        check_run: {
          head_sha: "head-new",
          status: "completed",
          conclusion: "failure",
          pull_requests: [{ number: 42 }],
        },
      },
    });

    const issueAfter = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      include: { status: true },
    });
    expect(issueAfter.status.category).toBe("IN_PROGRESS");
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      metadata: {
        checks: {
          status: "dirty",
          event: "check_run",
          observedConclusion: null,
          lastRunConclusion: null,
        },
      },
    });
  });

  it("ignores an older review hint instead of replacing a newer decision", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Reviewed PR",
        state: "open",
        metadata: {
          reviewDecision: "APPROVED",
          review: { decision: "APPROVED", updatedAt: "2026-07-14T13:00:00Z" },
        },
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("stale-review"),
      event: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest(),
        review: {
          id: 800,
          state: "changes_requested",
          submitted_at: "2026-07-14T12:00:00Z",
          user: { login: "reviewer" },
        },
      },
    });

    expect(result.processed).toBe(0);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      metadata: {
        reviewDecision: "APPROVED",
        review: { decision: "APPROVED", updatedAt: "2026-07-14T13:00:00Z" },
      },
    });
  });

  it("preserves aggregate review state when another reviewer is requested", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Approved before request",
        state: "open",
        metadata: {
          reviewDecision: "APPROVED",
          review: { decision: "APPROVED", updatedAt: "2026-07-14T13:00:00Z" },
        },
      },
    });
    const linkedIssue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    await prisma.externalResourceLink.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: linkedIssue.id,
        externalResourceId: resource.id,
        kind: "IMPLEMENTS",
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("review-requested"),
      event: "pull_request",
      payload: {
        action: "review_requested",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest({ updated_at: "2026-07-14T14:00:00Z" }),
      },
    });

    expect(result.processed).toBe(1);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      lastSyncedAt: null,
      metadata: {
        reviewDecision: "APPROVED",
        review: { decision: "APPROVED", updatedAt: "2026-07-14T13:00:00Z" },
        reviewHint: { dirty: true, event: "review_requested", source: "webhook-hint" },
      },
    });
    await expect(
      prisma.activityEvent.count({
        where: {
          workspaceId: fixture.workspace.id,
          subjectType: "issue",
          subjectId: linkedIssue.id,
        },
      }),
    ).resolves.toBeGreaterThan(0);
  });

  it("keeps the decisive review state when a comment-only review arrives", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Approved PR",
        state: "open",
        metadata: {
          reviewDecision: "APPROVED",
          review: { decision: "APPROVED", updatedAt: "2026-07-14T13:00:00Z" },
        },
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("comment-only-review"),
      event: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest(),
        review: {
          id: 802,
          state: "commented",
          submitted_at: "2026-07-14T14:00:00Z",
          user: { login: "reviewer" },
        },
      },
    });

    expect(result.processed).toBe(1);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      lastSyncedAt: null,
      metadata: {
        reviewDecision: "APPROVED",
        review: {
          decision: "APPROVED",
          updatedAt: "2026-07-14T13:00:00Z",
          dirty: true,
          lastEventState: "COMMENTED",
          lastEventAt: "2026-07-14T14:00:00Z",
        },
      },
    });
  });

  it("does not treat one reviewer approval as the aggregate decision", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Multiple reviewers",
        state: "open",
        metadata: {
          reviewDecision: "CHANGES_REQUESTED",
          review: { decision: "CHANGES_REQUESTED", updatedAt: "2026-07-14T13:00:00Z" },
        },
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("single-approval-review"),
      event: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest(),
        review: {
          id: 803,
          state: "approved",
          submitted_at: "2026-07-14T14:00:00Z",
          user: { login: "second-reviewer" },
        },
      },
    });

    expect(result.processed).toBe(1);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      lastSyncedAt: null,
      metadata: {
        reviewDecision: "CHANGES_REQUESTED",
        review: {
          decision: "CHANGES_REQUESTED",
          dirty: true,
          lastEventDecision: "APPROVED",
          lastReviewer: "second-reviewer",
        },
      },
    });
  });

  it("rejects review events older than the latest webhook hint", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Review ordering",
        state: "open",
      },
    });
    const reviewPayload = (state: string, submittedAt: string) => ({
      action: "submitted",
      installation: { id: 101 },
      repository: { full_name: "acme/forge" },
      pull_request: pullRequest(),
      review: {
        id: state === "approved" ? 804 : 805,
        state,
        submitted_at: submittedAt,
        user: { login: "reviewer" },
      },
    });

    await expect(
      processGitHubWebhook({
        db: prisma,
        deliveryId: delivery("newer-review-event"),
        event: "pull_request_review",
        payload: reviewPayload("approved", "2026-07-14T14:00:00Z"),
      }),
    ).resolves.toMatchObject({ processed: 1 });
    await expect(
      processGitHubWebhook({
        db: prisma,
        deliveryId: delivery("older-review-event"),
        event: "pull_request_review",
        payload: reviewPayload("changes_requested", "2026-07-14T13:00:00Z"),
      }),
    ).resolves.toMatchObject({ processed: 0 });
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      metadata: {
        review: {
          lastEventDecision: "APPROVED",
          lastEventAt: "2026-07-14T14:00:00Z",
        },
      },
    });
  });

  it("does not use a partial review read as an ordering watermark", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Partial review read",
        state: "open",
        metadata: {
          reviewDecision: null,
          review: {
            source: "api-aggregate",
            partial: true,
            diagnostic: "GitHub reviews unavailable",
            updatedAt: "2026-07-14T15:00:00Z",
          },
        },
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("review-after-partial-read"),
      event: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest(),
        review: {
          id: 804,
          state: "changes_requested",
          submitted_at: "2026-07-14T14:00:00Z",
          user: { login: "recovering-reviewer" },
        },
      },
    });

    expect(result.processed).toBe(1);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      lastSyncedAt: null,
      metadata: {
        reviewDecision: null,
        review: {
          partial: true,
          dirty: true,
          lastEventDecision: "CHANGES_REQUESTED",
          lastEventAt: "2026-07-14T14:00:00Z",
        },
      },
    });
  });

  it("canonicalizes legacy identity before applying review hints", async () => {
    const { fixture, prisma, mapping } = await setup();
    const resource = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        connectionMappingId: mapping.id,
        resourceType: "PULL_REQUEST",
        repoFullName: "Acme/Forge",
        number: 42,
        url: "https://github.com/Acme/Forge/pull/42",
        title: "Merged canonicalization target",
        state: "merged",
        externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
      },
    });

    const result = await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("mixed-case-review"),
      event: "pull_request_review",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        pull_request: pullRequest({ updated_at: "2026-07-14T11:00:00Z" }),
        review: {
          id: 801,
          state: "approved",
          submitted_at: "2026-07-14T12:00:00Z",
          user: { login: "reviewer" },
        },
      },
    });

    expect(result.processed).toBe(1);
    await expect(
      prisma.externalResource.findUniqueOrThrow({ where: { id: resource.id } }),
    ).resolves.toMatchObject({
      repoFullName: "acme/forge",
      title: "Merged canonicalization target",
      state: "merged",
      externalUpdatedAt: new Date("2026-07-14T13:00:00Z"),
      metadata: {
        reviewDecision: null,
        review: { dirty: true, lastEventDecision: "APPROVED" },
      },
    });
  });

  it("keeps PR discussion on GitHub and deduplicates mirrored issue comments", async () => {
    const { fixture, prisma, issue, mapping } = await setup({ syncComments: true });
    const issueResource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "ISSUE",
        repoFullName: "acme/forge",
        number: 7,
        url: "https://github.com/acme/forge/issues/7",
        title: "Issue discussion",
        state: "open",
      },
    });
    await prisma.externalResourceLink.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        externalResourceId: issueResource.id,
        kind: "SOURCE",
      },
    });
    const issuePayload = {
      action: "created",
      installation: { id: 101 },
      repository: { full_name: "acme/forge" },
      issue: {
        id: 700,
        number: 7,
        title: "Issue discussion",
        state: "open" as const,
        html_url: "https://github.com/acme/forge/issues/7",
        url: "https://api.github.com/repos/acme/forge/issues/7",
      },
      comment: {
        id: 9001,
        html_url: "https://github.com/acme/forge/issues/7#issuecomment-9001",
        body: "One durable comment",
        user: { login: "octocat" },
      },
    };
    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("comment-a"),
      event: "issue_comment",
      payload: issuePayload,
    });
    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("comment-b"),
      event: "issue_comment",
      payload: issuePayload,
    });
    expect(
      await prisma.comment.count({
        where: { workspaceId: fixture.workspace.id, issueId: issue.id },
      }),
    ).toBe(1);

    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("pr-comment"),
      event: "issue_comment",
      payload: {
        ...issuePayload,
        issue: {
          ...issuePayload.issue,
          number: 42,
          pull_request: { url: "https://api.github.com/repos/acme/forge/pulls/42" },
        },
        comment: { ...issuePayload.comment, id: 9002 },
      },
    });
    expect(
      await prisma.externalResource.count({
        where: { workspaceId: fixture.workspace.id, resourceType: "ISSUE", number: 42 },
      }),
    ).toBe(0);
  });

  it("does not let a newer issue comment suppress issue lifecycle side effects", async () => {
    const { fixture, prisma } = await setup({ syncComments: true, autoCreateIssues: true });
    const issue = {
      id: 700,
      number: 7,
      title: "Lifecycle after comment",
      state: "open" as const,
      html_url: "https://github.com/acme/forge/issues/7",
      url: "https://api.github.com/repos/acme/forge/issues/7",
      created_at: "2026-07-14T09:00:00Z",
      updated_at: "2026-07-14T13:00:00Z",
    };
    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("comment-before-opened"),
      event: "issue_comment",
      payload: {
        action: "created",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        issue,
        comment: {
          id: 9003,
          html_url: "https://github.com/acme/forge/issues/7#issuecomment-9003",
          body: "Comment arrived first",
          user: { login: "octocat" },
        },
      },
    });

    await processGitHubWebhook({
      db: prisma,
      deliveryId: delivery("opened-after-comment"),
      event: "issues",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { full_name: "acme/forge" },
        issue: { ...issue, updated_at: "2026-07-14T12:00:00Z" },
      },
    });

    const resource = await prisma.externalResource.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        resourceType: "ISSUE",
        repoFullName: "acme/forge",
        number: 7,
      },
    });
    expect(resource.externalUpdatedAt).toEqual(new Date("2026-07-14T12:00:00Z"));
    await expect(
      prisma.externalResourceLink.count({
        where: {
          workspaceId: fixture.workspace.id,
          externalResourceId: resource.id,
          kind: "SOURCE",
        },
      }),
    ).resolves.toBe(1);
  });

  it("reclaims failed deliveries once and promotes legacy GitHub link attachments", async () => {
    const { fixture, prisma, issue, mapping } = await setup();
    const failedId = delivery("failed");
    await prisma.externalWebhookEvent.create({
      data: {
        provider: "GITHUB",
        deliveryId: failedId,
        event: "pull_request",
        status: "FAILED",
        processingStartedAt: new Date("2026-07-14T10:00:00Z"),
        processedAt: new Date("2026-07-14T10:01:00Z"),
        error: "transient",
      },
    });
    await expect(
      claimGitHubWebhookDelivery({
        db: prisma,
        deliveryId: failedId,
        event: "pull_request",
        action: "opened",
        repoFullName: "acme/forge",
        now: new Date("2026-07-14T10:02:00Z"),
      }),
    ).resolves.toBe("CLAIMED");
    await expect(
      claimGitHubWebhookDelivery({
        db: prisma,
        deliveryId: failedId,
        event: "pull_request",
        action: "opened",
        repoFullName: "acme/forge",
        now: new Date("2026-07-14T10:02:01Z"),
      }),
    ).resolves.toBe("DUPLICATE");
    await expect(
      prisma.externalWebhookEvent.findUniqueOrThrow({
        where: { provider_deliveryId: { provider: "GITHUB", deliveryId: failedId } },
      }),
    ).resolves.toMatchObject({ status: "RECEIVED", attemptCount: 2, error: null });

    const unmatched = await prisma.attachment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        targetType: "issue",
        targetId: issue.id,
        kind: "LINK",
        filename: "Unmatched GitHub PR",
        mimeType: "text/url",
        size: 0,
        url: "https://github.com/acme/forge/pull/999",
        externalUrl: "https://github.com/acme/forge/pull/999",
        createdAt: new Date("2026-07-14T09:00:00Z"),
      },
    });
    const resource = await upsertExternalResource(prisma, {
      workspaceId: fixture.workspace.id,
      connectionMappingId: mapping.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 42,
        url: "https://github.com/acme/forge/pull/42",
        title: "Legacy generic attachment",
        state: "open",
      },
    });
    const deletedIssue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    await prisma.issue.update({
      where: { id: deletedIssue.id },
      data: { deletedAt: new Date("2026-07-14T08:30:00Z") },
    });
    const deletedIssueAttachment = await prisma.attachment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: deletedIssue.id,
        targetType: "issue",
        targetId: deletedIssue.id,
        kind: "LINK",
        filename: "Deleted issue GitHub PR",
        mimeType: "text/url",
        size: 0,
        url: "https://github.com/acme/forge/pull/42",
        externalUrl: "https://github.com/acme/forge/pull/42",
        createdAt: new Date("2026-07-14T08:00:00Z"),
      },
    });
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        targetType: "issue",
        targetId: issue.id,
        kind: "LINK",
        filename: "GitHub PR",
        mimeType: "text/url",
        size: 0,
        url: "https://github.com/ACME/Forge/pull/42?diff=split",
        externalUrl: "https://github.com/ACME/Forge/pull/42?diff=split",
      },
    });
    await expect(
      recoverGenericGitHubAttachments(prisma, { workspaceId: fixture.workspace.id, limit: 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      recovered: 1,
      unmatched: 0,
    });
    expect(await prisma.attachment.findUnique({ where: { id: attachment.id } })).toBeNull();
    await expect(
      prisma.attachment.findUnique({ where: { id: unmatched.id } }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.attachment.findUnique({ where: { id: deletedIssueAttachment.id } }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.externalResourceLink.findUnique({
        where: {
          issueId_externalResourceId_kind: {
            issueId: issue.id,
            externalResourceId: resource.id,
            kind: "RELATES_TO",
          },
        },
      }),
    ).resolves.toBeTruthy();
  });
});
