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
      (created as unknown as { authoringAgent: { id: string } | null })
        .authoringAgent?.id,
    ).toBe(agent.id);

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.authoringAgentId).toBe(agent.id);
  });
});
