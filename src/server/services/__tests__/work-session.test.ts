import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DeliveryTimelinePolicy, WorkSessionSource } from "@prisma/client";
import { FORGE_MCP_INSTRUCTIONS } from "@/server/services/mcp-instructions";
import { mcpTools, type McpContext } from "@/server/services/mcp";
import {
  advanceWorkSession,
  attachPullRequest,
  claimWorkSession,
  sweepStaleWorkSessions,
} from "@/server/services/work-session";
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

afterAll(async () => disconnectPrisma());

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "WS" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
  return { fixture, prisma, issue };
}

describe("work session coordination", () => {
  it("returns the owned lease idempotently and rejects competing work", async () => {
    const { fixture, prisma, issue } = await setup();
    const first = await claimWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      repoFullName: "acme/forge",
      branch: "codex/ws-1-feature",
      source: WorkSessionSource.CODEX_DESKTOP,
      actor: { userId: fixture.user.id },
    });
    const same = await claimWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      repoFullName: "acme/forge",
      branch: "codex/ws-1-feature",
      source: WorkSessionSource.CODEX_DESKTOP,
      actor: { userId: fixture.user.id },
    });
    expect(same.id).toBe(first.id);

    await expect(
      claimWorkSession(prisma, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        repoFullName: "acme/forge",
        branch: "contributor/competing",
        source: WorkSessionSource.CONTRIBUTOR,
        actor: { userId: fixture.secondUser.id },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("derives merge state from a native implementation PR and gates delivery milestones", async () => {
    const { fixture, prisma, issue } = await setup();
    const session = await claimWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      repoFullName: "acme/forge",
      branch: "codex/ws-2-feature",
      source: WorkSessionSource.CODEX_DESKTOP,
      actor: { userId: fixture.user.id },
    });
    const pr = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 72,
        url: "https://github.com/acme/forge/pull/72",
        title: "Ship coordinated work",
        state: "merged",
        metadata: {
          mergedAt: new Date().toISOString(),
          head: { ref: "codex/ws-2-feature", sha: "abcdef1234567" },
          checks: { source: "api-aggregate", status: "completed", conclusion: "success" },
        },
      },
    });
    const merged = await attachPullRequest(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      externalResourceId: pr.id,
      actor: { userId: fixture.user.id },
    });
    expect(merged.status).toBe("MERGED");
    expect(merged.timeline).toMatchObject({
      policy: DeliveryTimelinePolicy.RECOMMEND,
      recommended: true,
      nextAction: "comments.create",
      commentId: null,
    });
    await expect(
      advanceWorkSession(prisma, {
        workspaceId: fixture.workspace.id,
        sessionId: session.id,
        actor: { userId: fixture.user.id },
        status: "DEPLOYED",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      advanceWorkSession(prisma, {
        workspaceId: fixture.workspace.id,
        sessionId: session.id,
        actor: { userId: fixture.user.id },
        status: "RELEASED",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const released = await advanceWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      actor: { userId: fixture.user.id },
      status: "RELEASED",
      releasedVersion: "v0.20.0",
    });
    expect(released.releasedVersion).toBe("v0.20.0");
    await expect(
      advanceWorkSession(prisma, {
        workspaceId: fixture.workspace.id,
        sessionId: session.id,
        actor: { userId: fixture.user.id },
        status: "DEPLOYED",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const deployed = await advanceWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      actor: { userId: fixture.user.id },
      status: "DEPLOYED",
      deployedSha: "1234567abcdef",
    });
    expect(deployed.deployedSha).toBe("1234567abcdef");
    const verified = await advanceWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      actor: { userId: fixture.user.id },
      status: "VERIFIED",
    });
    expect(verified.endedAt).not.toBeNull();
  });

  it("automatically posts one human-readable PR handoff when configured", async () => {
    const { fixture, prisma, issue } = await setup();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { deliveryTimelinePolicy: DeliveryTimelinePolicy.AUTO_ON_PR },
    });
    const session = await claimWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      repoFullName: "acme/forge",
      branch: "codex/ws-auto-comment",
      source: WorkSessionSource.CODEX_DESKTOP,
      actor: { userId: fixture.user.id },
    });
    const pr = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 73,
        url: "https://github.com/acme/forge/pull/73",
        title: "Keep delivery visible",
        state: "draft",
        metadata: { draft: true, base: { ref: "main" }, head: { ref: session.branch } },
      },
    });

    const attached = await attachPullRequest(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      externalResourceId: pr.id,
      actor: { userId: fixture.user.id },
    });
    expect(attached.timeline).toMatchObject({
      policy: DeliveryTimelinePolicy.AUTO_ON_PR,
      recommended: false,
      nextAction: null,
    });
    expect(attached.timeline.commentId).toBeTruthy();
    expect(
      await prisma.comment.findUniqueOrThrow({ where: { id: attached.timeline.commentId! } }),
    ).toMatchObject({
      issueId: issue.id,
      authorId: fixture.user.id,
      body: expect.stringContaining("https://github.com/acme/forge/pull/73"),
    });

    await attachPullRequest(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      externalResourceId: pr.id,
      actor: { userId: fixture.user.id },
    });
    expect(await prisma.comment.count({ where: { issueId: issue.id } })).toBe(1);
  });

  it("requires an atomic timeline update under the strict PR policy", async () => {
    const { fixture, prisma, issue } = await setup();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { deliveryTimelinePolicy: DeliveryTimelinePolicy.REQUIRE_ON_PR },
    });
    const session = await claimWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      repoFullName: "acme/forge",
      branch: "codex/ws-required-comment",
      source: WorkSessionSource.CODEX_DESKTOP,
      actor: { userId: fixture.user.id },
    });
    const pr = await prisma.externalResource.create({
      data: {
        workspaceId: fixture.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/forge",
        number: 74,
        url: "https://github.com/acme/forge/pull/74",
        title: "Require the handoff",
        state: "open",
        metadata: { head: { ref: session.branch } },
      },
    });

    await expect(
      attachPullRequest(prisma, {
        workspaceId: fixture.workspace.id,
        sessionId: session.id,
        externalResourceId: pr.id,
        actor: { userId: fixture.user.id },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const attached = await attachPullRequest(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      externalResourceId: pr.id,
      actor: { userId: fixture.user.id },
      timelineUpdate: { body: "Implemented the delivery contract. Validation: focused tests." },
    });
    expect(attached.timeline.commentId).toBeTruthy();
    expect(
      await prisma.comment.findUniqueOrThrow({ where: { id: attached.timeline.commentId! } }),
    ).toMatchObject({ body: "Implemented the delivery contract. Validation: focused tests." });
  });

  it("advertises the human-readable delivery contract in MCP instructions", () => {
    expect(FORGE_MCP_INSTRUCTIONS).toContain("comments.upsertStatus");
    expect(FORGE_MCP_INSTRUCTIONS).toContain("comments.create");
    expect(FORGE_MCP_INSTRUCTIONS).toContain("workSessions.attachPullRequest");
    const attachTool = mcpTools["workSessions.attachPullRequest"];
    expect(attachTool.description).toContain("human-readable issue handoff");
    expect(
      attachTool.input.safeParse({
        sessionId: "cmrmh4rzz030cmm07rjd2nxe6",
        externalResourceId: "cmrmg1qee01lzmm07dyzrutbq",
        timelineUpdate: { body: "Implemented and verified the change." },
      }).success,
    ).toBe(true);
  });

  it("marks quiet leases stale and creates one shared action request", async () => {
    const { fixture, prisma, issue } = await setup();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { workSessionStaleMinutes: 1 },
    });
    const session = await claimWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      repoFullName: "acme/forge",
      branch: "codex/ws-3-feature",
      source: WorkSessionSource.CODEX_DESKTOP,
      actor: { userId: fixture.user.id },
    });
    await prisma.workSession.update({
      where: { id: session.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 5 * 60_000) },
    });
    expect(await sweepStaleWorkSessions(prisma)).toBe(1);
    expect((await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe(
      "STALE",
    );
    expect(
      await prisma.actionRequest.count({
        where: { workspaceId: fixture.workspace.id, dedupeKey: `work-session-stale:${session.id}` },
      }),
    ).toBe(1);
    expect(await sweepStaleWorkSessions(prisma)).toBe(0);
  });

  it("enforces narrowed API-key scope for listing and claiming sessions", async () => {
    const { fixture, prisma, issue } = await setup();
    const allowedProject = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: `AL${Date.now().toString().slice(-6)}`,
        name: "Allowed lane",
        createdById: fixture.user.id,
      },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `scoped-${Date.now()}`,
        name: "Scoped agent",
      },
    });
    const ctx = {
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      pluginId: null,
      apiKey: {
        keyId: "scoped-key",
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        pluginId: null,
        scopes: ["READ_ISSUES", "WRITE_ISSUES"],
        projectIds: [allowedProject.id],
        labelIds: [],
        initiativeIds: [],
        linkedAgentId: agent.id,
      },
    } as unknown as McpContext;

    await expect(
      mcpTools["workSessions.list"].run({ issueId: issue.id } as never, ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      mcpTools["workSessions.claim"].run(
        {
          issueId: issue.id,
          repoFullName: "acme/forge",
          branch: "agent/out-of-scope",
          baseBranch: "main",
        } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.workSession.count({ where: { issueId: issue.id } })).toBe(0);
  });

  it("leaves recently refreshed work active during the stale sweep", async () => {
    const { fixture, prisma, issue } = await setup();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { workSessionStaleMinutes: 1 },
    });
    const session = await claimWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      repoFullName: "acme/forge",
      branch: "codex/refreshed-before-sweep",
      source: WorkSessionSource.CODEX_DESKTOP,
      actor: { userId: fixture.user.id },
    });
    await prisma.workSession.update({
      where: { id: session.id },
      data: { lastHeartbeatAt: new Date() },
    });

    expect(await sweepStaleWorkSessions(prisma)).toBe(0);
    expect((await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe(
      "CLAIMED",
    );
  });
});
