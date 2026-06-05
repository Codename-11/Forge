import { describe, it, expect, afterAll, afterEach } from "vitest";
import {
  AgentProvider,
  EngagementMode,
  EventKind,
  RuntimeKind,
  RunEngine,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import { ingestRunsDispatch } from "@/server/services/dispatch/run-dispatcher";
import {
  createWorkspaceFixture,
  createIssue,
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

describe("runs dispatcher", () => {
  it("starts the provider run when the durable inbox already precreated AgentRun", async () => {
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RDS" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "runner",
          profileKey: "runner",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "dispatch me" });
      await prisma.issue.update({
        where: { id: issue.id },
        data: { assignedAgentId: agent.id },
      });

      await prisma.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: fixture.workspace.id,
          actorId: fixture.user.id,
          entity: "Issue",
          entityId: issue.id,
          action: "assign-agent",
          eventKind: EventKind.AGENT_ASSIGNED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            agentId: agent.id,
            previousAgentId: null,
            engagementMode: EngagementMode.REVIEW,
          },
        });
      });

      const precreated = await prisma.agentRun.findFirstOrThrow({
        where: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
        },
      });
      expect(precreated.externalRunId).toBeNull();
      expect(precreated.engagementMode).toBe(EngagementMode.REVIEW);

      const tick = await ingestRunsDispatch();
      expect(tick.started).toBeGreaterThanOrEqual(1);

      const after = await prisma.agentRun.findUniqueOrThrow({
        where: { id: precreated.id },
        include: { events: { orderBy: { createdAt: "asc" } } },
      });
      expect(after.externalRunId).toMatch(/^mock-/);
      expect(after.engagementMode).toBe(EngagementMode.REVIEW);
      expect(after.events.some((e) => e.kind === "DISPATCH_STARTED")).toBe(true);
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });
});
