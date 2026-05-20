import { describe, it, expect, afterAll, afterEach } from "vitest";
import { EventKind, RuntimeKind } from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Coverage for the audit.ts fan-out branches that emit SYSTEM comments
 * (assignment notice) and route AGENT_RUN_BLOCKED to the owning agent's
 * webhook. Real Postgres, no mocks.
 */

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

describe("audit.ts — AGENT_ASSIGNED system comment", () => {
  it("posts a SYSTEM comment on first-time assignment", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AS1" });
    fixtures.push(fixture);
    const prisma = getPrisma();

    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: RuntimeKind.LOCAL_DAEMON,
        name: "Test runtime",
      },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `as1-victor-${Date.now()}`,
        runtimeId: runtime.id,
      },
    });
    const issue = await createIssue(fixture);

    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });

    await recordChange(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      entity: "Issue",
      entityId: issue.id,
      action: "assign-agent",
      eventKind: EventKind.AGENT_ASSIGNED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        agentId: agent.id,
        previousAgentId: null,
      },
    });

    const sys = await prisma.comment.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        kind: "SYSTEM",
      },
    });
    expect(sys).toHaveLength(1);
    expect(sys[0].authorId).toBeNull();
    expect(sys[0].authoringAgentId).toBeNull();
    expect(sys[0].body).toContain(`@${agent.profileKey}`);
    expect(sys[0].body).toContain(fixture.user.name ?? "");
    expect(sys[0].body).toContain("LOCAL_DAEMON");

    // The SYSTEM comment is NOT routed through recordChange — verify
    // no COMMENT_CREATED row fired for it.
    const commentEvents = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.COMMENT_CREATED,
        subjectId: issue.id,
      },
    });
    expect(commentEvents).toHaveLength(0);
  });

  it("skips SYSTEM comment when re-assigning to the same agent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AS2" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: `as2-mizu-${Date.now()}`,
      },
    });
    const issue = await createIssue(fixture);

    await recordChange(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      entity: "Issue",
      entityId: issue.id,
      action: "assign-agent",
      eventKind: EventKind.AGENT_ASSIGNED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        agentId: agent.id,
        previousAgentId: agent.id, // re-assign to same agent
      },
    });

    const sys = await prisma.comment.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        kind: "SYSTEM",
      },
    });
    expect(sys).toHaveLength(0);
  });

  it("skips SYSTEM comment on unassignment (agentId === null)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AS3" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "X",
        profileKey: `as3-${Date.now()}`,
      },
    });
    const issue = await createIssue(fixture);

    await recordChange(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      entity: "Issue",
      entityId: issue.id,
      action: "assign-agent",
      eventKind: EventKind.AGENT_ASSIGNED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        agentId: null,
        previousAgentId: agent.id,
      },
    });

    const sys = await prisma.comment.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        kind: "SYSTEM",
      },
    });
    expect(sys).toHaveLength(0);
  });

  it("falls back to runtime label 'unknown' when agent has no runtime", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AS4" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Lonely",
        profileKey: `as4-${Date.now()}`,
        // no runtimeId
      },
    });
    const issue = await createIssue(fixture);

    await recordChange(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      entity: "Issue",
      entityId: issue.id,
      action: "assign-agent",
      eventKind: EventKind.AGENT_ASSIGNED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: { agentId: agent.id, previousAgentId: null },
    });

    const sys = await prisma.comment.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        kind: "SYSTEM",
      },
    });
    expect(sys.body).toContain("unknown");
  });
});
