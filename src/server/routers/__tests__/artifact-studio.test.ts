import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ArtifactRole, ArtifactVisibility } from "@prisma/client";
import { artifactRouter } from "@/server/routers/artifact";
import { findPublishedArtifactByToken } from "@/server/services/artifact-studio";
import { deleteAttachment } from "@/server/services/storage";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => disconnectPrisma());

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "AS" });
  fixtures.push(fixture);
  const owner = artifactRouter.createCaller(await buildContext(fixture));
  const member = artifactRouter.createCaller(
    await buildContext(fixture, { asUserId: fixture.secondUser.id }),
  );
  return { fixture, owner, member, prisma: getPrisma() };
}

describe("artifact studio", () => {
  it("keeps private artifacts private and applies explicit collaborator roles", async () => {
    const { fixture, owner, member } = await setup();
    const artifact = await owner.create({ title: "Private plan", body: "v1" });

    expect((await member.list({})).items).toHaveLength(0);
    await owner.setVisibility({ id: artifact.id, visibility: ArtifactVisibility.WORKSPACE });
    expect((await member.list({})).items.map((item) => item.id)).toContain(artifact.id);
    await expect(member.update({ id: artifact.id, body: "unauthorized" })).rejects.toThrow(
      /editor artifact access required/i,
    );

    await owner.setGrant({
      artifactId: artifact.id,
      userId: fixture.secondUser.id,
      role: ArtifactRole.EDITOR,
    });
    await expect(
      member.update({ id: artifact.id, body: "member revision" }),
    ).resolves.toMatchObject({
      version: 2,
    });
  });

  it("pins accepted and published versions while later drafts continue", async () => {
    const { fixture, owner, prisma } = await setup();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { artifactExternalSharingEnabled: true },
    });
    const artifact = await owner.create({ title: "Release brief", body: "v1" });
    const initial = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });

    await owner.update({ id: artifact.id, body: "v2", baseVersionId: initial.currentVersionId });
    await expect(
      owner.update({
        id: artifact.id,
        body: "stale write",
        baseVersionId: initial.currentVersionId,
      }),
    ).rejects.toThrow(/newer artifact version/i);

    await owner.requestReview({ id: artifact.id });
    const accepted = await owner.acceptVersion({ id: artifact.id });
    const publication = await owner.publishVersion({ id: artifact.id });
    expect(publication.token).toBeTruthy();
    expect((await findPublishedArtifactByToken(prisma, publication.token!))?.version.body).toBe(
      "v2",
    );

    await owner.update({ id: artifact.id, body: "v3 draft", baseVersionId: accepted.versionId });
    const afterDraft = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(afterDraft.publishedVersionId).toBe(accepted.versionId);
    expect((await findPublishedArtifactByToken(prisma, publication.token!))?.version.body).toBe(
      "v2",
    );

    await owner.revokePublication({ artifactId: artifact.id, publicationId: publication.id });
    expect(await findPublishedArtifactByToken(prisma, publication.token!)).toBeNull();
  });

  it("anchors comments and restores history as a new immutable revision", async () => {
    const { owner, prisma } = await setup();
    const artifact = await owner.create({ title: "Review notes", body: "first" });
    const v1 = await prisma.artifactVersion.findFirstOrThrow({
      where: { artifactId: artifact.id },
    });
    await owner.update({ id: artifact.id, body: "second", baseVersionId: v1.id });

    const comment = await owner.addComment({
      artifactId: artifact.id,
      versionId: v1.id,
      body: "Keep this paragraph.",
      anchor: { kind: "text", start: 0, end: 5 },
      quotedText: "first",
    });
    await owner.resolveComment({ artifactId: artifact.id, commentId: comment.id, resolved: true });
    expect(
      (await owner.listComments({ artifactId: artifact.id, includeResolved: true }))[0],
    ).toMatchObject({
      status: "RESOLVED",
      versionId: v1.id,
      quotedText: "first",
    });

    const current = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    await owner.restoreVersion({
      artifactId: artifact.id,
      versionId: v1.id,
      baseVersionId: current.currentVersionId,
    });
    const versions = await prisma.artifactVersion.findMany({
      where: { artifactId: artifact.id },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(3);
    expect(versions[2]).toMatchObject({ body: "first", restoredFromVersionId: v1.id });
    const comparison = await owner.compareVersions({
      artifactId: artifact.id,
      fromVersionId: versions[0].id,
      toVersionId: versions[1].id,
    });
    expect(comparison).toMatchObject({ kind: "text", from: { version: 1 }, to: { version: 2 } });
    expect(comparison.changes.some((change) => change.added)).toBe(true);
    const exported = await owner.exportVersion({
      artifactId: artifact.id,
      versionId: versions[0].id,
      format: "markdown",
    });
    expect(exported).toMatchObject({ filename: "review-notes-v1.md" });
    expect(exported.content).toContain("version: 1");
  });

  it("snapshots referenced assets and retains them for historical versions", async () => {
    const { fixture, owner, prisma } = await setup();
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: fixture.workspace.id,
        targetType: "artifact",
        targetId: "pending-artifact",
        filename: "diagram.png",
        mimeType: "image/png",
        size: 42,
        url: "artifact/pinned-diagram.png",
      },
    });
    const artifact = await owner.create({
      title: "Asset contract",
      body: `![Architecture](forge-attachment:${attachment.id})`,
    });
    const version = await prisma.artifactVersion.findFirstOrThrow({
      where: { artifactId: artifact.id },
    });
    expect(version.assetManifest).toEqual([
      expect.objectContaining({ id: attachment.id, filename: "diagram.png", position: 0 }),
    ]);
    await expect(deleteAttachment(attachment.id)).rejects.toThrow(/retained by Asset contract v1/);
    expect(await prisma.attachment.findUnique({ where: { id: attachment.id } })).not.toBeNull();
  });
});
