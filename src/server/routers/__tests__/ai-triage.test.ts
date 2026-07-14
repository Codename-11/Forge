import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AiTriageStatus, Priority } from "@prisma/client";
import { aiRouter } from "@/server/routers/ai";
import { encryptSecret } from "@/server/crypto";
import { resolveWorkspaceProviderClient } from "@/server/services/ai-providers";
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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "AIT" });
  fixtures.push(fixture);
  const caller = aiRouter.createCaller(await buildContext(fixture));
  return { fixture, caller, prisma: getPrisma() };
}

describe("aiRouter triage lifecycle", () => {
  it("applies suggestions with full label audit and assignment lifecycle side effects", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture, { title: "Repair Hermes triage" });
    const [oldAgent, newAgent, label] = await Promise.all([
      prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Old owner",
          profileKey: "old-owner",
        },
      }),
      prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Victor",
          profileKey: "victor",
          templateMarkdown: "## Investigation\n\nDocument the root cause.",
        },
      }),
      prisma.label.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Bug",
          color: "#a16207",
        },
      }),
    ]);
    await prisma.issue.update({
      where: { id: issue.id },
      data: {
        assignedAgentId: oldAgent.id,
        aiTriageStatus: AiTriageStatus.READY,
        aiSuggestedPriority: Priority.LOW,
        aiSuggestedLabelIds: [label.id],
        aiSuggestedAgentId: newAgent.id,
        aiTriageReasoning: "Scoped configuration bug.",
      },
    });
    const previousRun = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: oldAgent.id,
      },
    });
    await prisma.issueWatcher.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: oldAgent.id,
        wakeOnActivity: true,
      },
    });

    await caller.triageApply({ issueId: issue.id });

    const applied = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      include: { labels: true },
    });
    expect(applied).toMatchObject({
      priority: Priority.LOW,
      assignedAgentId: newAgent.id,
      aiTriageStatus: AiTriageStatus.APPLIED,
      description: "## Investigation\n\nDocument the root cause.",
    });
    expect(applied.labels.map((row) => row.labelId)).toEqual([label.id]);
    expect(applied.dispatchReason).toMatchObject({
      mode: "MANUAL",
      picked: "victor",
    });
    expect(
      (await prisma.agentRun.findUniqueOrThrow({ where: { id: previousRun.id } })).status,
    ).toBe("ABANDONED");

    const watchers = await prisma.issueWatcher.findMany({
      where: { issueId: issue.id, agentId: { not: null } },
      select: { agentId: true, wakeOnActivity: true },
    });
    expect(watchers).toEqual(
      expect.arrayContaining([
        { agentId: oldAgent.id, wakeOnActivity: false },
        { agentId: newAgent.id, wakeOnActivity: true },
      ]),
    );

    const audits = await prisma.auditLog.findMany({
      where: { entityId: issue.id },
      select: { action: true },
    });
    expect(audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        "ai-triage-apply-priority",
        "ai-triage-apply-labels",
        "ai-triage-apply-agent",
        "apply-agent-template",
      ]),
    );
    const assignmentEvent = await prisma.activityEvent.findFirstOrThrow({
      where: {
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(assignmentEvent.payload).toMatchObject({
      agentId: newAgent.id,
      previousAgentId: oldAgent.id,
      engagementMode: "EXECUTE",
      source: "ai-triage",
    });
  });

  it("rejects duplicate reruns while triage is pending", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { aiTriageStatus: AiTriageStatus.PENDING, aiTriagedAt: new Date() },
    });

    await expect(caller.triageRerun({ issueId: issue.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).aiTriageStatus).toBe(
      AiTriageStatus.PENDING,
    );
  });

  it("does not decide a suggestion when no fields are selected", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { aiTriageStatus: AiTriageStatus.READY },
    });

    await expect(
      caller.triageApply({
        issueId: issue.id,
        applyPriority: false,
        applyLabels: false,
        applyAgent: false,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).aiTriageStatus).toBe(
      AiTriageStatus.READY,
    );
  });

  it("reports and resolves an enabled workspace credential without an env key", async () => {
    const { fixture, caller, prisma } = await setup();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { aiProvider: "openai", aiModel: null },
    });
    await prisma.providerCredential.create({
      data: {
        workspaceId: fixture.workspace.id,
        providerId: "openai",
        apiKeyEnc: encryptSecret("test-workspace-key"),
        defaultModel: "workspace-test-model",
        enabled: true,
      },
    });

    const status = await caller.status();
    expect(status).toMatchObject({
      activeProvider: "openai",
      activeProviderAvailable: true,
      apiKeyConfigured: true,
    });
    const resolved = await resolveWorkspaceProviderClient(prisma, fixture.workspace.id, "openai");
    expect(resolved).toMatchObject({
      providerId: "openai",
      defaultModel: "workspace-test-model",
    });
  });
});
