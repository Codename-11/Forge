import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ActionRequestKind,
  ActionRequestStatus,
  AgentProvider,
  AgentRunStatus,
  EngagementMode,
  RelationKind,
  Role,
  RunEngine,
  RuntimeKind,
} from "@prisma/client";
import { actionRequestRouter } from "@/server/routers/action-request";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration coverage for accept / decline:
 *   - ACL gating: assignee, watcher, OWNER/ADMIN, and a stranger
 *     (rejected). MEMBER who is neither assignee nor watcher also
 *     rejected.
 *   - Each ActionRequestKind dispatcher does what it claims:
 *     TRANSITION flips statusId, SET_LABELS adds/removes IssueLabel
 *     rows, ASSIGN replaces assignees, ASSIGN_AGENT sets the agent,
 *     ARCHIVE soft-deletes, CLOSE_AS_DUPLICATE writes a DUPLICATES
 *     IssueRelation row, RUNTIME_TOOL_GRANT queues a permissioned run.
 *   - Decline never dispatches.
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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "AR2" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const ctx = await buildContext(fixture);
  return {
    fixture,
    prisma,
    ctx,
    caller: actionRequestRouter.createCaller(ctx),
  };
}

describe("actionRequestRouter — accept ACL", () => {
  it("workspace OWNER can accept a request not assigned to them", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const status = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    // Assigned to the *second* user (a MEMBER), but the caller is OWNER.
    const { id } = await caller.create({
      title: "Mark Done",
      kind: ActionRequestKind.TRANSITION,
      payload: { statusId: status.id },
      assignedUserId: fixture.secondUser.id,
      issueId: issue.id,
    });
    const res = await caller.accept({ id });
    expect(res.dispatched).toBe(true);
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.statusId).toBe(status.id);
  });

  it("rejects a non-assignee, non-watcher MEMBER", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture);
    const status = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    const ownerCtx = await buildContext(fixture);
    const ownerCaller = actionRequestRouter.createCaller(ownerCtx);
    const { id } = await ownerCaller.create({
      title: "Mark Done",
      kind: ActionRequestKind.TRANSITION,
      payload: { statusId: status.id },
      issueId: issue.id,
    });
    // Demote the secondUser to a stranger context (still MEMBER per
    // fixture, but never assigned or set as a watcher).
    const memberCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const memberCaller = actionRequestRouter.createCaller(memberCtx);
    await expect(memberCaller.accept({ id })).rejects.toThrow(/permission/i);
  });

  it("a watcher (non-OWNER) can accept", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture);
    const status = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    // OWNER opens the request, MEMBER becomes a watcher, then MEMBER accepts.
    const ownerCtx = await buildContext(fixture);
    const ownerCaller = actionRequestRouter.createCaller(ownerCtx);
    const { id } = await ownerCaller.create({
      title: "Mark Done",
      kind: ActionRequestKind.TRANSITION,
      payload: { statusId: status.id },
      issueId: issue.id,
    });
    await prisma.issueWatcher.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        userId: fixture.secondUser.id,
      },
    });
    const memberCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const memberCaller = actionRequestRouter.createCaller(memberCtx);
    const res = await memberCaller.accept({ id });
    expect(res.dispatched).toBe(true);
  });

  it("an ADMIN MEMBER (not assignee, not watcher) can accept", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture);
    const status = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    // Promote secondUser to ADMIN.
    await prisma.membership.update({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
      data: { role: Role.ADMIN },
    });
    const ownerCtx = await buildContext(fixture);
    const ownerCaller = actionRequestRouter.createCaller(ownerCtx);
    const { id } = await ownerCaller.create({
      title: "Mark Done",
      kind: ActionRequestKind.TRANSITION,
      payload: { statusId: status.id },
      issueId: issue.id,
    });
    const adminCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const adminCaller = actionRequestRouter.createCaller(adminCtx);
    const res = await adminCaller.accept({ id });
    expect(res.dispatched).toBe(true);
  });
});

