/**
 * Deterministic issue lifecycle fixtures for UX audits.
 *
 * Guarded behind FORGE_LIFECYCLE_LAB=1 and intended only for the dedicated
 * forge_lifecycle database provisioned by scripts/lifecycle-lab.sh.
 */
import {
  ActionRequestKind,
  ActionRequestStatus,
  AgentRunStatus,
  CommentKind,
  EventKind,
  ExecutionPlanStatus,
  ExecutionStepStatus,
  NotificationSeverity,
  NotificationStatus,
  PrismaClient,
  Priority,
  ReviewGateStatus,
} from "@prisma/client";

if (process.env.FORGE_LIFECYCLE_LAB !== "1") {
  throw new Error("Refusing to seed lifecycle fixtures without FORGE_LIFECYCLE_LAB=1");
}

const prisma = new PrismaClient();
const MINUTE = 60_000;
const ISSUE_IDS = {
  queued: "clifecyclequeued000000000001",
  assigned: "clifecycleassigned0000000001",
  active: "clifecycleactive000000000001",
  waiting: "clifecyclewaiting0000000001",
  approval: "clifecycleapproval000000001",
  review: "clifecyclereview00000000001",
  completed: "clifecyclecompleted00000001",
  stalled: "clifecyclestalled0000000001",
} as const;
const LAB_ISSUE_IDS = Object.values(ISSUE_IDS);

function ago(minutes: number) {
  return new Date(Date.now() - minutes * MINUTE);
}

