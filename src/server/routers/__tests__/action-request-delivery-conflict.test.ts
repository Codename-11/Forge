import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ActionRequestKind,
  ActionRequestStatus,
  AgentConnectionKind,
  AgentConnectionLiveness,
  AgentRunStatus,
  EngagementMode,
  EventKind,
  WorkSessionParticipantRole,
  WorkSessionSource,
  WorkSessionStatus,
} from "@prisma/client";
import { actionRequestRouter } from "@/server/routers/action-request";
import { commandCenterRouter } from "@/server/routers/command-center";
import {
  createActionRequest,
  resolveDeliveryConnectionConflict,
  type DeliveryConflictDecision,
} from "@/server/services/action-request-service";
import { findBlockingDeliverySession } from "@/server/services/dispatch/run-dispatcher";
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

async function setupConflict(
  options: { attemptedMode?: "EXECUTE" | "REVIEW"; sessionOwnerUserId?: string | null } = {},
) {
  const fixture = await createWorkspaceFixture({ keyPrefix: "DC" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const issue = await createIssue(fixture, { title: "Delivery connection conflict" });
  const [ownerAgent, candidateAgent] = await Promise.all([
    prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Current delivery owner",
        profileKey: `owner-${issue.id}`,
      },
    }),
    prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Candidate runtime",
        profileKey: `candidate-${issue.id}`,
      },
    }),
  ]);
  const [ownerConnection, candidateConnection] = await Promise.all([
    prisma.agentConnection.create({
      data: {
        workspaceId: fixture.workspace.id,
        agentId: ownerAgent.id,
        kind: AgentConnectionKind.MCP_CLIENT,
        livenessModel: AgentConnectionLiveness.LEASE,
        instanceKey: `owner-${issue.id}`,
      },
    }),
    prisma.agentConnection.create({
      data: {
        workspaceId: fixture.workspace.id,
        agentId: candidateAgent.id,
        kind: AgentConnectionKind.MANAGED_RUNTIME,
        livenessModel: AgentConnectionLiveness.HEARTBEAT,
        instanceKey: `candidate-${issue.id}`,
      },
    }),
  ]);
  const session = await prisma.workSession.create({
    data: {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      ownerAgentId: ownerAgent.id,
      ownerUserId: options.sessionOwnerUserId ?? null,
      ownerConnectionId: ownerConnection.id,
      source: WorkSessionSource.MCP,
      status: WorkSessionStatus.IN_PROGRESS,
      repoFullName: `Codename-11/fixture-${issue.id}`,
      branch: `codex/${issue.id}-owner`,
      participants: {
        create: {
          workspaceId: fixture.workspace.id,
          connectionId: ownerConnection.id,
          agentId: ownerAgent.id,
          role: WorkSessionParticipantRole.PRIMARY,
        },
      },
    },
  });
  const trigger = await prisma.activityEvent.create({
    data: {
      workspaceId: fixture.workspace.id,
      kind: EventKind.AGENT_ASSIGNED,
      actorId: fixture.user.id,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        agentId: candidateAgent.id,
        engagementMode: options.attemptedMode ?? EngagementMode.EXECUTE,
      },
    },
  });
  const candidateRun = await prisma.agentRun.create({
    data: {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      agentId: candidateAgent.id,
      connectionId: candidateConnection.id,
      status: AgentRunStatus.WAITING,
      engagementMode: options.attemptedMode ?? EngagementMode.EXECUTE,
      triggerEventId: trigger.id,
      currentStep: "blocked by another primary delivery connection",
    },
  });
  const primaryRun = await prisma.agentRun.create({
    data: {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      agentId: ownerAgent.id,
      connectionId: ownerConnection.id,
      status: AgentRunStatus.ACTIVE,
      engagementMode: EngagementMode.EXECUTE,
      externalRunId: `primary-${issue.id}`,
      currentStep: "implementing",
    },
  });
  const payload = {
    version: 1 as const,
    workSessionId: session.id,
    expectedOwnerConnectionId: ownerConnection.id,
    candidateConnectionId: candidateConnection.id,
    queuedRunId: candidateRun.id,
    triggerEventId: trigger.id,
    attemptedMode: options.attemptedMode ?? ("EXECUTE" as const),
  };
  const request = await createActionRequest(prisma, {
    workspaceId: fixture.workspace.id,
    actorId: null,
    title: "Issue already has a primary delivery connection",
    kind: ActionRequestKind.DELIVERY_CONNECTION_CONFLICT,
    payload,
    assignedUserId: fixture.user.id,
    assignedAgentId: candidateAgent.id,
    sourceType: "work-session",
    sourceId: session.id,
    dedupeKey: `delivery-conflict:${session.id}:${candidateConnection.id}`,
    issueId: issue.id,
    systemOwned: true,
  });
  const caller = actionRequestRouter.createCaller(await buildContext(fixture));
  return {
    fixture,
    prisma,
    caller,
    issue,
    ownerAgent,
    candidateAgent,
    ownerConnection,
    candidateConnection,
    session,
    trigger,
    candidateRun,
    primaryRun,
    payload,
    request,
  };
}

