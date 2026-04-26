import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentStatus, AutoDispatchMode, EventKind } from "@prisma/client";
import { checkRequiredAck } from "@/server/services/required-ack";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the required-ack watchdog. Mirrors
 * stale-work.test.ts — real Postgres, no mocks, one workspace per
 * test so the tenant-scoped check doesn't cross-talk in parallel.
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

async function setAck(
  workspaceId: string,
  seconds: number,
  redispatch = false,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      requiredAckSeconds: seconds,
      autoRedispatchOnNoack: redispatch,
    },
  });
}

async function createAgent(
  workspaceId: string,
  profileKey: string,
): Promise<{ id: string; profileKey: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: profileKey,
      profileKey,
      status: AgentStatus.ONLINE,
    },
    select: { id: true, profileKey: true },
  });
}

/**
 * Plant an AGENT_ASSIGNED event for the given issue + agent. We bypass
 * `recordChange` here because the production path also fans out webhook
 * deliveries, which would muddy the test assertions; for these tests the
 * event row alone is enough.
 */
async function plantAssignedEvent(
  workspaceId: string,
  issueId: string,
  agentId: string,
  agentProfileKey: string,
  createdAt: Date = new Date(Date.now() - 5 * 60_000),
): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.activityEvent.create({
    data: {
      workspaceId,
      kind: EventKind.AGENT_ASSIGNED,
      subjectType: "issue",
      subjectId: issueId,
      payload: { agentId, agentProfileKey },
      createdAt,
    },
    select: { id: true },
  });
}

describe("required-ack — checkRequiredAck", () => {
  it("is a no-op when requiredAckSeconds == 0", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RAA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // Default of 0; do not opt in.
    const agent = await createAgent(fixture.workspace.id, "raa-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    const evt = await plantAssignedEvent(
      fixture.workspace.id,
      issue.id,
      agent.id,
      agent.profileKey,
    );

    const res = await checkRequiredAck({ agentAssignedEventId: evt.id });
    expect(res.acked).toBe(true);

    const noackEvents = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_NOACK,
      },
    });
    expect(noackEvents.length).toBe(0);
  });

  it("treats a comment from the assigned agent as ack", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RAB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setAck(fixture.workspace.id, 60);

    const agent = await createAgent(fixture.workspace.id, "rab-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    const evt = await plantAssignedEvent(
      fixture.workspace.id,
      issue.id,
      agent.id,
      agent.profileKey,
      new Date(Date.now() - 10 * 60_000),
    );

    // Plant a comment authored by the agent + a COMMENT_CREATED event
    // that points to it. The check joins through commentId in payload.
    const comment = await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        authorId: fixture.user.id,
        authoringAgentId: agent.id,
        body: "on it",
      },
    });
    await prisma.activityEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.COMMENT_CREATED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { commentId: comment.id, issueId: issue.id },
      },
    });

    const res = await checkRequiredAck({ agentAssignedEventId: evt.id });
    expect(res.acked).toBe(true);
    expect(res.ackKind).toBe("comment");

    const noackEvents = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_NOACK,
      },
    });
    expect(noackEvents.length).toBe(0);
  });

  it("treats a status transition as ack", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RAC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setAck(fixture.workspace.id, 60);

    const agent = await createAgent(fixture.workspace.id, "rac-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    const evt = await plantAssignedEvent(
      fixture.workspace.id,
      issue.id,
      agent.id,
      agent.profileKey,
      new Date(Date.now() - 10 * 60_000),
    );

    // Plant an ISSUE_STATUS_CHANGED event with a non-null actor — that's
    // the heuristic the check uses for "the work moved by someone".
    await prisma.activityEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_STATUS_CHANGED,
        actorId: fixture.user.id,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { from: "TODO", to: "IN_PROGRESS" },
      },
    });

    const res = await checkRequiredAck({ agentAssignedEventId: evt.id });
    expect(res.acked).toBe(true);
    expect(res.ackKind).toBe("status_change");
  });

  it("emits AGENT_NOACK when nothing happens within the window", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RAD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setAck(fixture.workspace.id, 60);

    const agent = await createAgent(fixture.workspace.id, "rad-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    const evt = await plantAssignedEvent(
      fixture.workspace.id,
      issue.id,
      agent.id,
      agent.profileKey,
      new Date(Date.now() - 10 * 60_000),
    );

    const res = await checkRequiredAck({ agentAssignedEventId: evt.id });
    expect(res.acked).toBe(false);
    expect(res.redispatched).toBe(false);

    const noackEvents = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_NOACK,
        subjectType: "issue",
        subjectId: issue.id,
      },
    });
    expect(noackEvents.length).toBe(1);
    const payload = noackEvents[0].payload as {
      agentId: string;
      agentProfileKey: string;
      requiredAckSeconds: number;
      originalAssignedEventId: string;
    };
    expect(payload.agentId).toBe(agent.id);
    expect(payload.agentProfileKey).toBe("rad-a1");
    expect(payload.requiredAckSeconds).toBe(60);
    expect(payload.originalAssignedEventId).toBe(evt.id);

    // assignedAgentId preserved when redispatch is off.
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.assignedAgentId).toBe(agent.id);
  });

  it("is idempotent — second check does not double-emit AGENT_NOACK", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RAE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setAck(fixture.workspace.id, 60);

    const agent = await createAgent(fixture.workspace.id, "rae-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    const evt = await plantAssignedEvent(
      fixture.workspace.id,
      issue.id,
      agent.id,
      agent.profileKey,
      new Date(Date.now() - 10 * 60_000),
    );

    const first = await checkRequiredAck({ agentAssignedEventId: evt.id });
    expect(first.acked).toBe(false);

    const second = await checkRequiredAck({ agentAssignedEventId: evt.id });
    expect(second.acked).toBe(false);
    expect(second.redispatched).toBe(false);

    const noackEvents = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_NOACK,
        subjectType: "issue",
        subjectId: issue.id,
      },
    });
    expect(noackEvents.length).toBe(1);
  });

  it("clears assignedAgentId and re-runs dispatcher when autoRedispatchOnNoack is true", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RAF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setAck(fixture.workspace.id, 60, true);
    // Turn auto-dispatch on so the dispatcher actually re-picks. With a
    // single eligible agent, ROUND_ROBIN puts the issue right back on
    // them — proves the clear+repick happened.
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: {
        autoDispatch: true,
        autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
      },
    });

    const agent = await createAgent(fixture.workspace.id, "raf-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id, queued: true },
    });
    const evt = await plantAssignedEvent(
      fixture.workspace.id,
      issue.id,
      agent.id,
      agent.profileKey,
      new Date(Date.now() - 10 * 60_000),
    );

    const res = await checkRequiredAck({ agentAssignedEventId: evt.id });
    expect(res.acked).toBe(false);
    expect(res.redispatched).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    // Either re-picked back to the same agent or null when nothing
    // matched — both prove the clear happened. With one eligible agent
    // the dispatcher should have re-assigned.
    expect(after.assignedAgentId).toBe(agent.id);

    const dispatchEvents = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: EventKind.AGENT_ASSIGNED,
      },
    });
    expect(dispatchEvents.length).toBeGreaterThanOrEqual(1);
  });
});
