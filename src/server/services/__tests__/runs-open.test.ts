import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mcpTools, type McpContext } from "@/server/services/mcp";
import {
  createWorkspaceFixture,
  createIssue,
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

function ctxFor(fixture: TestFixture, linkedAgentId: string | null): McpContext {
  return {
    workspaceId: fixture.workspace.id,
    userId: fixture.user.id,
    pluginId: null,
    apiKey: {
      keyId: "test-key",
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      pluginId: null,
      scopes: ["WRITE_ISSUES"],
      projectIds: [],
      labelIds: [],
      initiativeIds: [],
      linkedAgentId,
    },
  } as unknown as McpContext;
}

async function makeAgent(fixture: TestFixture) {
  return getPrisma().agent.create({
    data: { workspaceId: fixture.workspace.id, name: "opener", profileKey: "opener" },
    select: { id: true },
  });
}

describe("runs.open MCP tool", () => {
  it("opens a run for the calling agent and resumes rather than duplicating", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "RO" });
    fixtures.push(f);
    const agent = await makeAgent(f);
    const issue = await createIssue(f, { title: "self-run target" });
    const ctx = ctxFor(f, agent.id);

    const res = (await mcpTools["runs.open"].run(
      { issueId: issue.id, summary: "doing X" } as never,
      ctx,
    )) as { runId: string; isNew: boolean; status: string };
    expect(res.isNew).toBe(true);
    expect(res.status).toBe("ACTIVE");

    const run = await getPrisma().agentRun.findUnique({
      where: { id: res.runId },
      select: { agentId: true, issueId: true, currentStep: true },
    });
    expect(run?.agentId).toBe(agent.id);
    expect(run?.issueId).toBe(issue.id);
    expect(run?.currentStep).toBe("doing X");

    // Re-opening for the same (issue, agent) resumes the same run — no duplicate.
    const res2 = (await mcpTools["runs.open"].run({ issueId: issue.id } as never, ctx)) as {
      runId: string;
      isNew: boolean;
    };
    expect(res2.runId).toBe(res.runId);
    expect(res2.isNew).toBe(false);
  });

  it("rejects a key with no linkedAgentId", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "RO2" });
    fixtures.push(f);
    const issue = await createIssue(f, { title: "x" });
    await expect(
      mcpTools["runs.open"].run({ issueId: issue.id } as never, ctxFor(f, null)),
    ).rejects.toThrow(/linkedAgentId/);
  });

  it("rejects an issue from another workspace", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "RO3" });
    const other = await createWorkspaceFixture({ keyPrefix: "RO4" });
    fixtures.push(f, other);
    const agent = await makeAgent(f);
    const foreignIssue = await createIssue(other, { title: "not yours" });
    await expect(
      mcpTools["runs.open"].run({ issueId: foreignIssue.id } as never, ctxFor(f, agent.id)),
    ).rejects.toThrow(/not found/i);
  });
});
