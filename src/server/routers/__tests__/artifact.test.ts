import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ArtifactStatus, ArtifactType, ChatRole } from "@prisma/client";
import { artifactRouter } from "@/server/routers/artifact";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "ART" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const ctx = await buildContext(fixture);
  const caller = artifactRouter.createCaller(ctx);
  return { fixture, prisma, ctx, caller };
}

describe("artifactRouter", () => {
  it("creates an artifact with version 1 and emits an audit log", async () => {
    const { fixture, prisma, caller } = await setup();
    const result = await caller.create({
      title: "Auth Decision",
      body: "## Decision\nUse session cookies + Authelia.",
      type: ArtifactType.DECISION,
    });
    expect(result.slug).toBe("auth-decision");

    const artifact = await prisma.artifact.findUniqueOrThrow({
      where: { id: result.id },
      include: { versions: true },
    });
    expect(artifact.workspaceId).toBe(fixture.workspace.id);
    expect(artifact.status).toBe(ArtifactStatus.DRAFT);
    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0].version).toBe(1);
    expect(artifact.currentVersionId).toBe(artifact.versions[0].id);

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: fixture.workspace.id, entity: "artifact", entityId: result.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.action).toBe("created");
  });

  it("auto-resolves slug collisions by appending -2, -3, …", async () => {
    const { caller } = await setup();
    const a = await caller.create({ title: "Same Title", body: "1" });
    const b = await caller.create({ title: "Same Title", body: "2" });
    const c = await caller.create({ title: "Same Title", body: "3" });
    expect(a.slug).toBe("same-title");
    expect(b.slug).toBe("same-title-2");
    expect(c.slug).toBe("same-title-3");
  });

  it("snapshots a new version on body change", async () => {
    const { prisma, caller } = await setup();
    const { id } = await caller.create({ title: "Spec", body: "v1 body" });
    await caller.update({ id, body: "v2 body", changelog: "minor fix" });
    const versions = await prisma.artifactVersion.findMany({
      where: { artifactId: id },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(1);
    expect(versions[1].version).toBe(2);
    expect(versions[1].changelog).toBe("minor fix");
    const head = await prisma.artifact.findUniqueOrThrow({ where: { id } });
    expect(head.body).toBe("v2 body");
    expect(head.currentVersionId).toBe(versions[1].id);
  });

  it("does not snapshot when only status/title change", async () => {
    const { prisma, caller } = await setup();
    const { id } = await caller.create({ title: "Spec", body: "v1" });
    await caller.update({ id, title: "Spec v2", status: ArtifactStatus.IN_REVIEW });
    const versions = await prisma.artifactVersion.findMany({ where: { artifactId: id } });
    expect(versions).toHaveLength(1);
    const head = await prisma.artifact.findUniqueOrThrow({ where: { id } });
    expect(head.title).toBe("Spec v2");
    expect(head.status).toBe(ArtifactStatus.IN_REVIEW);
  });

  it("archives an artifact and flips status to ARCHIVED", async () => {
    const { prisma, caller } = await setup();
    const { id } = await caller.create({ title: "Doomed", body: "x" });
    await caller.archive({ id });
    const head = await prisma.artifact.findUniqueOrThrow({ where: { id } });
    expect(head.archivedAt).not.toBeNull();
    expect(head.status).toBe(ArtifactStatus.ARCHIVED);
  });

  it("hides archived rows from list() by default", async () => {
    const { caller } = await setup();
    const { id } = await caller.create({ title: "Living", body: "alive" });
    const dead = await caller.create({ title: "Dead", body: "rip" });
    await caller.archive({ id: dead.id });
    const list = await caller.list({ limit: 50 });
    expect(list.items.find((row) => row.id === id)).toBeTruthy();
    expect(list.items.find((row) => row.id === dead.id)).toBeUndefined();
    const all = await caller.list({ limit: 50, includeArchived: true });
    expect(all.items.find((row) => row.id === dead.id)).toBeTruthy();
  });

  it("promotes a chat message into an artifact and preserves the source ref", async () => {
    const { fixture, prisma, caller } = await setup();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `prom-${Date.now()}`,
        name: "Promoter",
      },
    });
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        agentId: agent.id,
        title: "Plan review",
      },
    });
    const message = await prisma.chatMessage.create({
      data: {
        workspaceId: fixture.workspace.id,
        threadId: thread.id,
        role: ChatRole.AGENT,
        body: "Here is the proposed migration plan…",
      },
    });
    const result = await caller.promoteFromSource({
      sourceType: "chat-message",
      sourceId: message.id,
      type: ArtifactType.SPEC,
    });
    const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: result.id } });
    expect(artifact.sourceType).toBe("chat-message");
    expect(artifact.sourceId).toBe(message.id);
    expect(artifact.body).toContain("proposed migration plan");
    expect(artifact.type).toBe(ArtifactType.SPEC);
  });

  it("links an artifact to an issue when issueId is provided", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    const { id } = await caller.create({
      title: "Verification log",
      body: "All checks green.",
      type: ArtifactType.VERIFICATION,
      issueId: issue.id,
    });
    const list = await caller.list({ issueId: issue.id });
    expect(list.items.find((row) => row.id === id)).toBeTruthy();
  });
});
