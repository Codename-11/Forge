import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  resolveSubjectLabels,
  subjectKey,
} from "@/server/services/subject-labels";
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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "SUB" });
  fixtures.push(fixture);
  return { fixture, prisma: getPrisma() };
}

describe("resolveSubjectLabels", () => {
  it("labels issues with their title + key, agents with name + handle, projects by name", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture, { title: "Fix the thing" });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Helper Bot",
        profileKey: "helper",
      },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "OPS",
        name: "Operations",
        createdById: fixture.user.id,
      },
    });

    const labels = await resolveSubjectLabels(
      prisma,
      [
        { subjectType: "issue", subjectId: issue.id },
        { subjectType: "agent", subjectId: agent.id },
        { subjectType: "project", subjectId: project.id },
        // Unresolvable type → absent (caller falls back to short id).
        { subjectType: "chat-thread", subjectId: "ct_whatever" },
        // Missing id → skipped entirely.
        { subjectType: "issue", subjectId: null },
      ],
      { workspaceId: fixture.workspace.id },
    );

    const issueLabel = labels.get(subjectKey("issue", issue.id));
    expect(issueLabel?.label).toBe("Fix the thing");
    expect(issueLabel?.secondary).toBe(
      `${fixture.workspace.key}-${issue.number}`,
    );

    const agentLabel = labels.get(subjectKey("agent", agent.id));
    expect(agentLabel?.label).toBe("Helper Bot");
    expect(agentLabel?.secondary).toBe("@helper");

    expect(labels.get(subjectKey("project", project.id))?.label).toBe(
      "Operations",
    );
    expect(labels.has(subjectKey("chat-thread", "ct_whatever"))).toBe(false);
  });

  it("scopes lookups to the workspace when asked", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture, { title: "Scoped issue" });

    // A different workspace can't resolve this issue when scoped.
    const other = await createWorkspaceFixture({ keyPrefix: "OTH" });
    fixtures.push(other);
    const scopedToOther = await resolveSubjectLabels(
      prisma,
      [{ subjectType: "issue", subjectId: issue.id }],
      { workspaceId: other.workspace.id },
    );
    expect(scopedToOther.has(subjectKey("issue", issue.id))).toBe(false);

    // Unscoped (instance-admin) resolves it regardless of workspace.
    const global = await resolveSubjectLabels(prisma, [
      { subjectType: "issue", subjectId: issue.id },
    ]);
    expect(global.get(subjectKey("issue", issue.id))?.label).toBe("Scoped issue");
  });
});
