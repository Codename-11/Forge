import { describe, it, expect, afterAll, afterEach } from "vitest";
import { commentRouter } from "@/server/routers/comment";
import type { ApiKeyContext } from "@/server/services/api-key-auth";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration coverage for `comment.create` honoring
 * `ApiKeyContext.linkedAgentId`:
 *   - Human session (no apiKey on ctx) → `authoringAgentId` stays null.
 *   - API key with `linkedAgentId` set → the new Comment row is stamped
 *     with that agent id and the returned shape includes the joined agent.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "CMT" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  return { fixture, ctx };
}

describe("commentRouter.create — agent authorship", () => {
  it("human session leaves authoringAgentId null", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);

    const caller = commentRouter.createCaller(ctx);
    const created = await caller.create({
      issueId: issue.id,
      body: "Hello from a human.",
    });

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.authoringAgentId).toBeNull();
  });

  it("API key with linkedAgentId stamps authoringAgentId and joins the agent", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);

    // Register an Agent in this workspace + a linked ctx.apiKey pointing at it.
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
        capabilities: ["ops"],
      },
    });

    const apiKey: ApiKeyContext = {
      keyId: "k",
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      pluginId: null,
      scopes: ["WRITE_COMMENTS"],
      projectIds: [],
      labelIds: [],
      initiativeIds: [],
      linkedAgentId: agent.id,
    };
    const caller = commentRouter.createCaller({ ...ctx, apiKey });
    const created = await caller.create({
      issueId: issue.id,
      body: "Hello from Victor.",
    });

    // The returned comment includes the joined agent relation so the UI can
    // render the byline without a second roundtrip.
    expect(
      (created as unknown as { authoringAgent: { id: string } | null }).authoringAgent?.id,
    ).toBe(agent.id);

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.authoringAgentId).toBe(agent.id);

    // Attribution: the audit + activity rows record the AGENT as the actor
    // (`actorAgentId`) while keeping the human key-owner as secondary
    // metadata (`actorId`). This is the agent-is-actor display model.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Comment",
        entityId: created.id,
        action: "create",
      },
    });
    expect(audit.actorAgentId).toBe(agent.id);
    expect(audit.actorId).toBe(fixture.user.id);

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: "COMMENT_CREATED",
        subjectType: "issue",
        subjectId: issue.id,
      },
    });
    expect(event.actorAgentId).toBe(agent.id);
    expect(event.actorId).toBe(fixture.user.id);
  });

  it("human session leaves actorAgentId null on audit + activity rows", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);

    const caller = commentRouter.createCaller(ctx);
    const created = await caller.create({
      issueId: issue.id,
      body: "Human comment.",
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Comment",
        entityId: created.id,
        action: "create",
      },
    });
    expect(audit.actorAgentId).toBeNull();
    expect(audit.actorId).toBe(fixture.user.id);

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: "COMMENT_CREATED",
        subjectType: "issue",
        subjectId: issue.id,
      },
    });
    expect(event.actorAgentId).toBeNull();
  });
});

