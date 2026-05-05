import { describe, it, expect, afterAll, afterEach } from "vitest";
import { inboxRouter } from "@/server/routers/inbox";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration coverage for `inbox.waitingOnMe`. The proc is conservative
 * by design — it only surfaces issues whose latest comment is from an
 * agent and @-mentions the caller, AND has no later reply from the
 * caller. Three scenarios:
 *
 *   1. Agent @-mentions the caller, no reply → row appears.
 *   2. Caller has replied since the agent comment → row hidden.
 *   3. Mention to a different user → row hidden (no false-positive).
 *
 * Heuristic basis: caller's email-prefix and first-name. The proc
 * builds tokens from `User.handle | name | email`; the helper user
 * here has email `test-…@example.com` so `@test-…` matches via the
 * email-local prefix and `@testuser` matches via the name token.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "WMI" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const prisma = getPrisma();
  // Stamp a stable handle on the caller so the mention heuristic
  // matches reliably regardless of the random email suffix.
  await prisma.user.update({
    where: { id: fixture.user.id },
    data: { handle: "operator" },
  });
  return { fixture, ctx, prisma };
}

describe("inboxRouter.waitingOnMe", () => {
  it("surfaces an agent comment that @-mentions the caller with no reply", async () => {
    const { fixture, ctx, prisma } = await setup();
    const issue = await createIssue(fixture);

    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
        capabilities: [],
      },
    });

    await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        body: "@operator could you confirm the staging URL?",
        kind: "BODY",
        authorId: fixture.user.id, // schema requires an author; the agent
                                   // join is via authoringAgentId.
        authoringAgentId: agent.id,
      },
    });

    const caller = inboxRouter.createCaller(ctx);
    const result = await caller.waitingOnMe({ limit: 25 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].issue.id).toBe(issue.id);
    expect(result.items[0].lastComment.author.profileKey).toBe("victor");
  });

  it("hides the row once the caller replies after the mention", async () => {
    const { fixture, ctx, prisma } = await setup();
    const issue = await createIssue(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
        capabilities: [],
      },
    });

    const agentComment = await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        body: "@operator status?",
        kind: "BODY",
        authorId: fixture.user.id,
        authoringAgentId: agent.id,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    expect(agentComment.id).toBeTruthy();

    // Caller replies after the mention.
    await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        body: "On it.",
        kind: "BODY",
        authorId: fixture.user.id,
        // No authoringAgentId — this is a human reply.
      },
    });

    const caller = inboxRouter.createCaller(ctx);
    const result = await caller.waitingOnMe({ limit: 25 });
    expect(result.items).toHaveLength(0);
  });

  it("ignores mentions of a different user (no false-positive)", async () => {
    const { fixture, ctx, prisma } = await setup();
    const issue = await createIssue(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
        capabilities: [],
      },
    });
    await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        body: "@someone-else can you look at this?",
        kind: "BODY",
        authorId: fixture.user.id,
        authoringAgentId: agent.id,
      },
    });

    const caller = inboxRouter.createCaller(ctx);
    const result = await caller.waitingOnMe({ limit: 25 });
    expect(result.items).toHaveLength(0);
  });
});