async function main() {
  const workspace = await prisma.workspace.findUnique({ where: { slug: "forge" } });
  const owner = await prisma.user.findUnique({ where: { email: "owner@forge.local" } });
  if (!workspace || !owner) throw new Error("Run prisma/seed.ts before the lifecycle seed");

  const [agent, project, statuses] = await Promise.all([
    prisma.agent.findUnique({
      where: {
        workspaceId_profileKey: { workspaceId: workspace.id, profileKey: "e2ebot" },
      },
    }),
    prisma.project.findUnique({
      where: { workspaceId_key: { workspaceId: workspace.id, key: "CORE" } },
    }),
    prisma.status.findMany({ where: { workspaceId: workspace.id } }),
  ]);
  if (!agent || !project) throw new Error("Lifecycle seed requires E2E fixtures and CORE project");

  const statusId = (name: string) => {
    const status = statuses.find((row) => row.name === name);
    if (!status) throw new Error(`Missing status: ${name}`);
    return status.id;
  };

  // Polymorphic tables do not all cascade from Issue, so remove the previous
  // lab slice explicitly before recreating it. Other seed/user data is untouched.
  const oldPlans = await prisma.executionPlan.findMany({
    where: { issueId: { in: LAB_ISSUE_IDS } },
    select: { id: true, steps: { select: { id: true } } },
  });
  const oldTargetIds = oldPlans.flatMap((plan) => [plan.id, ...plan.steps.map((step) => step.id)]);
  await prisma.$transaction([
    prisma.reviewGate.deleteMany({
      where: {
        workspaceId: workspace.id,
        OR: [
          { targetId: { in: LAB_ISSUE_IDS } },
          ...(oldTargetIds.length ? [{ targetId: { in: oldTargetIds } }] : []),
        ],
      },
    }),
    prisma.actionRequest.deleteMany({
      where: { workspaceId: workspace.id, issueId: { in: LAB_ISSUE_IDS } },
    }),
    prisma.activityEvent.deleteMany({
      where: { workspaceId: workspace.id, subjectType: "issue", subjectId: { in: LAB_ISSUE_IDS } },
    }),
    prisma.executionPlan.deleteMany({
      where: { workspaceId: workspace.id, issueId: { in: LAB_ISSUE_IDS } },
    }),
    prisma.issue.deleteMany({
      where: { workspaceId: workspace.id, id: { in: LAB_ISSUE_IDS } },
    }),
  ]);

  const common = {
    workspaceId: workspace.id,
    projectId: project.id,
    authorId: owner.id,
    priority: Priority.HIGH,
    expectedOutput: "A clear final comment with outcome, evidence, and any follow-up work.",
    verificationChecklist: [
      { id: "journey", label: "Lifecycle state is visible after reload", kind: "manual" },
      { id: "handoff", label: "Operator can identify the next action", kind: "manual" },
    ],
  };

  await prisma.issue.createMany({
    data: [
      {
        ...common,
        id: ISSUE_IDS.queued,
        number: 9001,
        title: "Lifecycle Lab · Ready to assign",
        description:
          "Queued work with no agent yet. The operator should see that it is ready, unowned, and needs dispatch.",
        statusId: statusId("Todo"),
        queued: true,
      },
      {
        ...common,
        id: ISSUE_IDS.assigned,
        number: 9002,
        title: "Lifecycle Lab · Assigned, awaiting acknowledgement",
        description: "The agent has been dispatched but has not acknowledged the wake.",
        statusId: statusId("Todo"),
        assignedAgentId: agent.id,
      },
      {
        ...common,
        id: ISSUE_IDS.active,
        number: 9003,
        title: "Lifecycle Lab · Agent actively working",
        description: "An acknowledged run with live progress and a rolling status update.",
        statusId: statusId("In Progress"),
        assignedAgentId: agent.id,
        startedAt: ago(42),
      },
      {
        ...common,
        id: ISSUE_IDS.waiting,
        number: 9004,
        title: "Lifecycle Lab · Waiting for user reply",
        description: "The agent needs a product decision before it can continue.",
        statusId: statusId("In Progress"),
        assignedAgentId: agent.id,
        startedAt: ago(65),
      },
      {
        ...common,
        id: ISSUE_IDS.approval,
        number: 9005,
        title: "Lifecycle Lab · Runtime approval required",
        description: "The runtime paused before a destructive command and needs explicit approval.",
        statusId: statusId("In Progress"),
        assignedAgentId: agent.id,
        startedAt: ago(28),
      },
      {
        ...common,
        id: ISSUE_IDS.review,
        number: 9006,
        title: "Lifecycle Lab · Ready for review",
        description: "Execution is complete and a human review gate is blocking closure.",
        statusId: statusId("In Review"),
        assignedAgentId: agent.id,
        startedAt: ago(110),
      },
      {
        ...common,
        id: ISSUE_IDS.completed,
        number: 9007,
        title: "Lifecycle Lab · Completed with final handoff",
        description:
          "A successful run with verification evidence and an explicit final agent comment.",
        statusId: statusId("Done"),
        assignedAgentId: agent.id,
        startedAt: ago(150),
        completedAt: ago(12),
      },
      {
        ...common,
        id: ISSUE_IDS.stalled,
        number: 9008,
        title: "Lifecycle Lab · Stalled and needs recovery",
        description:
          "A run stopped emitting progress and should surface as a recoverable operational alert.",
        statusId: statusId("In Progress"),
        assignedAgentId: agent.id,
        startedAt: ago(190),
      },
    ],
  });

  const assignmentEvent = await prisma.activityEvent.create({
    data: {
      workspaceId: workspace.id,
      kind: EventKind.AGENT_ASSIGNED,
      actorId: owner.id,
      subjectType: "issue",
      subjectId: ISSUE_IDS.assigned,
      payload: { agentId: agent.id, agentProfileKey: agent.profileKey, number: 9002 },
      createdAt: ago(18),
    },
  });
  const assignedRun = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.assigned,
      agentId: agent.id,
      status: AgentRunStatus.ACTIVE,
      startedAt: ago(18),
      lastEventAt: ago(1),
      currentStep: "Wake sent · awaiting acknowledgement",
      assignmentEventId: assignmentEvent.id,
      triggerEventId: assignmentEvent.id,
      triggerKind: EventKind.AGENT_ASSIGNED,
      wakeAttempts: 1,
    },
  });
  await prisma.agentRunEvent.create({
    data: {
      workspaceId: workspace.id,
      runId: assignedRun.id,
      kind: "STARTED",
      payload: { message: "Dispatch wake sent" },
      createdAt: ago(18),
    },
  });

  const activeRun = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.active,
      agentId: agent.id,
      status: AgentRunStatus.ACTIVE,
      startedAt: ago(42),
      lastEventAt: ago(2),
      currentStep: "Running lifecycle regression tests",
      acknowledgedAt: ago(41),
      outputStartedAt: ago(39),
      tokensIn: 8400,
      tokensOut: 1900,
      costUsd: 0.1834,
    },
  });
  await prisma.agentRunEvent.createMany({
    data: [
      {
        workspaceId: workspace.id,
        runId: activeRun.id,
        kind: "STARTED",
        payload: { message: "Run acknowledged" },
        createdAt: ago(42),
      },
      {
        workspaceId: workspace.id,
        runId: activeRun.id,
        kind: "STEP",
        payload: { message: "Mapped state transitions" },
        createdAt: ago(12),
      },
      {
        workspaceId: workspace.id,
        runId: activeRun.id,
        kind: "STATUS",
        payload: { message: "Running lifecycle regression tests" },
        createdAt: ago(2),
      },
    ],
  });
  await prisma.comment.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.active,
      authorId: owner.id,
      authoringAgentId: agent.id,
      kind: CommentKind.STATUS,
      runId: activeRun.id,
      currentStep: "Running lifecycle regression tests",
      body: "Mapped the issue states and now verifying navigation, reload persistence, and responsive visibility.",
      revisions: [],
      createdAt: ago(39),
      updatedAt: ago(2),
    },
  });

  const waitingRun = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.waiting,
      agentId: agent.id,
      status: AgentRunStatus.WAITING,
      startedAt: ago(65),
      lastEventAt: ago(8),
      currentStep: "Waiting on your product decision",
      acknowledgedAt: ago(64),
      outputStartedAt: ago(61),
    },
  });
  await prisma.agentRunEvent.create({
    data: {
      workspaceId: workspace.id,
      runId: waitingRun.id,
      kind: "BLOCKED",
      payload: { reason: "Operator decision required" },
      createdAt: ago(8),
    },
  });
  const waitingComment = await prisma.comment.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.waiting,
      authorId: owner.id,
      authoringAgentId: agent.id,
      body: "@owner Should the completion summary optimize for operators scanning the Command Center, or for the full issue activity record? I can proceed as soon as you choose.",
      suggestedReplies: ["Optimize for Command Center", "Optimize for issue detail", "Use both"],
      confidence: "HIGH",
      createdAt: ago(8),
      updatedAt: ago(8),
    },
  });
  await prisma.actionRequest.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.waiting,
      title: "Choose the completion-summary emphasis",
      body: "The agent is blocked until the operator chooses how the handoff should be optimized. This intentionally has enough detail to verify clean card truncation and expansion behavior across Command Center and issue detail.",
      status: ActionRequestStatus.OPEN,
      severity: NotificationSeverity.WARNING,
      kind: ActionRequestKind.FREE_FORM,
      requestedByAgentId: agent.id,
      assignedUserId: owner.id,
      sourceType: "comment",
      sourceId: waitingComment.id,
      dueAt: new Date(Date.now() + 120 * MINUTE),
      createdAt: ago(8),
      updatedAt: ago(8),
    },
  });

  const approvalRun = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.approval,
      agentId: agent.id,
      status: AgentRunStatus.WAITING,
      startedAt: ago(28),
      lastEventAt: ago(4),
      currentStep: "Approval required before database migration",
      acknowledgedAt: ago(27),
      outputStartedAt: ago(25),
      awaitingApprovalAt: ago(4),
      pendingApproval: {
        command: "pnpm exec prisma migrate deploy",
        description:
          "Apply the reviewed lifecycle notification migration to the isolated lab database.",
        choices: ["approve", "reject"],
      },
    },
  });
  await prisma.agentRunEvent.create({
    data: {
      workspaceId: workspace.id,
      runId: approvalRun.id,
      kind: "APPROVAL_REQUESTED",
      payload: { command: "pnpm exec prisma migrate deploy" },
      createdAt: ago(4),
    },
  });

  const reviewPlan = await prisma.executionPlan.create({
    data: {
      id: "clifecycleplanreview000000001",
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.review,
      title: "Lifecycle review handoff",
      description: "Verify that the completed work is clear and ready to close.",
      status: ExecutionPlanStatus.RUNNING,
      createdById: owner.id,
      startedAt: ago(105),
    },
  });
  const reviewStep = await prisma.executionStep.create({
    data: {
      id: "clifecyclestepreview000000001",
      workspaceId: workspace.id,
      planId: reviewPlan.id,
      issueId: ISSUE_IDS.review,
      title: "Verify lifecycle handoff",
      body: "Check the operator-facing status, evidence, final comment, and next action.",
      position: 0,
      status: ExecutionStepStatus.REVIEW,
      assignedAgentId: agent.id,
      expectedOutput: "A review decision with concise feedback.",
      verification: [{ label: "State and next action are immediately clear", done: true }],
    },
  });
  const reviewRun = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.review,
      agentId: agent.id,
      executionStepId: reviewStep.id,
      status: AgentRunStatus.COMPLETED,
      startedAt: ago(100),
      lastEventAt: ago(22),
      finishedAt: ago(22),
      completedAt: ago(22),
      currentStep: "Ready for review",
      summary: "Implemented the lifecycle status pass and verified the primary operator surfaces.",
      acknowledgedAt: ago(99),
      outputStartedAt: ago(96),
      verificationResult: [
        {
          id: "journey",
          label: "Lifecycle state is visible after reload",
          done: true,
        },
        {
          id: "handoff",
          label: "Operator can identify the next action",
          done: true,
        },
      ],
      completionMeta: { confidence: "HIGH", contractVersion: 1 },
    },
  });
  await prisma.executionStep.update({
    where: { id: reviewStep.id },
    data: { sourceRunId: reviewRun.id },
  });
  await prisma.reviewGate.create({
    data: {
      id: "clifecyclegate00000000000001",
      workspaceId: workspace.id,
      targetType: "execution-step",
      targetId: reviewStep.id,
      status: ReviewGateStatus.PENDING,
      requestedByAgentId: agent.id,
      prompt:
        "Does this handoff clearly communicate outcome, evidence, and the next operator action?",
      createdAt: ago(20),
    },
  });
  await prisma.comment.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.review,
      authorId: owner.id,
      authoringAgentId: agent.id,
      body: "Implementation is complete and the verification checklist passes. I moved this to review; please approve the gate or leave specific feedback.",
      confidence: "HIGH",
      createdAt: ago(22),
      updatedAt: ago(22),
    },
  });

  const completedRun = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.completed,
      agentId: agent.id,
      status: AgentRunStatus.COMPLETED,
      startedAt: ago(150),
      lastEventAt: ago(12),
      finishedAt: ago(12),
      completedAt: ago(12),
      currentStep: "Complete",
      summary: "Lifecycle states remain visible and actionable across navigation and reloads.",
      acknowledgedAt: ago(149),
      outputStartedAt: ago(145),
      verificationResult: [
        {
          id: "journey",
          label: "Lifecycle state is visible after reload",
          done: true,
        },
        {
          id: "handoff",
          label: "Operator can identify the next action",
          done: true,
        },
      ],
      followUps: [{ title: "Monitor notification fatigue after rollout", kind: "observation" }],
      completionMeta: { confidence: "HIGH", contractVersion: 1 },
      tokensIn: 12900,
      tokensOut: 3400,
      costUsd: 0.2761,
    },
  });
  await prisma.agentRunEvent.create({
    data: {
      workspaceId: workspace.id,
      runId: completedRun.id,
      kind: "COMPLETED",
      payload: { summary: "Lifecycle verification passed" },
      createdAt: ago(12),
    },
  });
  await prisma.comment.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.completed,
      authorId: owner.id,
      authoringAgentId: agent.id,
      body: "Completed. The operator journey now exposes queued, active, waiting, review, recovery, and done states across the issue page, Inbox, Command Center, and shared alert drawer. Verification passed after navigating away and reloading. Follow-up: monitor whether repeated stalled alerts create noise.",
      confidence: "HIGH",
      createdAt: ago(12),
      updatedAt: ago(12),
    },
  });

  const stalledRun = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      issueId: ISSUE_IDS.stalled,
      agentId: agent.id,
      status: AgentRunStatus.STALLED,
      startedAt: ago(190),
      lastEventAt: ago(95),
      finishedAt: ago(90),
      currentStep: "No progress after test runner launch",
      summary: "The run stopped emitting events while waiting for the browser test process.",
      acknowledgedAt: ago(189),
      outputStartedAt: ago(184),
      wakeAttempts: 2,
    },
  });
  await prisma.agentRunEvent.create({
    data: {
      workspaceId: workspace.id,
      runId: stalledRun.id,
      kind: "ERRORED",
      payload: { error: "No output received before the stale threshold" },
      createdAt: ago(90),
    },
  });
  const stalledEvent = await prisma.activityEvent.create({
    data: {
      workspaceId: workspace.id,
      kind: EventKind.ISSUE_STALLED,
      actorAgentId: agent.id,
      subjectType: "issue",
      subjectId: ISSUE_IDS.stalled,
      payload: {
        issuePrefix: "FRG-9008",
        number: 9008,
        agentId: agent.id,
        agentProfileKey: agent.profileKey,
        idleMinutes: 90,
      },
      createdAt: ago(90),
    },
  });
  await prisma.notificationState.create({
    data: {
      workspaceId: workspace.id,
      userId: owner.id,
      eventId: stalledEvent.id,
      replacementKey: `issue:${ISSUE_IDS.stalled}:stalled`,
      severity: NotificationSeverity.WARNING,
      importance: 65,
      status: NotificationStatus.UNREAD,
      persistent: true,
      primaryHref: `/w/forge/issues/${ISSUE_IDS.stalled}`,
      detailHref: `/w/forge/issues/${ISSUE_IDS.stalled}?tab=activity`,
      summary: "FRG-9008 stalled",
      reason: "The assigned agent stopped emitting progress while the test runner was active.",
      recommendedAction: "Inspect the latest trace, then retry, reassign, or clear the failed run.",
      createdAt: ago(90),
    },
  });

  // Give every scenario at least one immutable activity marker so the default
  // issue rail explains how the current state was reached.
  await prisma.activityEvent.createMany({
    data: [
      {
        workspaceId: workspace.id,
        kind: EventKind.ISSUE_QUEUED,
        actorId: owner.id,
        subjectType: "issue",
        subjectId: ISSUE_IDS.queued,
        payload: { number: 9001 },
        createdAt: ago(24),
      },
      {
        workspaceId: workspace.id,
        kind: EventKind.AGENT_RUN_STARTED,
        actorAgentId: agent.id,
        subjectType: "issue",
        subjectId: ISSUE_IDS.active,
        payload: { runId: activeRun.id, number: 9003 },
        createdAt: ago(42),
      },
      {
        workspaceId: workspace.id,
        kind: EventKind.AGENT_RUN_BLOCKED,
        actorAgentId: agent.id,
        subjectType: "issue",
        subjectId: ISSUE_IDS.waiting,
        payload: { runId: waitingRun.id, reason: "Operator decision required", number: 9004 },
        createdAt: ago(8),
      },
      {
        workspaceId: workspace.id,
        kind: EventKind.AGENT_RUN_BLOCKED,
        actorAgentId: agent.id,
        subjectType: "issue",
        subjectId: ISSUE_IDS.approval,
        payload: { runId: approvalRun.id, reason: "Runtime approval required", number: 9005 },
        createdAt: ago(4),
      },
      {
        workspaceId: workspace.id,
        kind: EventKind.AGENT_RUN_COMPLETED,
        actorAgentId: agent.id,
        subjectType: "issue",
        subjectId: ISSUE_IDS.review,
        payload: { runId: reviewRun.id, number: 9006 },
        createdAt: ago(22),
      },
      {
        workspaceId: workspace.id,
        kind: EventKind.AGENT_RUN_COMPLETED,
        actorAgentId: agent.id,
        subjectType: "issue",
        subjectId: ISSUE_IDS.completed,
        payload: { runId: completedRun.id, number: 9007 },
        createdAt: ago(12),
      },
    ],
  });

  console.log("[lifecycle] Seeded FRG-9001…FRG-9008 lifecycle scenarios");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
