import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createOrchestrationContextSnapshot,
  formatOrchestrationContextForPrompt,
  loadIssueOrchestrationContext,
  loadRunOrchestrationContext,
  readOrchestrationContextSnapshot,
} from "@/server/services/orchestration-context";
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

describe("orchestration context", () => {
  it("hydrates goal, DAG, completion contract, retry feedback, and source-run evidence", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "OCT" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const dependencyIssue = await createIssue(fixture, { title: "Build parser" });
    const reviewIssue = await createIssue(fixture, { title: "Review parser" });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: "oct-worker",
        name: "Context worker",
      },
    });
    const goal = await prisma.goal.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Ship rich rendering",
        description: "Render issue bodies safely and consistently.",
        successCriteria: "Every issue surface renders the same document model.",
        status: "ACTIVE",
      },
    });
    const contextSet = await prisma.contextSet.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Rendering references",
        items: {
          create: [
            {
              workspaceId: fixture.workspace.id,
              targetType: "issue",
              targetId: dependencyIssue.id,
              note: "Reuse the parser contract",
            },
            {
              workspaceId: fixture.workspace.id,
              targetType: "issue",
              targetId: "excluded-secret-target",
              includeMode: "EXCLUDE",
              note: "excluded-secret-note",
              position: 1,
            },
          ],
        },
      },
    });
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        goalId: goal.id,
        contextSetId: contextSet.id,
        title: "Rich rendering rollout",
        description: "Implement, review, and ship the renderer.",
        status: "RUNNING",
        maxStepRetries: 3,
      },
    });
    const dependency = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        issueId: dependencyIssue.id,
        title: "Build renderer",
        position: 0,
        status: "DONE",
      },
    });
    const review = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        issueId: reviewIssue.id,
        title: "Review renderer",
        body: "Check the implementation against the shared rendering contract.",
        position: 1,
        status: "REVIEW",
        dependsOnStepIds: [dependency.id],
        expectedOutput: "A review verdict with actionable evidence.",
        verification: ["Run renderer tests", "Inspect malformed markdown"],
        retryCount: 1,
        lastFeedback: "The first pass missed malformed link handling.",
      },
    });
    const sourceRun = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: reviewIssue.id,
        agentId: agent.id,
        executionStepId: review.id,
        status: "COMPLETED",
        summary: "Implemented the parser and added malformed-link coverage.",
        producedArtifactIds: ["artifact-renderer-report"],
        verificationResult: [{ item: "renderer tests", done: true }],
        completionMeta: { contractVersion: "2026-test" },
        completedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    await prisma.executionStep.update({
      where: { id: review.id },
      data: { sourceRunId: sourceRun.id },
    });

    const context = await loadIssueOrchestrationContext(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: reviewIssue.id,
      executionStepId: review.id,
    });

    expect(context).toMatchObject({
      goal: { id: goal.id, title: "Ship rich rendering" },
      plan: { id: plan.id, progress: { done: 1, total: 2 } },
      step: {
        id: review.id,
        retryCount: 1,
        lastFeedback: "The first pass missed malformed link handling.",
        completionContract: {
          expectedOutput: "A review verdict with actionable evidence.",
        },
        sourceRun: {
          id: sourceRun.id,
          producedArtifactIds: ["artifact-renderer-report"],
        },
      },
      dependencies: [{ id: dependency.id }],
      contextSet: { id: contextSet.id, items: [{ targetId: dependencyIssue.id }] },
    });
    const prompt = formatOrchestrationContextForPrompt(context);
    expect(prompt).toContain("Goal: Ship rich rendering");
    expect(prompt).toContain("Retry feedback to address");
    expect(prompt).toContain("artifact-renderer-report");
    expect(prompt).toContain("Worker verification evidence");
    expect(prompt).toContain(`${fixture.workspace.key}-${dependencyIssue.number}`);
    expect(context?.contextSet?.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: "excluded-secret-target" })]),
    );
    expect(prompt).not.toContain("excluded-secret-target");
    expect(prompt).not.toContain("excluded-secret-note");
  });

  it("returns plan-level anchor context without guessing among its steps", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "OCA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const anchor = await createIssue(fixture, { title: "Plan anchor" });
    const goal = await prisma.goal.create({
      data: { workspaceId: fixture.workspace.id, title: "Anchor goal", status: "ACTIVE" },
    });
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: anchor.id,
        goalId: goal.id,
        title: "Anchor plan",
        status: "RUNNING",
      },
    });
    const first = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "First",
        position: 0,
        status: "READY",
      },
    });
    await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Second",
        position: 1,
        status: "TODO",
        dependsOnStepIds: [first.id],
      },
    });

    const anchorContext = await loadIssueOrchestrationContext(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: anchor.id,
    });
    expect(anchorContext).toMatchObject({
      goal: { id: goal.id },
      plan: { id: plan.id },
      step: null,
    });
    expect(formatOrchestrationContextForPrompt(anchorContext)).toContain(
      "without assuming a specific step assignment",
    );

    const exactContext = await loadIssueOrchestrationContext(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: anchor.id,
      executionStepId: first.id,
    });
    expect(exactContext?.step?.id).toBe(first.id);
  });

  it("prefers a versioned run snapshot while legacy rows retain live fallback", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "OCS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Snapshot issue" });
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Original plan title",
        status: "RUNNING",
      },
    });
    const step = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        issueId: issue.id,
        title: "Original step title",
        position: 0,
        status: "RUNNING",
      },
    });
    const live = await loadIssueOrchestrationContext(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      executionStepId: step.id,
    });
    expect(live).not.toBeNull();
    const snapshot = createOrchestrationContextSnapshot(live!);
    expect(readOrchestrationContextSnapshot(snapshot)).toMatchObject({
      plan: { title: "Original plan title" },
      step: { title: "Original step title" },
    });

    await prisma.executionPlan.update({
      where: { id: plan.id },
      data: { title: "Edited plan title" },
    });
    await prisma.executionStep.update({
      where: { id: step.id },
      data: { title: "Edited step title" },
    });

    const frozen = await loadRunOrchestrationContext(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      executionStepId: step.id,
      snapshot,
    });
    expect(frozen).toMatchObject({
      plan: { title: "Original plan title" },
      step: { title: "Original step title" },
    });

    const legacyFallback = await loadRunOrchestrationContext(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      executionStepId: step.id,
      snapshot: null,
    });
    expect(legacyFallback).toMatchObject({
      plan: { title: "Edited plan title" },
      step: { title: "Edited step title" },
    });
  });
});
