import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ActionRequestKind,
  ActionRequestStatus,
  NotificationSeverity,
  ProjectAccessRole,
  ProjectVisibility,
} from "@prisma/client";
import { commandCenterRouter } from "@/server/routers/command-center";
import { actionRequestRouter } from "@/server/routers/action-request";
import { sweepStaleWorkSessions } from "@/server/services/work-session";
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
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("commandCenterRouter — action requests", () => {
  it("does not expose an action request through an inaccessible plan source", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CAP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
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
    const plan = await prisma.executionPlan.create({
      data: { workspaceId: fixture.workspace.id, projectId: project.id, title: "Private plan" },
    });
    const request = await prisma.actionRequest.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Approve private plan",
        sourceType: "execution-plan",
        sourceId: plan.id,
      },
    });
    const caller = actionRequestRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );

    await expect(caller.forPlan({ planId: plan.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        membershipId: membership.id,
        role: ProjectAccessRole.VIEWER,
        grantedById: fixture.user.id,
      },
    });
    await expect(caller.forPlan({ planId: plan.id })).resolves.toMatchObject({ id: request.id });
  });

  it("filters restricted action requests, active runs, and their counts until access is granted", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CCP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
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
    const issue = await createIssue(fixture, { projectId: project.id, title: "Private decision" });
    const agent = await prisma.agent.create({
      data: { workspaceId: fixture.workspace.id, name: "Private", profileKey: "private-cc" },
    });
    await prisma.agentRun.create({
      data: { workspaceId: fixture.workspace.id, issueId: issue.id, agentId: agent.id },
    });
    await prisma.actionRequest.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        assignedUserId: fixture.secondUser.id,
        title: "Private ask",
      },
    });
    const caller = commandCenterRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );

    let summary = await caller.summary({ limit: 20, dueWindowDays: 7 });
    expect(summary.actionRequests).toEqual([]);
    expect(summary.activeRuns).toEqual([]);
    expect(summary.counts.actionRequests).toBe(0);
    expect(summary.counts.activeRuns).toBe(0);

    await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        membershipId: membership.id,
        role: ProjectAccessRole.VIEWER,
        grantedById: fixture.user.id,
      },
    });
    summary = await caller.summary({ limit: 20, dueWindowDays: 7 });
    expect(summary.actionRequests).toHaveLength(1);
    expect(summary.activeRuns).toHaveLength(1);
    expect(summary.counts.actionRequests).toBe(1);
    expect(summary.counts.activeRuns).toBe(1);
  });

  it("returns work-session recovery actions instead of a navigation-only fallback", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // createIssue allocates max(number) + 1 for a fixture. Keep these
    // sequential so the test does not manufacture a duplicate issue number.
    const issues = [
      await createIssue(fixture, { title: "Quiet delivery" }),
      await createIssue(fixture, { title: "Stale delivery" }),
    ];
    const sessions = await Promise.all(
      ["quiet", "stale"].map((suffix, index) =>
        prisma.workSession.create({
          data: {
            workspaceId: fixture.workspace.id,
            issueId: issues[index].id,
            ownerUserId: fixture.user.id,
            source: "MCP",
            status: index === 0 ? "IN_PROGRESS" : "STALE",
            repoFullName: "Codename-11/Forge",
            branch: `codex/test-${suffix}-${issues[index].id}`,
            baseBranch: "main",
          },
        }),
      ),
    );
    const rows = await Promise.all(
      ["MCP status is unconfirmed", "Work session went quiet"].map((title, index) =>
        prisma.actionRequest.create({
          data: {
            workspaceId: fixture.workspace.id,
            issueId: issues[index].id,
            assignedUserId: fixture.user.id,
            title,
            body: `${title} requires an explicit operator decision.`,
            status: ActionRequestStatus.OPEN,
            severity: index === 0 ? NotificationSeverity.WARNING : NotificationSeverity.INFO,
            kind: ActionRequestKind.FREE_FORM,
            sourceType: "work-session",
            sourceId: sessions[index].id,
            dedupeKey:
              index === 0
                ? `work-session-mcp-quiet:${sessions[index].id}`
                : `work-session-stale:${sessions[index].id}`,
          },
        }),
      ),
    );
    const caller = commandCenterRouter.createCaller(await buildContext(fixture));

    const summary = await caller.summary({ dueWindowDays: 7, limit: 20 });
    const returned = summary.actionRequests.filter((request) =>
      rows.some((row) => row.id === request.id),
    );

    expect(returned.map((request) => request.id).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(summary.counts.actionRequests).toBe(2);
    for (const request of returned) {
      expect(request.presentation.protocol).toBe("WORK_SESSION_RECOVERY");
      expect(request.presentation.actions.map((action) => action.id)).toEqual([
        request.dedupeKey?.startsWith("work-session-stale:") ? "RESUME_SESSION" : "CONFIRM_ACTIVE",
        "ABANDON_SESSION",
        "RESPOND_IN_ISSUE",
        "DISMISS",
        "OPEN_ISSUE",
      ]);
    }
  });

  it("records operator confirmation without changing MCP lifecycle evidence", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Quiet delivery" });
    const session = await prisma.workSession.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        ownerUserId: fixture.user.id,
        source: "MCP",
        status: "IN_PROGRESS",
        repoFullName: "Codename-11/Forge",
        branch: `codex/quiet-${issue.id}`,
        baseBranch: "main",
        lastHeartbeatAt: new Date(Date.now() - 3 * 60 * 60_000),
      },
    });
    const request = await prisma.actionRequest.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        assignedUserId: fixture.user.id,
        title: "MCP status is unconfirmed",
        status: ActionRequestStatus.OPEN,
        severity: NotificationSeverity.WARNING,
        kind: ActionRequestKind.FREE_FORM,
        sourceType: "work-session",
        sourceId: session.id,
        dedupeKey: `work-session-mcp-quiet:${session.id}`,
      },
    });
    const beforeHeartbeat = session.lastHeartbeatAt;
    const caller = actionRequestRouter.createCaller(await buildContext(fixture));

    await caller.resolveWorkSessionAttention({
      id: request.id,
      decision: "CONFIRM_ACTIVE",
    });

    await expect(
      prisma.workSession.findUniqueOrThrow({ where: { id: session.id } }),
    ).resolves.toMatchObject({
      status: "IN_PROGRESS",
      lastHeartbeatAt: beforeHeartbeat,
      operatorConfirmedAt: expect.any(Date),
    });
    await expect(
      prisma.actionRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({
      status: ActionRequestStatus.RESOLVED,
      resolvedByUserId: fixture.user.id,
    });
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { workSessionStaleMinutes: 1 },
    });
    await sweepStaleWorkSessions(prisma);
    await expect(
      prisma.actionRequest.count({
        where: {
          workspaceId: fixture.workspace.id,
          status: ActionRequestStatus.OPEN,
          sourceId: session.id,
        },
      }),
    ).resolves.toBe(0);
  });
});