describe("actionRequestRouter — kind dispatchers", () => {
  it("SET_LABELS adds and removes labels", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const addLabel = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "feature",
        color: "#ff8800",
      },
    });
    const removeLabel = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "stale",
        color: "#888888",
      },
    });
    await prisma.issueLabel.create({
      data: { issueId: issue.id, labelId: removeLabel.id },
    });
    const { id } = await caller.create({
      title: "Update labels",
      kind: ActionRequestKind.SET_LABELS,
      payload: { add: [addLabel.id], remove: [removeLabel.id] },
      issueId: issue.id,
    });
    await caller.accept({ id });
    const after = await prisma.issueLabel.findMany({ where: { issueId: issue.id } });
    const ids = after.map((r) => r.labelId);
    expect(ids).toContain(addLabel.id);
    expect(ids).not.toContain(removeLabel.id);
  });

  it("ASSIGN replaces assignees", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    // Pre-existing assignee (the OWNER) that the dispatch should clear.
    await prisma.issueAssignee.create({
      data: { issueId: issue.id, userId: fixture.user.id },
    });
    const { id } = await caller.create({
      title: "Assign to second user",
      kind: ActionRequestKind.ASSIGN,
      payload: { userIds: [fixture.secondUser.id] },
      issueId: issue.id,
    });
    await caller.accept({ id });
    const after = await prisma.issueAssignee.findMany({
      where: { issueId: issue.id },
    });
    expect(after.map((a) => a.userId).sort()).toEqual([fixture.secondUser.id]);
  });

  it("ASSIGN_AGENT sets assignedAgentId", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `victor-${Date.now()}`,
      },
    });
    const { id } = await caller.create({
      title: "Hand off to Victor",
      kind: ActionRequestKind.ASSIGN_AGENT,
      payload: { agentId: agent.id },
      issueId: issue.id,
    });
    await caller.accept({ id });
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.assignedAgentId).toBe(agent.id);
  });

  it("ARCHIVE soft-deletes the issue", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const { id } = await caller.create({
      title: "Archive this",
      kind: ActionRequestKind.ARCHIVE,
      issueId: issue.id,
    });
    await caller.accept({ id });
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.deletedAt).not.toBeNull();
  });

  it("CLOSE_AS_DUPLICATE writes a DUPLICATES relation", async () => {
    const { fixture, prisma, caller } = await setup();
    const source = await createIssue(fixture);
    const target = await createIssue(fixture);
    const canceled = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "CANCELED" },
    });
    const { id } = await caller.create({
      title: "Close as duplicate",
      kind: ActionRequestKind.CLOSE_AS_DUPLICATE,
      payload: { duplicateOfIssueId: target.id, statusId: canceled.id },
      issueId: source.id,
    });
    await caller.accept({ id });
    const relation = await prisma.issueRelation.findFirst({
      where: {
        fromIssueId: source.id,
        toIssueId: target.id,
        kind: RelationKind.DUPLICATES,
      },
    });
    expect(relation).not.toBeNull();
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: source.id } });
    expect(after.statusId).toBe(canceled.id);
  });

  it("TRANSITION dispatches statusId and updates lifecycle timestamps", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    const { id } = await caller.create({
      title: "Mark Done",
      kind: ActionRequestKind.TRANSITION,
      payload: { statusId: done.id },
      issueId: issue.id,
    });
    await caller.accept({ id });
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.statusId).toBe(done.id);
    expect(after.completedAt).not.toBeNull();
  });

  it("RUNTIME_TOOL_GRANT queues a one-time permissioned review run", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Hermes gateway",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: "http://127.0.0.1:8642/v1",
        providersAvailable: [AgentProvider.HERMES],
        config: {
          workspaceRoot: "/home/bailey/forge",
          localWorkspaceTools: true,
          toolCapabilities: ["terminal", "filesystem", "git"],
          modeToolPolicyEnforced: true,
          modeToolProfiles: {
            EXECUTE: ["terminal", "filesystem", "git"],
            REVIEW: [],
            RESEARCH: [],
            DISCUSS: [],
          },
        },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `victor-${Date.now()}`,
        provider: AgentProvider.HERMES,
        runEngine: RunEngine.RUNS,
        runtimeId: runtime.id,
      },
    });
    const staleRun = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        engagementMode: EngagementMode.REVIEW,
        currentStep: "blocked on missing repo tools",
      },
    });

    const { id } = await caller.create({
      title: "Enable read-only repo access",
      kind: ActionRequestKind.RUNTIME_TOOL_GRANT,
      issueId: issue.id,
      payload: {
        agentId: agent.id,
        mode: "REVIEW",
        tools: ["filesystem", "git", "terminal"],
        accessLevel: "READ_ONLY",
        scopePath: "/home/bailey/forge",
        reason: "Need file:line review findings.",
      },
    });
    const accepted = await caller.accept({ id });
    expect(accepted.dispatched).toBe(true);

    const oldRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: staleRun.id } });
    expect(oldRun.status).toBe(AgentRunStatus.ABANDONED);
    expect(oldRun.finishedAt).not.toBeNull();

    const nextRun = await prisma.agentRun.findFirstOrThrow({
      where: {
        issueId: issue.id,
        agentId: agent.id,
        id: { not: staleRun.id },
      },
      orderBy: { startedAt: "desc" },
    });
    expect(nextRun.status).toBe(AgentRunStatus.ACTIVE);
    expect(nextRun.engagementMode).toBe(EngagementMode.REVIEW);
    expect(nextRun.triggerKind).toBe("ACTION_REQUEST_ACCEPTED");
    expect(nextRun.runtimePolicy).toMatchObject({
      engagementMode: "REVIEW",
      allowedHostTools: ["terminal", "filesystem", "git"],
      toolGrant: {
        accessLevel: "READ_ONLY",
        scopePath: "/home/bailey/forge",
        actionRequestId: id,
      },
    });
  });

  it("RUNTIME_TOOL_GRANT supports Codex app-server sandbox-backed runtimes", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Codex app server",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "codex-app-server",
        endpoint: "ws://127.0.0.1:4505",
        providersAvailable: [AgentProvider.CODEX],
        config: {
          workspaceRoot: "/work",
          sandboxMode: "read-only",
          approvalPolicy: "on-request",
        },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Codex reviewer",
        profileKey: `codex-${Date.now()}`,
        provider: AgentProvider.CODEX,
        runEngine: RunEngine.RUNS,
        runtimeId: runtime.id,
      },
    });

    const { id } = await caller.create({
      title: "Grant scoped Codex repo review",
      kind: ActionRequestKind.RUNTIME_TOOL_GRANT,
      issueId: issue.id,
      payload: {
        agentId: agent.id,
        mode: "REVIEW",
        tools: ["filesystem", "git"],
        accessLevel: "READ_ONLY",
        scopePath: "/work",
        reason: "Need file:line review findings.",
      },
    });
    const accepted = await caller.accept({ id });
    expect(accepted.dispatched).toBe(true);

    const run = await prisma.agentRun.findFirstOrThrow({
      where: { issueId: issue.id, agentId: agent.id },
      orderBy: { startedAt: "desc" },
    });
    expect(run.engagementMode).toBe(EngagementMode.REVIEW);
    expect(run.runtimePolicy).toMatchObject({
      engagementMode: "REVIEW",
      adapterKey: "codex-app-server",
      allowedHostTools: ["filesystem", "git"],
      toolGrant: {
        accessLevel: "READ_ONLY",
        scopePath: "/work",
        actionRequestId: id,
      },
      layers: [
        { kind: "forge-mcp", enforced: true },
        { kind: "codex-sandbox", enforced: true },
      ],
    });
  });
});