describe("commentRouter.create — auto-watch + mention resolution", () => {
  it("commenter (human) becomes a watcher", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);

    const caller = commentRouter.createCaller(ctx);
    await caller.create({ issueId: issue.id, body: "thinking out loud" });

    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: issue.id, userId: fixture.user.id },
    });
    expect(watcher).not.toBeNull();
  });

  it("commenter (agent via apiKey) becomes a watcher; human key owner does not", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor-w",
      },
    });
    const apiKey: ApiKeyContext = {
      keyId: "k",
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      pluginId: null,
      scopes: ["WRITE_COMMENTS"],
      projectIds: [],
      labelIds: [],
      initiativeIds: [],
      linkedAgentId: agent.id,
    };
    const caller = commentRouter.createCaller({ ...ctx, apiKey });
    await caller.create({ issueId: issue.id, body: "agent thinking" });

    const agentWatcher = await prisma.issueWatcher.findFirst({
      where: { issueId: issue.id, agentId: agent.id },
    });
    expect(agentWatcher).not.toBeNull();
    const userWatcher = await prisma.issueWatcher.findFirst({
      where: { issueId: issue.id, userId: fixture.user.id },
    });
    expect(userWatcher).toBeNull();
  });

  it("@profileKey resolves to a mentioned agent and upserts an agent watcher", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const target = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu-m",
      },
    });

    const caller = commentRouter.createCaller(ctx);
    const created = await caller.create({
      issueId: issue.id,
      body: "hey @mizu-m, take a look",
    });

    // Watcher row exists for the mentioned agent.
    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: issue.id, agentId: target.id },
    });
    expect(watcher).not.toBeNull();

    // Event payload carries agentIds[] under the new structured shape.
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { kind: "COMMENT_CREATED", subjectId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      mentions?: { agentIds?: string[]; userIds?: string[] };
    };
    expect(payload.mentions?.agentIds).toContain(target.id);
    // Suppress unused var warning.
    expect(created.id).toBeTruthy();
  });

  it("@handle resolves to a workspace member and upserts a user watcher", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    // Give secondUser a handle the comment can mention.
    await prisma.user.update({
      where: { id: fixture.secondUser.id },
      data: { handle: `u-${Date.now().toString(36)}` },
    });
    const updated = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.secondUser.id },
      select: { handle: true },
    });

    const caller = commentRouter.createCaller(ctx);
    await caller.create({
      issueId: issue.id,
      body: `hello @${updated.handle}`,
    });

    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: issue.id, userId: fixture.secondUser.id },
    });
    expect(watcher).not.toBeNull();

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { kind: "COMMENT_CREATED", subjectId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      mentions?: { agentIds?: string[]; userIds?: string[] };
    };
    expect(payload.mentions?.userIds).toContain(fixture.secondUser.id);
  });

  it("mix of @agent + @user mentions resolves both and watches both", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor-mix",
      },
    });
    const handle = `mix-${Date.now().toString(36)}`;
    await prisma.user.update({
      where: { id: fixture.secondUser.id },
      data: { handle },
    });

    const caller = commentRouter.createCaller(ctx);
    await caller.create({
      issueId: issue.id,
      body: `cc @victor-mix and @${handle} please`,
    });

    const watchers = await prisma.issueWatcher.findMany({
      where: { issueId: issue.id },
    });
    const agentIds = watchers.map((w) => w.agentId).filter(Boolean);
    const userIds = watchers.map((w) => w.userId).filter(Boolean);
    expect(agentIds).toContain(agent.id);
    expect(userIds).toContain(fixture.secondUser.id);

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { kind: "COMMENT_CREATED", subjectId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      mentions?: { agentIds?: string[]; userIds?: string[] };
    };
    expect(payload.mentions?.agentIds).toContain(agent.id);
    expect(payload.mentions?.userIds).toContain(fixture.secondUser.id);
  });

  it("unknown @handle (no matching User) does not upsert any watcher", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);

    const before = await prisma.issueWatcher.count({
      where: { issueId: issue.id },
    });

    const caller = commentRouter.createCaller(ctx);
    await caller.create({
      issueId: issue.id,
      body: "ping @nobody-here-at-all-zzz",
    });

    // Only the auto-watch for the commenter himself was added.
    const after = await prisma.issueWatcher.count({
      where: { issueId: issue.id },
    });
    expect(after - before).toBe(1);
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { kind: "COMMENT_CREATED", subjectId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      mentions?: { agentIds?: string[]; userIds?: string[] };
    };
    expect(payload.mentions?.userIds ?? []).toEqual([]);
    expect(payload.mentions?.agentIds ?? []).toEqual([]);
    // Suppress lint warning for unused fixture binding.
    expect(fixture.user.id).toBeTruthy();
  });
});