describe("delivery connection conflict action requests", () => {
  it("rejects public and non-system creation of the reserved request kind", async () => {
    const state = await setupConflict();
    await expect(
      state.caller.create({
        title: "Forged conflict",
        kind: ActionRequestKind.DELIVERY_CONNECTION_CONFLICT,
        payload: state.payload,
        issueId: state.issue.id,
      }),
    ).rejects.toThrow(/only be created by Forge dispatch reconciliation/i);

    await expect(
      createActionRequest(state.prisma, {
        workspaceId: state.fixture.workspace.id,
        actorId: state.fixture.user.id,
        title: "Missing system authority",
        kind: ActionRequestKind.DELIVERY_CONNECTION_CONFLICT,
        payload: state.payload,
        issueId: state.issue.id,
      }),
    ).rejects.toThrow(/only be created by Forge dispatch reconciliation/i);
  });

  it("validates every payload reference against the request workspace", async () => {
    const state = await setupConflict();
    const other = await createWorkspaceFixture({ keyPrefix: "DX" });
    fixtures.push(other);
    const foreignAgent = await state.prisma.agent.create({
      data: {
        workspaceId: other.workspace.id,
        name: "Foreign candidate",
        profileKey: `foreign-${state.issue.id}`,
      },
    });
    const foreignConnection = await state.prisma.agentConnection.create({
      data: {
        workspaceId: other.workspace.id,
        agentId: foreignAgent.id,
        kind: AgentConnectionKind.MANAGED_RUNTIME,
        livenessModel: AgentConnectionLiveness.HEARTBEAT,
        instanceKey: `foreign-${state.issue.id}`,
      },
    });

    await expect(
      createActionRequest(state.prisma, {
        workspaceId: state.fixture.workspace.id,
        actorId: null,
        title: "Cross-tenant conflict",
        kind: ActionRequestKind.DELIVERY_CONNECTION_CONFLICT,
        payload: { ...state.payload, candidateConnectionId: foreignConnection.id },
        assignedUserId: state.fixture.user.id,
        issueId: state.issue.id,
        systemOwned: true,
      }),
    ).rejects.toThrow(/does not match a current queued run in this workspace/i);

    const foreignCaller = actionRequestRouter.createCaller(await buildContext(other));
    await expect(
      foreignCaller.resolveDeliveryConflict({
        id: state.request.id,
        decision: "CANCEL_DISPATCH",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it.each([
    ["JOIN_CONTRIBUTOR", WorkSessionParticipantRole.CONTRIBUTOR, EngagementMode.EXECUTE],
    ["JOIN_REVIEWER", WorkSessionParticipantRole.REVIEWER, EngagementMode.REVIEW],
  ] as const)(
    "applies %s atomically and resumes only the candidate run",
    async (decision, role, mode) => {
      const state = await setupConflict();
      const result = await state.caller.resolveDeliveryConflict({ id: state.request.id, decision });
      expect(result).toMatchObject({ decision, stale: false });

      const [request, participant, candidateRun, primaryRun, session] = await Promise.all([
        state.prisma.actionRequest.findUniqueOrThrow({ where: { id: state.request.id } }),
        state.prisma.workSessionParticipant.findUniqueOrThrow({
          where: {
            workSessionId_connectionId: {
              workSessionId: state.session.id,
              connectionId: state.candidateConnection.id,
            },
          },
        }),
        state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.candidateRun.id } }),
        state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.primaryRun.id } }),
        state.prisma.workSession.findUniqueOrThrow({ where: { id: state.session.id } }),
      ]);
      expect(request.status).toBe(ActionRequestStatus.RESOLVED);
      expect(participant.role).toBe(role);
      expect(candidateRun.status).toBe(AgentRunStatus.ACTIVE);
      expect(candidateRun.engagementMode).toBe(mode);
      expect(primaryRun.status).toBe(AgentRunStatus.ACTIVE);
      expect(session.ownerConnectionId).toBe(state.ownerConnection.id);
    },
  );

  it("hands off primary ownership and resumes the candidate run atomically", async () => {
    const state = await setupConflict();
    const result = await state.caller.resolveDeliveryConflict({
      id: state.request.id,
      decision: "HANDOFF_PRIMARY",
    });
    expect(result.stale).toBe(false);

    const [request, session, oldPrimary, newPrimary, candidateRun, primaryRun] = await Promise.all([
      state.prisma.actionRequest.findUniqueOrThrow({ where: { id: state.request.id } }),
      state.prisma.workSession.findUniqueOrThrow({ where: { id: state.session.id } }),
      state.prisma.workSessionParticipant.findUniqueOrThrow({
        where: {
          workSessionId_connectionId: {
            workSessionId: state.session.id,
            connectionId: state.ownerConnection.id,
          },
        },
      }),
      state.prisma.workSessionParticipant.findUniqueOrThrow({
        where: {
          workSessionId_connectionId: {
            workSessionId: state.session.id,
            connectionId: state.candidateConnection.id,
          },
        },
      }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.candidateRun.id } }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.primaryRun.id } }),
    ]);
    expect(request.status).toBe(ActionRequestStatus.RESOLVED);
    expect(session.ownerConnectionId).toBe(state.candidateConnection.id);
    expect(session.ownerAgentId).toBe(state.candidateAgent.id);
    expect(oldPrimary.leftAt).not.toBeNull();
    expect(newPrimary.role).toBe(WorkSessionParticipantRole.PRIMARY);
    expect(candidateRun.status).toBe(AgentRunStatus.ACTIVE);
    expect(primaryRun.status).toBe(AgentRunStatus.ACTIVE);
  });

  it("cancels only the parked dispatch and leaves the existing primary run active", async () => {
    const state = await setupConflict();
    const result = await state.caller.resolveDeliveryConflict({
      id: state.request.id,
      decision: "CANCEL_DISPATCH",
    });
    expect(result.stale).toBe(false);

    const [request, candidateRun, primaryRun, session] = await Promise.all([
      state.prisma.actionRequest.findUniqueOrThrow({ where: { id: state.request.id } }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.candidateRun.id } }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.primaryRun.id } }),
      state.prisma.workSession.findUniqueOrThrow({ where: { id: state.session.id } }),
    ]);
    expect(request.status).toBe(ActionRequestStatus.RESOLVED);
    expect(candidateRun.status).toBe(AgentRunStatus.ABANDONED);
    expect(primaryRun.status).toBe(AgentRunStatus.ACTIVE);
    expect(primaryRun.externalRunId).toBe(`primary-${state.issue.id}`);
    expect(session.ownerConnectionId).toBe(state.ownerConnection.id);
  });

  it("supersedes a stale decision without changing either run", async () => {
    const state = await setupConflict();
    const replacement = await state.prisma.agentConnection.create({
      data: {
        workspaceId: state.fixture.workspace.id,
        agentId: state.ownerAgent.id,
        kind: AgentConnectionKind.MCP_CLIENT,
        livenessModel: AgentConnectionLiveness.LEASE,
        instanceKey: `replacement-${state.issue.id}`,
      },
    });
    await state.prisma.workSession.update({
      where: { id: state.session.id },
      data: { ownerConnectionId: replacement.id },
    });

    const summary = await commandCenterRouter
      .createCaller(await buildContext(state.fixture))
      .summary({ dueWindowDays: 7, limit: 20 });
    const presented = summary.actionRequests.find((item) => item.id === state.request.id);
    expect(presented?.presentation.actions.map((action) => action.id)).toEqual([
      "DISMISS",
      "OPEN_ISSUE",
    ]);
    expect(presented?.presentation.details).toContainEqual({
      label: "Current state",
      value: "Primary delivery ownership changed after this request was created.",
    });

    const result = await resolveDeliveryConnectionConflict(state.prisma, {
      workspaceId: state.fixture.workspace.id,
      actorId: state.fixture.user.id,
      requestId: state.request.id,
      decision: "HANDOFF_PRIMARY" satisfies DeliveryConflictDecision,
    });
    expect(result.stale).toBe(true);

    const [request, session, candidateRun, primaryRun, participant] = await Promise.all([
      state.prisma.actionRequest.findUniqueOrThrow({ where: { id: state.request.id } }),
      state.prisma.workSession.findUniqueOrThrow({ where: { id: state.session.id } }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.candidateRun.id } }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.primaryRun.id } }),
      state.prisma.workSessionParticipant.findUnique({
        where: {
          workSessionId_connectionId: {
            workSessionId: state.session.id,
            connectionId: state.candidateConnection.id,
          },
        },
      }),
    ]);
    expect(request.status).toBe(ActionRequestStatus.SUPERSEDED);
    expect(session.ownerConnectionId).toBe(replacement.id);
    expect(candidateRun.status).toBe(AgentRunStatus.WAITING);
    expect(primaryRun.status).toBe(AgentRunStatus.ACTIVE);
    expect(participant).toBeNull();
  });

  it("preserves REVIEW when a review dispatch joins as reviewer", async () => {
    const state = await setupConflict({ attemptedMode: "REVIEW" });
    const result = await state.caller.resolveDeliveryConflict({
      id: state.request.id,
      decision: "JOIN_REVIEWER",
    });
    expect(result.stale).toBe(false);

    const [run, participant] = await Promise.all([
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.candidateRun.id } }),
      state.prisma.workSessionParticipant.findUniqueOrThrow({
        where: {
          workSessionId_connectionId: {
            workSessionId: state.session.id,
            connectionId: state.candidateConnection.id,
          },
        },
      }),
    ]);
    expect(run.status).toBe(AgentRunStatus.ACTIVE);
    expect(run.engagementMode).toBe(EngagementMode.REVIEW);
    expect(participant.role).toBe(WorkSessionParticipantRole.REVIEWER);
  });

  it("cannot escalate a REVIEW attempt into contributor execution or primary ownership", async () => {
    const state = await setupConflict({ attemptedMode: "REVIEW" });
    await expect(
      state.caller.resolveDeliveryConflict({
        id: state.request.id,
        decision: "JOIN_CONTRIBUTOR",
      }),
    ).rejects.toThrow(/review dispatch can only join as reviewer or be cancelled/i);
    await expect(
      state.caller.resolveDeliveryConflict({
        id: state.request.id,
        decision: "HANDOFF_PRIMARY",
      }),
    ).rejects.toThrow(/review dispatch can only join as reviewer or be cancelled/i);

    const [request, run, session, participant] = await Promise.all([
      state.prisma.actionRequest.findUniqueOrThrow({ where: { id: state.request.id } }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.candidateRun.id } }),
      state.prisma.workSession.findUniqueOrThrow({ where: { id: state.session.id } }),
      state.prisma.workSessionParticipant.findUnique({
        where: {
          workSessionId_connectionId: {
            workSessionId: state.session.id,
            connectionId: state.candidateConnection.id,
          },
        },
      }),
    ]);
    expect(request.status).toBe(ActionRequestStatus.OPEN);
    expect(run.status).toBe(AgentRunStatus.WAITING);
    expect(session.ownerConnectionId).toBe(state.ownerConnection.id);
    expect(participant).toBeNull();
  });

  it.each(["JOIN_CONTRIBUTOR", "JOIN_REVIEWER", "CANCEL_DISPATCH"] as const)(
    "allows a non-admin work-session owner to apply %s",
    async (decision) => {
      const state = await setupConflict();
      await state.prisma.workSession.update({
        where: { id: state.session.id },
        data: { ownerUserId: state.fixture.secondUser.id },
      });
      const ownerCaller = actionRequestRouter.createCaller(
        await buildContext(state.fixture, { asUserId: state.fixture.secondUser.id }),
      );
      await expect(
        ownerCaller.resolveDeliveryConflict({ id: state.request.id, decision }),
      ).resolves.toMatchObject({ stale: false, decision });
    },
  );

  it("requires workspace admin authority for primary handoff even from the session owner", async () => {
    const state = await setupConflict();
    await state.prisma.workSession.update({
      where: { id: state.session.id },
      data: { ownerUserId: state.fixture.secondUser.id },
    });
    const ownerCaller = actionRequestRouter.createCaller(
      await buildContext(state.fixture, { asUserId: state.fixture.secondUser.id }),
    );
    await expect(
      ownerCaller.resolveDeliveryConflict({
        id: state.request.id,
        decision: "HANDOFF_PRIMARY",
      }),
    ).rejects.toThrow(/admin authority is required/i);
  });

  it("does not grant delivery authority to an issue author or watcher alone", async () => {
    const state = await setupConflict();
    await Promise.all([
      state.prisma.issue.update({
        where: { id: state.issue.id },
        data: { authorId: state.fixture.secondUser.id },
      }),
      state.prisma.issueWatcher.create({
        data: {
          workspaceId: state.fixture.workspace.id,
          issueId: state.issue.id,
          userId: state.fixture.secondUser.id,
        },
      }),
    ]);
    const caller = actionRequestRouter.createCaller(
      await buildContext(state.fixture, { asUserId: state.fixture.secondUser.id }),
    );
    await expect(
      caller.resolveDeliveryConflict({
        id: state.request.id,
        decision: "CANCEL_DISPATCH",
      }),
    ).rejects.toThrow(/work-session owner or a workspace admin/i);

    const [request, run] = await Promise.all([
      state.prisma.actionRequest.findUniqueOrThrow({ where: { id: state.request.id } }),
      state.prisma.agentRun.findUniqueOrThrow({ where: { id: state.candidateRun.id } }),
    ]);
    expect(request.status).toBe(ActionRequestStatus.OPEN);
    expect(run.status).toBe(AgentRunStatus.WAITING);
  });
});