describe("actionRequestRouter — decline never dispatches", () => {
  it("declining a TRANSITION leaves statusId untouched", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const before = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    const { id } = await caller.create({
      title: "Mark Done",
      kind: ActionRequestKind.TRANSITION,
      payload: { statusId: done.id },
      issueId: issue.id,
    });
    await caller.decline({ id, reason: "not yet" });
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.statusId).toBe(before.statusId);
    const row = await prisma.actionRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(ActionRequestStatus.REJECTED);
    expect(row.resolution).toMatch(/not yet/);
  });
});

describe("actionRequestRouter — payload workspace scope", () => {
  it("rejects TRANSITION to a status from another workspace", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    // Build a foreign workspace status.
    const other = await createWorkspaceFixture({ keyPrefix: "OTH" });
    fixtures.push(other);
    const foreignStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: other.workspace.id, category: "DONE" },
    });
    await expect(
      caller.create({
        title: "Bad transition",
        kind: ActionRequestKind.TRANSITION,
        payload: { statusId: foreignStatus.id },
        issueId: issue.id,
      }),
    ).rejects.toThrow(/workspace/i);
  });

  it("rejects payload-bearing kinds without an issueId", async () => {
    const { caller } = await setup();
    await expect(
      caller.create({
        title: "No issue",
        kind: ActionRequestKind.ARCHIVE,
      }),
    ).rejects.toThrow(/requires issueId/i);
  });
});
