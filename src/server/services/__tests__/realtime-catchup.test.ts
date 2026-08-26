import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventKind, ProjectAccessRole, ProjectVisibility } from "@prisma/client";
import {
  compareRealtimeCursors,
  decodeRealtimeCursor,
  encodeRealtimeCursor,
  loadRealtimeCatchup,
} from "@/server/realtime-catchup";
import { canReadProjectDerivedRecord } from "@/server/services/derived-project-access";
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

describe("realtime durable catch-up", () => {
  it("round-trips opaque cursors and rejects malformed input", () => {
    const cursor = {
      at: "2026-07-13T12:00:00.000Z",
      source: "run" as const,
      id: "event-123",
    };
    expect(decodeRealtimeCursor(encodeRealtimeCursor(cursor))).toEqual(cursor);
    expect(decodeRealtimeCursor("not-a-cursor")).toBeNull();
    expect(
      compareRealtimeCursors(
        { ...cursor, source: "activity", id: "z" },
        { ...cursor, source: "run", id: "a" },
      ),
    ).toBeLessThan(0);
  });

  it("merges missed activity and granular run rows without crossing tenants", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RTC" });
    const other = await createWorkspaceFixture({ keyPrefix: "RTO" });
    fixtures.push(fixture, other);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const otherIssue = await createIssue(other);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Realtime agent",
        profileKey: "realtime-agent",
      },
    });
    const otherAgent = await prisma.agent.create({
      data: {
        workspaceId: other.workspace.id,
        name: "Other agent",
        profileKey: "other-realtime-agent",
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        currentStep: "verifying",
      },
    });
    const otherRun = await prisma.agentRun.create({
      data: {
        workspaceId: other.workspace.id,
        issueId: otherIssue.id,
        agentId: otherAgent.id,
      },
    });
    const base = new Date("2026-07-13T12:00:00.000Z");
    const activity = await prisma.activityEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_UPDATED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { title: "Updated" },
        createdAt: new Date(base.getTime() + 1_000),
      },
    });
    const runEvent = await prisma.agentRunEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        runId: run.id,
        kind: "TOOL_CALL",
        payload: { tool: "typecheck" },
        createdAt: new Date(base.getTime() + 2_000),
      },
    });
    await prisma.agentRunEvent.create({
      data: {
        workspaceId: other.workspace.id,
        runId: otherRun.id,
        kind: "STEP",
        createdAt: new Date(base.getTime() + 1_500),
      },
    });

    const result = await loadRealtimeCatchup(prisma, fixture.workspace.id, {
      at: base.toISOString(),
      source: "activity",
      id: "before",
    });

    expect(result.truncated).toBe(false);
    expect(result.events.map((event) => event.id)).toEqual([activity.id, runEvent.id]);
    expect(result.events[1]).toMatchObject({
      kind: EventKind.AGENT_RUN_STEP,
      subjectType: "agent-run",
      subjectId: run.id,
      payload: {
        eventKind: "TOOL_CALL",
        currentStep: "verifying",
        issueId: issue.id,
        agentId: agent.id,
        replayed: true,
      },
    });
    expect(result.events.every((event) => decodeRealtimeCursor(event.cursor))).toBe(true);
  });

  it("signals a bounded replay overflow so clients can reconcile", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RTL" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const base = new Date("2026-07-13T12:00:00.000Z");
    await prisma.activityEvent.createMany({
      data: [1, 2, 3].map((second) => ({
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_UPDATED,
        subjectType: "workspace",
        subjectId: fixture.workspace.id,
        payload: { second },
        createdAt: new Date(base.getTime() + second * 1_000),
      })),
    });

    const result = await loadRealtimeCatchup(
      prisma,
      fixture.workspace.id,
      { at: base.toISOString(), source: "activity", id: "before" },
      2,
    );
    expect(result.events).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("filters restricted issue activity and run events immediately after grant revocation", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RTP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
      select: { id: true, role: true },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PRIVATE",
        name: "Private",
        visibility: ProjectVisibility.RESTRICTED,
        createdById: fixture.user.id,
      },
    });
    const issue = await createIssue(fixture, { projectId: project.id });
    const agent = await prisma.agent.create({
      data: { workspaceId: fixture.workspace.id, name: "Private agent", profileKey: "private" },
    });
    const run = await prisma.agentRun.create({
      data: { workspaceId: fixture.workspace.id, issueId: issue.id, agentId: agent.id },
    });
    const base = new Date("2026-08-25T12:00:00.000Z");
    const activity = await prisma.activityEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_UPDATED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { issueId: issue.id },
        createdAt: new Date(base.getTime() + 1_000),
      },
    });
    await prisma.agentRunEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        runId: run.id,
        kind: "STEP",
        createdAt: new Date(base.getTime() + 2_000),
      },
    });
    const replay = () =>
      loadRealtimeCatchup(
        prisma,
        fixture.workspace.id,
        { at: base.toISOString(), source: "activity", id: "before" },
        500,
        membership,
      );

    expect((await replay()).events).toEqual([]);
    await expect(
      canReadProjectDerivedRecord(
        prisma,
        { workspaceId: fixture.workspace.id, membership },
        activity,
      ),
    ).resolves.toBe(false);
    const grant = await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        membershipId: membership.id,
        role: ProjectAccessRole.VIEWER,
        grantedById: fixture.user.id,
      },
    });
    expect((await replay()).events).toHaveLength(2);
    await expect(
      canReadProjectDerivedRecord(
        prisma,
        { workspaceId: fixture.workspace.id, membership },
        activity,
      ),
    ).resolves.toBe(true);
    await prisma.projectAccess.delete({ where: { id: grant.id } });
    expect((await replay()).events).toEqual([]);
  });
});