describe("delivery dispatch authorization", () => {
  it("allows the connection that already owns the active session", async () => {
    const state = await setupConflict();
    await expect(
      findBlockingDeliverySession({
        workspaceId: state.fixture.workspace.id,
        issueId: state.issue.id,
        candidateConnectionId: state.ownerConnection.id,
        engagementMode: "EXECUTE",
      }),
    ).resolves.toBeNull();
  });

  it("blocks a different connection with no participant authorization", async () => {
    const state = await setupConflict();
    await expect(
      findBlockingDeliverySession({
        workspaceId: state.fixture.workspace.id,
        issueId: state.issue.id,
        candidateConnectionId: state.candidateConnection.id,
        engagementMode: "EXECUTE",
      }),
    ).resolves.toMatchObject({
      id: state.session.id,
      ownerConnectionId: state.ownerConnection.id,
    });
  });

  it("allows an active contributor to execute", async () => {
    const state = await setupConflict();
    await state.prisma.workSessionParticipant.create({
      data: {
        workspaceId: state.fixture.workspace.id,
        workSessionId: state.session.id,
        connectionId: state.candidateConnection.id,
        agentId: state.candidateAgent.id,
        role: WorkSessionParticipantRole.CONTRIBUTOR,
      },
    });
    await expect(
      findBlockingDeliverySession({
        workspaceId: state.fixture.workspace.id,
        issueId: state.issue.id,
        candidateConnectionId: state.candidateConnection.id,
        engagementMode: "EXECUTE",
      }),
    ).resolves.toBeNull();
  });

  it("allows a reviewer to review but not execute", async () => {
    const state = await setupConflict();
    await state.prisma.workSessionParticipant.create({
      data: {
        workspaceId: state.fixture.workspace.id,
        workSessionId: state.session.id,
        connectionId: state.candidateConnection.id,
        agentId: state.candidateAgent.id,
        role: WorkSessionParticipantRole.REVIEWER,
      },
    });
    await expect(
      findBlockingDeliverySession({
        workspaceId: state.fixture.workspace.id,
        issueId: state.issue.id,
        candidateConnectionId: state.candidateConnection.id,
        engagementMode: "EXECUTE",
      }),
    ).resolves.toMatchObject({ id: state.session.id });
    await expect(
      findBlockingDeliverySession({
        workspaceId: state.fixture.workspace.id,
        issueId: state.issue.id,
        candidateConnectionId: state.candidateConnection.id,
        engagementMode: "REVIEW",
      }),
    ).resolves.toBeNull();
  });
});
