import { afterAll, afterEach, describe, expect, it } from "vitest";
import { linkExternalResourceToIssue } from "@/server/services/github/resource-sync";
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
    ).resolves.toMatchObject({ kind: "RELATES_TO" });
  });
});
