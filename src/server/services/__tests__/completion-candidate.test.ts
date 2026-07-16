import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ActionRequestStatus, CompletionAutomation } from "@prisma/client";
import {
  evaluateIssueCompletionCandidate,
  reconcileGitHubPullRequestCompletion,
  sweepCompletionCandidates,
} from "@/server/services/completion-candidate";
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

afterAll(async () => {
  await disconnectPrisma();
});

async function setup(policy: CompletionAutomation = CompletionAutomation.RECOMMEND) {
  const fixture = await createWorkspaceFixture({ keyPrefix: "CP" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const done = await prisma.status.findFirstOrThrow({
    where: { workspaceId: fixture.workspace.id, category: "DONE" },
  });
  const started = await prisma.status.findFirstOrThrow({
    where: { workspaceId: fixture.workspace.id, category: "IN_PROGRESS" },
  });
  await prisma.workspace.update({
    where: { id: fixture.workspace.id },
    data: {
      completionAutomation: policy,
      completionStatusId: done.id,
      startedStatusId: started.id,
    },
  });
  return { fixture, prisma, done, started };
}

async function linkedPullRequest(
  fixture: TestFixture,
  issueId: string,
  state: "open" | "closed" | "merged",
  conclusion: string | null = "success",
  kind: "IMPLEMENTS" | "FIXES" = "IMPLEMENTS",
) {
  const prisma = getPrisma();
  const resource = await prisma.externalResource.create({
    data: {
      workspaceId: fixture.workspace.id,
      provider: "GITHUB",
      resourceType: "PULL_REQUEST",
      repoFullName: "acme/forge",
      number: Math.floor(Math.random() * 100_000) + 1,
      url: "https://github.com/acme/forge/pull/42",
      title: "Complete issue",
      state,
      metadata: conclusion
        ? { checks: { status: "completed", conclusion, source: "api-aggregate" } }
        : {},
    },
  });
  await prisma.externalResourceLink.create({
    data: {
      workspaceId: fixture.workspace.id,
      issueId,
      externalResourceId: resource.id,
      kind,
      createdById: fixture.user.id,
    },
  });
  return resource;
}

describe("completion candidate policy", () => {
  it("treats an explicit fixes/closes PR as implementation evidence", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const pullRequest = await linkedPullRequest(fixture, issue.id, "merged", "success", "FIXES");

    const result = await evaluateIssueCompletionCandidate(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      actorId: fixture.user.id,
      sourceType: "github-pull-request",
      sourceId: pullRequest.id,
      sourceLabel: "Fixes AXI issue",
    });

    expect(result.outcome).toBe("RECOMMENDED");
    const request = await prisma.actionRequest.findUniqueOrThrow({
      where: { id: "requestId" in result ? result.requestId : "" },
    });
    expect(request.payload).toMatchObject({ assessment: { state: "READY" } });
  });

  it("refreshes one durable recommendation for repeated completion signals", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });

    const first = await evaluateIssueCompletionCandidate(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      actorId: fixture.user.id,
      sourceType: "agent-run",
      sourceId: "run-1",
      sourceLabel: "@victor",
      evidence: [{ label: "Tests", value: "passing", tone: "SUCCESS" }],
    });
    const second = await evaluateIssueCompletionCandidate(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      actorId: fixture.user.id,
      sourceType: "agent-run",
      sourceId: "run-2",
      sourceLabel: "@victor",
      evidence: [{ label: "Tests", value: "still passing", tone: "SUCCESS" }],
    });
    await evaluateIssueCompletionCandidate(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      actorId: fixture.user.id,
      sourceType: "agent-run",
      sourceId: "run-2",
      sourceLabel: "@victor",
      evidence: [{ label: "Tests", value: "still passing", tone: "SUCCESS" }],
    });

    expect(first.outcome).toBe("RECOMMENDED");
    expect(second.outcome).toBe("RECOMMENDED");
    expect("requestId" in first && "requestId" in second && second.requestId).toBe(
      "requestId" in first ? first.requestId : null,
    );
    expect(
      await prisma.actionRequest.count({
        where: { issueId: issue.id, status: ActionRequestStatus.OPEN },
      }),
    ).toBe(1);
    expect(
      await prisma.activityEvent.count({
        where: { workspaceId: fixture.workspace.id, subjectType: "action-request" },
      }),
    ).toBe(2);
    await sweepCompletionCandidates(prisma, { workspaceId: fixture.workspace.id });
    expect(
      await prisma.activityEvent.count({
        where: { workspaceId: fixture.workspace.id, subjectType: "action-request" },
      }),
    ).toBe(2);
  });

  it("automatically completes only when the shared safety gate is clear", async () => {
    const { fixture, prisma, done } = await setup(CompletionAutomation.AUTO_WHEN_SAFE);
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });

    const result = await evaluateIssueCompletionCandidate(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      actorId: fixture.user.id,
      sourceType: "agent-run",
      sourceId: "run-safe",
      sourceLabel: "@victor",
    });

    expect(result).toEqual({ outcome: "AUTO_COMPLETED", statusId: done.id });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).statusId).toBe(
      done.id,
    );
  });

  it("holds automatic completion and explains unresolved decisions", async () => {
    const { fixture, prisma } = await setup(CompletionAutomation.AUTO_WHEN_SAFE);
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const blocker = await prisma.actionRequest.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        title: "Choose rollout window",
        body: "Still needs a decision.",
      },
    });

    const result = await evaluateIssueCompletionCandidate(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      actorId: fixture.user.id,
      sourceType: "agent-run",
      sourceId: "run-held",
      sourceLabel: "@victor",
    });

    expect(result.outcome).toBe("RECOMMENDED");
    expect(result.outcome === "RECOMMENDED" && result.autoHeldReasons.join(" ")).toContain(
      "decision",
    );

    await prisma.actionRequest.update({
      where: { id: blocker.id },
      data: { status: ActionRequestStatus.RESOLVED, resolvedAt: new Date() },
    });
    expect(
      await sweepCompletionCandidates(prisma, { workspaceId: fixture.workspace.id }),
    ).toMatchObject({ inspected: 1, reconciled: 1 });
    expect(
      (await prisma.issue.findUniqueOrThrow({ where: { id: issue.id }, include: { status: true } }))
        .status.category,
    ).toBe("DONE");
  });

  it("uses merged PR checks for safe completion and creates recovery for closed PRs", async () => {
    const { fixture, prisma } = await setup(CompletionAutomation.AUTO_WHEN_SAFE);
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const merged = await linkedPullRequest(fixture, issue.id, "merged", "success");

    await reconcileGitHubPullRequestCompletion(prisma, {
      workspaceId: fixture.workspace.id,
      externalResourceId: merged.id,
      actorId: fixture.user.id,
    });
    expect(
      (await prisma.issue.findUniqueOrThrow({ where: { id: issue.id }, include: { status: true } }))
        .status.category,
    ).toBe("DONE");

    const review = await prisma.status.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "In review",
        category: "IN_REVIEW",
        color: "#d97706",
        position: 10,
      },
    });
    const recoveryIssue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    await prisma.issue.update({ where: { id: recoveryIssue.id }, data: { statusId: review.id } });
    const closed = await linkedPullRequest(fixture, recoveryIssue.id, "closed", "failure");
    await reconcileGitHubPullRequestCompletion(prisma, {
      workspaceId: fixture.workspace.id,
      externalResourceId: closed.id,
      actorId: fixture.user.id,
    });

    const request = await prisma.actionRequest.findFirstOrThrow({
      where: { issueId: recoveryIssue.id, status: "OPEN" },
    });
    expect(request.sourceType).toBe("github-pr-recovery");
    expect(request.payload).toMatchObject({ intent: "RECOVER" });
  });

  it("rebuilds verifying PR evidence from the latest aggregate during the sweep", async () => {
    const { fixture, prisma } = await setup(CompletionAutomation.RECOMMEND);
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const merged = await linkedPullRequest(fixture, issue.id, "merged", null);
    await prisma.externalResource.update({
      where: { id: merged.id },
      data: {
        metadata: {
          checks: {
            source: "webhook-hint",
            status: "dirty",
            conclusion: null,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    });

    await reconcileGitHubPullRequestCompletion(prisma, {
      workspaceId: fixture.workspace.id,
      externalResourceId: merged.id,
      actorId: fixture.user.id,
    });
    const verifying = await prisma.actionRequest.findFirstOrThrow({
      where: { issueId: issue.id, status: ActionRequestStatus.OPEN },
    });
    expect(verifying.payload).toMatchObject({
      assessment: {
        version: 1,
        state: "VERIFYING",
        facts: expect.arrayContaining([
          expect.objectContaining({ key: `checks:${merged.id}`, status: "VERIFYING" }),
        ]),
      },
    });

    await prisma.externalResource.update({
      where: { id: merged.id },
      data: {
        metadata: {
          checks: {
            source: "api-aggregate",
            status: "completed",
            conclusion: "success",
            suiteCount: 7,
            statusCount: 2,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    });
    await sweepCompletionCandidates(prisma, { workspaceId: fixture.workspace.id });

    const ready = await prisma.actionRequest.findUniqueOrThrow({ where: { id: verifying.id } });
    expect(ready.title).toContain("is ready to close");
    expect(ready.payload).toMatchObject({
      assessment: {
        version: 1,
        state: "READY",
        facts: expect.arrayContaining([
          expect.objectContaining({
            key: `checks:${merged.id}`,
            status: "PASS",
            summary: "9 check signals · checks passed",
          }),
        ]),
      },
      sourceEvidence: [],
      autoHeldReasons: [],
    });
  });

  it("separates failed, unavailable, and stale check assessments", async () => {
    const { fixture, prisma } = await setup(CompletionAutomation.RECOMMEND);
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const merged = await linkedPullRequest(fixture, issue.id, "merged", "failure");

    await reconcileGitHubPullRequestCompletion(prisma, {
      workspaceId: fixture.workspace.id,
      externalResourceId: merged.id,
      actorId: fixture.user.id,
    });
    let request = await prisma.actionRequest.findFirstOrThrow({
      where: { issueId: issue.id, status: ActionRequestStatus.OPEN },
    });
    expect(request.payload).toMatchObject({
      assessment: { state: "BLOCKED" },
      autoHeldReasons: expect.arrayContaining([expect.stringContaining("failed")]),
    });

    await prisma.externalResource.update({
      where: { id: merged.id },
      data: {
        metadata: {
          checks: {
            source: "api-aggregate",
            status: "unknown",
            conclusion: null,
            partial: true,
            permissionDenied: true,
            diagnostic: "GitHub App cannot read check suites.",
            updatedAt: new Date().toISOString(),
          },
        },
      },
    });
    await sweepCompletionCandidates(prisma, { workspaceId: fixture.workspace.id });
    request = await prisma.actionRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(request.payload).toMatchObject({
      assessment: {
        state: "UNAVAILABLE",
        facts: expect.arrayContaining([
          expect.objectContaining({
            key: `checks:${merged.id}`,
            status: "UNAVAILABLE",
            diagnostic: "GitHub App cannot read check suites.",
          }),
        ]),
      },
    });

    await prisma.externalResource.update({
      where: { id: merged.id },
      data: {
        metadata: {
          checks: {
            source: "api-aggregate",
            status: "completed",
            conclusion: "success",
            updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
          },
        },
      },
    });
    await sweepCompletionCandidates(prisma, { workspaceId: fixture.workspace.id });
    request = await prisma.actionRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(request.payload).toMatchObject({
      assessment: {
        state: "STALE",
        facts: expect.arrayContaining([
          expect.objectContaining({ key: `checks:${merged.id}`, status: "STALE" }),
        ]),
      },
    });
  });
});
