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
    expect(sys[0].body).toContain("_Runtime: local daemon._");

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

  it("omits the runtime label when agent has no runtime", async () => {
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
    expect(sys.body).not.toContain("_Runtime:");
    expect(sys.body).not.toContain("unknown");
  });
});

describe("audit.ts — watcher fan-out", () => {
  it("does not open canonical agent work for low-signal issue status changes", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "WF1" });
    fixtures.push(fixture);
    const prisma = getPrisma();

    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `wf1-victor-${Date.now()}`,
        webhookUrl: "https://example.invalid/webhook",
        webhookSecret: "test-secret",
      },
    });
    const issue = await createIssue(fixture);
    await prisma.issueWatcher.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
      },
    });

    await recordChange(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      entity: "Issue",
      entityId: issue.id,
      action: "transition",
      eventKind: EventKind.ISSUE_STATUS_CHANGED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: { from: "TODO", to: "IN_PROGRESS" },
    });

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_STATUS_CHANGED,
        subjectId: issue.id,
      },
      orderBy: { createdAt: "desc" },
    });

    const runs = await prisma.agentRun.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        triggerEventId: event.id,
      },
    });
    expect(runs).toHaveLength(0);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        eventId: event.id,
        webhook: {
          workspaceId: fixture.workspace.id,
          url: { startsWith: "agent:dispatch" },
        },
      },
    });
    expect(deliveries).toHaveLength(0);
  });

  it("does not re-page watchers for rolling STATUS comment updates", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "WF2" });
    fixtures.push(fixture);
    const prisma = getPrisma();

    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `wf2-victor-${Date.now()}`,
        webhookUrl: "https://example.invalid/webhook",
        webhookSecret: "test-secret",
      },
    });
    const issue = await createIssue(fixture);
    await prisma.issueWatcher.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
      },
    });

    await recordChange(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      actorAgentId: agent.id,
      entity: "Comment",
      entityId: "status-comment-id",
      action: "update-status",
      eventKind: EventKind.COMMENT_UPDATED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        commentId: "status-comment-id",
        issueId: issue.id,
        kind: "STATUS",
        currentStep: "still verifying",
      },
    });

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.COMMENT_UPDATED,
        subjectId: issue.id,
      },
      orderBy: { createdAt: "desc" },
    });

    const runs = await prisma.agentRun.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        triggerEventId: event.id,
      },
    });
    expect(runs).toHaveLength(0);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        eventId: event.id,
        webhook: {
          workspaceId: fixture.workspace.id,
          url: { startsWith: "agent:dispatch" },
        },
      },
    });
    expect(deliveries).toHaveLength(0);
  });

  it("still opens canonical work for watched body comments", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "WF3" });
    fixtures.push(fixture);
    const prisma = getPrisma();

    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `wf3-victor-${Date.now()}`,
        webhookUrl: "https://example.invalid/webhook",
        webhookSecret: "test-secret",
      },
    });
    const issue = await createIssue(fixture);
    await prisma.issueWatcher.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
      },
    });

    await recordChange(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      entity: "Comment",
      entityId: "body-comment-id",
      action: "create",
      eventKind: EventKind.COMMENT_CREATED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        commentId: "body-comment-id",
        issueId: issue.id,
        kind: "BODY",
      },
    });

    const run = await prisma.agentRun.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
      },
    });
    expect(run).toBeTruthy();
    expect(run?.triggerKind).toBe(EventKind.COMMENT_CREATED);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        webhook: {
          workspaceId: fixture.workspace.id,
          url: { startsWith: "agent:dispatch" },
        },
      },
    });
    expect(deliveries).toHaveLength(1);
  });
});
