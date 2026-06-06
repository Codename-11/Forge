import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentRunStatus, EngagementMode, PluginScope } from "@prisma/client";
import { executeChatTool } from "@/server/services/chat-tool-exec";
import { executeMcpTool } from "@/server/services/mcp-exec";
import type { McpContext } from "@/server/services/mcp";
import type { ApiKeyContext } from "@/server/services/api-key-auth";
import {
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

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

function buildMcpCtx(
  fixture: TestFixture,
  overrides: Partial<ApiKeyContext> = {},
): { ctx: McpContext; apiKey: ApiKeyContext } {
  const apiKey: ApiKeyContext = {
    keyId: "test-key",
    workspaceId: fixture.workspace.id,
    userId: fixture.user.id,
    pluginId: null,
    scopes: [
      PluginScope.READ_ISSUES,
      PluginScope.WRITE_ISSUES,
      PluginScope.READ_PROJECTS,
      PluginScope.WRITE_PROJECTS,
      PluginScope.READ_COMMENTS,
      PluginScope.WRITE_COMMENTS,
      PluginScope.READ_USERS,
      PluginScope.READ_ANALYTICS,
      PluginScope.SUBSCRIBE_EVENTS,
      PluginScope.INVOKE_SKILLS,
      PluginScope.ADMIN,
    ],
    projectIds: [],
    labelIds: [],
    initiativeIds: [],
    linkedAgentId: null,
    ...overrides,
  };
  return {
    ctx: {
      workspaceId: apiKey.workspaceId,
      userId: apiKey.userId,
      pluginId: apiKey.pluginId,
      apiKey,
    },
    apiKey,
  };
}

describe("mcp execution wrapper", () => {
  it("returns transport-neutral lookup, scope, and validation errors", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MEX" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);

    const unknown = await executeMcpTool({
      name: "issues.nope",
      input: {},
      ctx,
      source: "test",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("UNKNOWN_TOOL");

    const scoped = await executeMcpTool({
      name: "issues.list",
      input: {},
      ctx: buildMcpCtx(fixture, { scopes: [PluginScope.READ_PROJECTS] }).ctx,
      source: "test",
    });
    expect(scoped.ok).toBe(false);
    if (!scoped.ok) {
      expect(scoped.error.code).toBe("FORBIDDEN");
      expect(scoped.error.message).toMatch(/READ_ISSUES/);
    }

    const invalid = await executeMcpTool({
      name: "issues.get",
      input: {},
      ctx,
      source: "test",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("INVALID_INPUT");
      expect(invalid.error.data).toBeTruthy();
    }
  });

  it("executes registered tools after shared parse and scope checks", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MEX" });
    fixtures.push(fixture);
    await createIssue(fixture, { title: "Executor visible issue" });
    const { ctx } = buildMcpCtx(fixture);

    const exec = await executeMcpTool({
      name: "issues.list",
      input: { query: "Executor visible", limit: 5 },
      ctx,
      source: "test",
    });

    expect(exec.ok).toBe(true);
    if (exec.ok) {
      const result = exec.result as { data: Array<{ title: string }> };
      expect(result.data.some((issue) => issue.title === "Executor visible issue")).toBe(true);
    }
  });

  it("classifies explicit mode-policy denials before the raw tool run", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MEX" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `mcp-exec-${Date.now()}`,
        name: "MCP Exec Researcher",
      },
    });
    const issue = await createIssue(fixture, { title: "Original title" });
    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        engagementMode: EngagementMode.RESEARCH,
      },
    });

    const exec = await executeMcpTool({
      name: "issues.update",
      input: { id: issue.id, title: "Mutated title" },
      ctx: {
        ...ctx,
        apiKey: { ...ctx.apiKey!, linkedAgentId: agent.id },
      },
      source: "test",
    });

    expect(exec.ok).toBe(false);
    if (!exec.ok) {
      expect(exec.error.code).toBe("POLICY_DENIED");
      expect(exec.error.message).toMatch(/RESEARCH.*does not allow issues\.update/);
    }
    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { title: true },
    });
    expect(row.title).toBe("Original title");
  });

  it("lets confirmed chat tools use the executor with session auth", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MEX" });
    fixtures.push(fixture);

    const result = await executeChatTool({
      workspaceId: fixture.workspace.id,
      userId: fixture.user.id,
      name: "workspace.get",
      args: {},
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/workspace\.get/);
  });
});
