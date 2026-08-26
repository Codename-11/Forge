import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AgentProvider,
  AgentRunStatus,
  EngagementMode,
  EventKind,
  RuntimeKind,
  RunEngine,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import type { ApiKeyContext } from "@/server/services/api-key-auth";
import { ingestRunsDispatch } from "@/server/services/dispatch/run-dispatcher";
import { sharedMockRunsConnectorForTests } from "@/server/services/dispatch/mock-runs";
import { mcpTools, type McpContext } from "@/server/services/mcp";
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

async function call(name: keyof typeof mcpTools, input: unknown, ctx: McpContext) {
  const definition = mcpTools[name];
  return definition.run(definition.input.parse(input) as never, ctx);
}

function agentContext(fixture: TestFixture, agentId: string): McpContext {
  const apiKey: ApiKeyContext = {
    keyId: "managed-runtime-acceptance-key",
    workspaceId: fixture.workspace.id,
    userId: fixture.user.id,
    pluginId: null,
    scopes: ["READ_ISSUES", "WRITE_ISSUES", "READ_COMMENTS", "WRITE_COMMENTS"],
    projectIds: [],
    labelIds: [],
    initiativeIds: [],
    linkedAgentId: agentId,
  };
  return {
    workspaceId: fixture.workspace.id,
    userId: fixture.user.id,
    pluginId: null,
    apiKey,
  };
}

describe("managed runtime lifecycle acceptance", () => {
  it("assignment -> external run -> ack -> output -> BODY final -> complete", async () => {
    const priorE2e = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";
    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "MRA" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      await prisma.workspace.update({
        where: { id: fixture.workspace.id },
        data: { assignmentEngagementMode: EngagementMode.DISCUSS },
      });
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "Managed acceptance runtime",
          kind: RuntimeKind.REMOTE_HTTP,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Managed acceptance agent",
          profileKey: `managed-acceptance-${Date.now()}`,
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
      });
      const issue = await createIssue(fixture, {
        title: "Approve managed runtime acceptance",
      });
      await prisma.issue.update({
        where: { id: issue.id },
        data: { assignedAgentId: agent.id },
      });
      await recordChange(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issue.id,
        action: "assign",
        eventKind: EventKind.AGENT_ASSIGNED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { agentId: agent.id, agentProfileKey: agent.profileKey },
      });

      const beforeDispatch = await prisma.agentRun.findFirstOrThrow({
        where: { issueId: issue.id, agentId: agent.id, status: AgentRunStatus.ACTIVE },
      });
      expect(beforeDispatch.externalRunId).toBeNull();

      const dispatch = await ingestRunsDispatch();
      expect(dispatch.started).toBeGreaterThanOrEqual(1);
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: beforeDispatch.id } });
      expect(run.externalRunId).toMatch(/^mock-/);

      const ctx = agentContext(fixture, agent.id);
      await call("agent.inbox.ack", { runId: run.id }, ctx);
      await call("agent.inbox.outputStarted", { runId: run.id }, ctx);
      const finalComment = (await call(
        "comments.create",
        { issueId: issue.id, body: "Managed runtime completed the requested verification." },
        ctx,
      )) as { id: string };
      await call(
        "runs.complete",
        {
          runId: run.id,
          summary: "Managed runtime completed the requested verification.",
          completionCommentId: finalComment.id,
        },
        ctx,
      );
      await sharedMockRunsConnectorForTests().approve?.(run.externalRunId!, "once");
      await new Promise((resolve) => setTimeout(resolve, 150));

      const completed = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(completed.status).toBe(AgentRunStatus.COMPLETED);
      expect(completed.acknowledgedAt).not.toBeNull();
      expect(completed.outputStartedAt).not.toBeNull();
      expect(completed.externalRunId).toMatch(/^mock-/);
      expect(completed.completionMeta).toMatchObject({
        completionCommentId: finalComment.id,
      });
      await expect(
        prisma.comment.findUniqueOrThrow({ where: { id: finalComment.id } }),
      ).resolves.toMatchObject({
        issueId: issue.id,
        authoringAgentId: agent.id,
        kind: "BODY",
        deletedAt: null,
      });
      expect(
        await prisma.activityEvent.count({
          where: {
            workspaceId: fixture.workspace.id,
            subjectId: run.id,
            kind: EventKind.AGENT_RUN_COMPLETED,
          },
        }),
      ).toBe(1);
    } finally {
      if (priorE2e === undefined) delete process.env.FORGE_E2E;
      else process.env.FORGE_E2E = priorE2e;
    }
  });
});