describe("commentRouter.create — structured agent requests", () => {
  it("persists composer chip mode metadata and opens a non-owning Review run", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor-request",
      },
    });

    const caller = commentRouter.createCaller(ctx);
    const created = await caller.create({
      issueId: issue.id,
      body: "@victor-request please check this implementation.",
      agentRequests: [{ profileKey: "victor-request", mode: "REVIEW" }],
    });

    const row = await prisma.comment.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.agentRequests).toEqual([
      {
        agentId: agent.id,
        profileKey: "victor-request",
        mode: "REVIEW",
        assignIssue: false,
      },
    ]);

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { kind: "COMMENT_CREATED", subjectId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      agentRequests?: Array<{ agentId: string; mode: string }>;
      issuePrefix?: string;
    };
    expect(payload.agentRequests?.[0]).toMatchObject({
      agentId: agent.id,
      mode: "REVIEW",
    });
    expect(payload.issuePrefix).toBe(`${fixture.workspace.key}-${issue.number}`);

    const run = await prisma.agentRun.findFirstOrThrow({
      where: { issueId: issue.id, agentId: agent.id },
    });
    expect(run.engagementMode).toBe("REVIEW");

    const freshIssue = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(freshIssue.assignedAgentId).toBeNull();
  });

  it("parses keyboard syntax when no structured chip payload is sent", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu-research",
      },
    });

    const caller = commentRouter.createCaller(ctx);
    await caller.create({
      issueId: issue.id,
      body: "@mizu-research /research what are our options?",
    });

    const row = await prisma.comment.findFirstOrThrow({
      where: { issueId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    expect(row.agentRequests).toEqual([
      {
        agentId: agent.id,
        profileKey: "mizu-research",
        mode: "RESEARCH",
        assignIssue: false,
      },
    ]);
    const run = await prisma.agentRun.findFirstOrThrow({
      where: { issueId: issue.id, agentId: agent.id },
    });
    expect(run.engagementMode).toBe("RESEARCH");
  });

  it("defaults a bare @agent request to Discuss and only assigns on explicit Execute+assign", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const discussAgent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Discuss Bot",
        profileKey: "discuss-bot",
      },
    });
    const executeAgent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Exec Bot",
        profileKey: "exec-bot",
      },
    });

    const caller = commentRouter.createCaller(ctx);
    await caller.create({ issueId: issue.id, body: "@discuss-bot thoughts?" });
    const discussRun = await prisma.agentRun.findFirstOrThrow({
      where: { issueId: issue.id, agentId: discussAgent.id },
    });
    expect(discussRun.engagementMode).toBe("DISCUSS");
    expect(
      (await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).assignedAgentId,
    ).toBeNull();

    await caller.create({
      issueId: issue.id,
      body: "@exec-bot please do it.",
      agentRequests: [{ profileKey: "exec-bot", mode: "EXECUTE", assignIssue: true }],
    });
    expect(
      (await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).assignedAgentId,
    ).toBe(executeAgent.id);
    const executeRun = await prisma.agentRun.findFirstOrThrow({
      where: { issueId: issue.id, agentId: executeAgent.id },
      orderBy: { startedAt: "desc" },
    });
    expect(executeRun.engagementMode).toBe("EXECUTE");
  });
});

describe("commentRouter.update — edit-time mention dispatch (diff)", () => {
  it("a NEWLY-added @agent on edit emits COMMENT_UPDATED with the agent in the diff and watches it", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const target = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor-edit",
      },
    });

    const caller = commentRouter.createCaller(ctx);
    // Create with NO mention of the target.
    const created = await caller.create({
      issueId: issue.id,
      body: "first pass, no mentions",
    });
    expect(
      await prisma.issueWatcher.findFirst({
        where: { issueId: issue.id, agentId: target.id },
      }),
    ).toBeNull();

    // Edit to ADD the mention.
    await caller.update({
      id: created.id,
      body: "first pass, cc @victor-edit",
    });

    // Watcher upserted for the newly-added agent.
    expect(
      await prisma.issueWatcher.findFirst({
        where: { issueId: issue.id, agentId: target.id },
      }),
    ).not.toBeNull();

    // COMMENT_UPDATED event carries the diff (the added agent) + edited flag.
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { kind: "COMMENT_UPDATED", subjectId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      edited?: boolean;
      mentions?: { agentIds?: string[] };
    };
    expect(payload.edited).toBe(true);
    expect(payload.mentions?.agentIds).toContain(target.id);
  });

  it("re-saving a body whose @mention was ALREADY present emits an empty diff (no re-trigger)", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu-edit",
      },
    });

    const caller = commentRouter.createCaller(ctx);
    const created = await caller.create({
      issueId: issue.id,
      body: "hey @mizu-edit take a look",
    });

    // Edit the prose but keep the SAME mention.
    await caller.update({
      id: created.id,
      body: "hey @mizu-edit take a careful look",
    });

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { kind: "COMMENT_UPDATED", subjectId: issue.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = event.payload as {
      edited?: boolean;
      mentions?: { agentIds?: string[] };
    };
    // The agent was already mentioned at create time, so the edit diff
    // is empty — no re-dispatch.
    expect(payload.mentions?.agentIds ?? []).toEqual([]);
  });
});
