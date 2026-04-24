import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentStatus } from "@prisma/client";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for per-agent issue templates. Real Postgres via
 * the shared fixture helpers — no mocks. Each test builds its own
 * workspace so suites can run in parallel without cross-talk.
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

/** Thin wrapper so tests read as one-liners. */
async function createAgent(
  workspaceId: string,
  opts: { profileKey: string; templateMarkdown?: string | null },
): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: opts.profileKey,
      profileKey: opts.profileKey,
      status: AgentStatus.ONLINE,
      templateMarkdown: opts.templateMarkdown ?? null,
    },
    select: { id: true },
  });
}

describe("agent-template — maybeApplyAgentTemplate", () => {
  it("applies the template when description is empty and agent has one", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ATA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const template = "### Context\n\n### Acceptance criteria\n\n### Constraints";
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "ata-victor",
      templateMarkdown: template,
    });
    // createIssue uses an empty description by default.
    const issue = await createIssue(fixture, { title: "empty-desc" });

    const res = await maybeApplyAgentTemplate(prisma, issue.id, agent.id);
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("applied");

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.description).toBe(template);

    // Audit + activity marker written in the same tx.
    const audit = await prisma.auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Issue",
        entityId: issue.id,
        action: "apply-agent-template",
      },
    });
    expect(audit).not.toBeNull();

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "ISSUE_UPDATED",
      },
    });
    const payload = event.payload as {
      fromAgentTemplate?: boolean;
      agentId?: string;
      profileKey?: string;
    };
    expect(payload.fromAgentTemplate).toBe(true);
    expect(payload.agentId).toBe(agent.id);
    expect(payload.profileKey).toBe("ata-victor");
  });

  it("does nothing when description is already non-empty (protects human content)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ATB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const template = "### Context\n\n### Acceptance criteria";
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "atb-victor",
      templateMarkdown: template,
    });
    const human = "Original human description — please preserve.";
    const issue = await createIssue(fixture, { title: "has-desc" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { description: human },
    });

    const res = await maybeApplyAgentTemplate(prisma, issue.id, agent.id);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("description-not-empty");

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.description).toBe(human);

    // No audit row for this no-op.
    const audit = await prisma.auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Issue",
        entityId: issue.id,
        action: "apply-agent-template",
      },
    });
    expect(audit).toBeNull();
  });

  it("does nothing when the agent has no template configured", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ATC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "atc-notemplate",
      templateMarkdown: null,
    });
    const issue = await createIssue(fixture, { title: "no-template" });

    const res = await maybeApplyAgentTemplate(prisma, issue.id, agent.id);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("no-template");

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.description).toBeNull();
  });

  it("does nothing when the agent has an empty-string template", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ATD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // Empty string template is also treated as "not configured" — we
    // don't want the helper to overwrite a description with literally "".
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "atd-empty",
      templateMarkdown: "",
    });
    const issue = await createIssue(fixture, { title: "empty-template" });

    const res = await maybeApplyAgentTemplate(prisma, issue.id, agent.id);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("no-template");
  });

  it("re-assignment to a different agent on an already-templated issue is a no-op", async () => {
    // Intentional design: once a template has been applied, the description
    // is no longer empty, so a subsequent assignment to a different agent
    // with its own template won't clobber the first agent's structure.
    // Callers who want to refresh should clear the description first.
    const fixture = await createWorkspaceFixture({ keyPrefix: "ATE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const templateA = "### Context\n\nA\n";
    const templateB = "### Scope\n\nB\n";
    const agentA = await createAgent(fixture.workspace.id, {
      profileKey: "ate-a",
      templateMarkdown: templateA,
    });
    const agentB = await createAgent(fixture.workspace.id, {
      profileKey: "ate-b",
      templateMarkdown: templateB,
    });
    const issue = await createIssue(fixture, { title: "reassign" });

    // First application — populates the description from agent A.
    const firstRes = await maybeApplyAgentTemplate(prisma, issue.id, agentA.id);
    expect(firstRes.applied).toBe(true);
    const afterFirst = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(afterFirst.description).toBe(templateA);

    // Second application (reassign to agent B) — the description is now
    // non-empty (it was populated by agent A), so the helper must no-op.
    const secondRes = await maybeApplyAgentTemplate(prisma, issue.id, agentB.id);
    expect(secondRes.applied).toBe(false);
    expect(secondRes.reason).toBe("description-not-empty");
    const afterSecond = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    // Still agent A's template — agent B's structure is not applied.
    expect(afterSecond.description).toBe(templateA);
  });

  it("treats whitespace-only descriptions as empty", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ATF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const template = "### Context\n";
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "atf-ws",
      templateMarkdown: template,
    });
    const issue = await createIssue(fixture, { title: "ws-only" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { description: "   \n  \t  " },
    });

    const res = await maybeApplyAgentTemplate(prisma, issue.id, agent.id);
    expect(res.applied).toBe(true);
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.description).toBe(template);
  });
});
