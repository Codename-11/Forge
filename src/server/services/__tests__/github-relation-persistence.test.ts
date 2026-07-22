import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  applyGitHubSnapshotToLinkedIssues,
  canonicalizeGitHubResourceIdentity,
  linkExternalResourceToIssue,
} from "@/server/services/github/resource-sync";
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

describe("native GitHub relation persistence", () => {
  it("reclassifies one issue/resource relation instead of duplicating cards", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GR" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const resource = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 117,
        url: "https://github.com/acme/forge/pull/117",
        title: "Release v0.28.0",
        state: "merged",
      },
    });

    const actor = { actorId: fixture.user.id };
    await linkExternalResourceToIssue(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      kind: "IMPLEMENTS",
      actor,
    });
    await linkExternalResourceToIssue(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      kind: "RELEASES",
      actor,
    });
    const activityAfterReclassification = await prisma.activityEvent.count({
      where: { workspaceId: fixture.workspace.id, subjectId: issue.id },
    });
    await linkExternalResourceToIssue(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      kind: "RELEASES",
      actor,
    });

    await expect(
      prisma.externalResourceLink.findMany({
        where: { issueId: issue.id, externalResourceId: resource.id },
      }),
    ).resolves.toMatchObject([{ kind: "RELEASES" }]);
    expect(
      await prisma.activityEvent.count({
        where: { workspaceId: fixture.workspace.id, subjectId: issue.id },
      }),
    ).toBe(activityAfterReclassification);
  });

  it("rejects a cross-workspace relation even when both ids are valid", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GA" });
    const other = await createWorkspaceFixture({ keyPrefix: "GB" });
    fixtures.push(fixture, other);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const resource = await prisma.externalResource.create({
      data: {
        workspaceId: other.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/other",
        number: 1,
        url: "https://github.com/acme/other/pull/1",
        title: "Other tenant",
        state: "open",
      },
    });

    await expect(
      linkExternalResourceToIssue(prisma, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        externalResourceId: resource.id,
        kind: "RELATES_TO",
        actor: { actorId: fixture.user.id },
      }),
    ).rejects.toThrow("External resource not found");
  });

  it("does not let a generic related replay downgrade implementation evidence", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const resource = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 118,
        url: "https://github.com/acme/forge/pull/118",
        title: "Fixes GP-1",
        state: "open",
      },
    });
    const relation = {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      actor: { actorId: fixture.user.id },
    };

    await linkExternalResourceToIssue(prisma, { ...relation, kind: "FIXES" });
    const activityAfterFixes = await prisma.activityEvent.count({
      where: { workspaceId: fixture.workspace.id, subjectId: issue.id },
    });
    await linkExternalResourceToIssue(prisma, {
      ...relation,
      kind: "RELATES_TO",
      preserveExistingRelation: true,
    });

    await expect(
      prisma.externalResourceLink.findUniqueOrThrow({
        where: {
          issueId_externalResourceId: {
            issueId: issue.id,
            externalResourceId: resource.id,
          },
        },
      }),
    ).resolves.toMatchObject({ kind: "FIXES" });
    expect(
      await prisma.activityEvent.count({
        where: { workspaceId: fixture.workspace.id, subjectId: issue.id },
      }),
    ).toBe(activityAfterFixes);

    await linkExternalResourceToIssue(prisma, { ...relation, kind: "RELATES_TO" });
    await expect(
      prisma.externalResourceLink.findUniqueOrThrow({
        where: {
          issueId_externalResourceId: {
            issueId: issue.id,
            externalResourceId: resource.id,
          },
        },
      }),
    ).resolves.toMatchObject({ kind: "FIXES" });
  });

  it("preserves imported SOURCE identity when derived relations are replayed", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const resource = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 119,
        url: "https://github.com/acme/forge/pull/119",
        title: "Imported pull request",
        state: "open",
      },
    });
    const relation = {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      actor: { actorId: fixture.user.id },
    };

    await linkExternalResourceToIssue(prisma, { ...relation, kind: "SOURCE" });
    await linkExternalResourceToIssue(prisma, { ...relation, kind: "FIXES" });

    await expect(
      prisma.externalResourceLink.findUniqueOrThrow({
        where: {
          issueId_externalResourceId: {
            issueId: issue.id,
            externalResourceId: resource.id,
          },
        },
      }),
    ).resolves.toMatchObject({ kind: "SOURCE" });
  });

  it("dismisses stale completion requests when the last implementation PR is reclassified", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const resource = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 120,
        url: "https://github.com/acme/forge/pull/120",
        title: "Implementation pull request",
        state: "merged",
      },
    });
    const relation = {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      actor: { actorId: fixture.user.id },
    };

    await linkExternalResourceToIssue(prisma, { ...relation, kind: "IMPLEMENTS" });
    const request = await prisma.actionRequest.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        title: "Ready to close",
        sourceType: "completion-candidate",
        sourceId: resource.id,
        dedupeKey: `issue-completion:${issue.id}`,
      },
    });

    await linkExternalResourceToIssue(prisma, { ...relation, kind: "RELEASES" });

    await expect(
      prisma.actionRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({
      status: "DISMISSED",
      resolution: "The linked pull request is no longer implementation evidence.",
    });
  });

  it("keeps SOURCE identity when duplicate GitHub resources are canonicalized", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const source = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 121,
        url: "https://github.com/acme/forge/pull/121",
        title: "Canonical source",
        state: "open",
        externalUpdatedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const duplicate = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "ACME/FORGE",
        number: 121,
        url: "https://github.com/ACME/FORGE/pull/121",
        title: "Duplicate relation",
        state: "open",
        externalUpdatedAt: new Date("2026-07-16T11:00:00Z"),
      },
    });
    await prisma.externalResourceLink.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          externalResourceId: source.id,
          kind: "SOURCE",
        },
        {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          externalResourceId: duplicate.id,
          kind: "FIXES",
        },
      ],
    });
    const request = await prisma.actionRequest.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        title: "Stale canonicalization candidate",
        sourceType: "completion-candidate",
        sourceId: duplicate.id,
        dedupeKey: `issue-completion:${issue.id}`,
      },
    });

    await canonicalizeGitHubResourceIdentity(prisma, {
      workspaceId: fixture.workspace.id,
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 121,
        url: source.url,
        title: source.title,
        state: "open",
      },
    });

    await expect(
      prisma.externalResourceLink.findUniqueOrThrow({
        where: {
          issueId_externalResourceId: { issueId: issue.id, externalResourceId: source.id },
        },
      }),
    ).resolves.toMatchObject({ kind: "SOURCE" });
    await expect(
      prisma.externalResource.findUnique({ where: { id: duplicate.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.actionRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({
      status: "DISMISSED",
      resolution: "The canonical GitHub source is no longer implementation evidence.",
    });
  });

  it("keeps imported SOURCE pull requests eligible for mapped status synchronization", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "GY" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const targetStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "IN_PROGRESS" },
    });
    const resource = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 122,
        url: "https://github.com/acme/forge/pull/122",
        title: "Imported source",
        state: "open",
      },
    });
    await linkExternalResourceToIssue(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      externalResourceId: resource.id,
      kind: "SOURCE",
      actor: { actorId: fixture.user.id },
    });

    await applyGitHubSnapshotToLinkedIssues({
      tx: prisma,
      workspaceId: fixture.workspace.id,
      resourceId: resource.id,
      mapping: { config: null },
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: resource.repoFullName,
        number: resource.number,
        url: resource.url,
        title: resource.title,
        state: resource.state,
      },
      actor: { actorId: fixture.user.id },
      statusRuleId: targetStatus.id,
    });

    await expect(
      prisma.issue.findUniqueOrThrow({ where: { id: issue.id } }),
    ).resolves.toMatchObject({
      statusId: targetStatus.id,
    });
  });
});
