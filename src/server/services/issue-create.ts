import "server-only";
import { TRPCError } from "@trpc/server";
import {
  DefaultIssueAssigneeMode,
  EventKind,
  Priority,
  WorkItemKind,
  type EngagementMode,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  maybeAutoDispatch,
  recordManualDispatchReason,
} from "@/server/services/dispatcher";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import {
  autoWatchActor,
  autoWatchUser,
  setIssueAgentWakeTarget,
} from "@/server/services/issue-watchers";
import { resolveEngagementMode } from "@/server/services/engagement-mode";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type CreateIssueWithSideEffectsInput = {
  title: string;
  description?: string | null;
  projectId?: string | null;
  parentId?: string | null;
  statusId?: string | null;
  priority?: Priority;
  kind?: WorkItemKind;
  assigneeIds?: string[];
  assignedAgentId?: string | null;
  claimedById?: string | null;
  labelIds?: string[];
  dueDate?: Date | null;
  estimate?: number | null;
  slaMinutes?: number | null;
  queued?: boolean;
  eventPayload?: Prisma.InputJsonObject;
};

export type CreateIssueWithSideEffectsArgs = {
  db: PrismaClient;
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  input: CreateIssueWithSideEffectsInput;
};

export type CreatedIssueWithSideEffects = Prisma.IssueGetPayload<{
  include: { status: true; assignees: true; labels: true };
}>;

function uniq(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

async function resolveAuthorId(
  tx: DbClient,
  workspaceId: string,
  actorId: string | null,
): Promise<string> {
  if (actorId) return actorId;
  const owner = await tx.membership.findFirst({
    where: { workspaceId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (!owner) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Workspace has no owner to attribute the issue to.",
    });
  }
  return owner.userId;
}

async function assertIdsCount(args: {
  found: number;
  expected: number;
  message: string;
}): Promise<void> {
  if (args.found !== args.expected) {
    throw new TRPCError({ code: "BAD_REQUEST", message: args.message });
  }
}

export async function resolveDefaultIssueAssigneeIds(
  tx: DbClient,
  args: {
    workspaceId: string;
    authorId: string;
    requestedAssigneeIds?: string[];
  },
): Promise<string[]> {
  const requested = uniq(args.requestedAssigneeIds);
  if (requested.length > 0) return requested;

  const workspace = await tx.workspace.findUnique({
    where: { id: args.workspaceId },
    select: {
      defaultIssueAssigneeMode: true,
      defaultIssueAssigneeUserId: true,
    },
  });
  if (!workspace || workspace.defaultIssueAssigneeMode === DefaultIssueAssigneeMode.NONE) {
    return [];
  }

  const candidateUserId =
    workspace.defaultIssueAssigneeMode === DefaultIssueAssigneeMode.CREATOR
      ? args.authorId
      : workspace.defaultIssueAssigneeUserId;
  if (!candidateUserId) return [];

  const membership = await tx.membership.findUnique({
    where: {
      userId_workspaceId: {
        userId: candidateUserId,
        workspaceId: args.workspaceId,
      },
    },
    select: { id: true },
  });
  return membership ? [candidateUserId] : [];
}

/**
 * Shared issue creation path for UI/API creates and external ingest/import.
 *
 * This preserves the invariant that new issues get the same default status,
 * audit/activity events, watcher rows, assignment dispatch metadata, optional
 * agent template application, and auto-dispatch behavior regardless of source.
 */
export async function createIssueWithSideEffects(
  args: CreateIssueWithSideEffectsArgs,
): Promise<CreatedIssueWithSideEffects> {
  const { db, workspaceId, actorId, actorAgentId = null, ip = null, userAgent = null } = args;
  const input = args.input;
  const requestedAssigneeIds = uniq(input.assigneeIds);
  const labelIds = uniq(input.labelIds);

  return db.$transaction(async (tx) => {
    const status = input.statusId
      ? await tx.status.findFirst({
          where: { id: input.statusId, workspaceId },
        })
      : await tx.status.findFirst({
          where: { workspaceId, isDefault: true },
        });
    if (!status) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: input.statusId
          ? "Status not found in this workspace."
          : "Workspace has no default status.",
      });
    }

    if (input.projectId) {
      const project = await tx.project.findFirst({
        where: { id: input.projectId, workspaceId, archived: false },
        select: { id: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project not found in this workspace.",
        });
      }
    }

    if (input.parentId) {
      const parent = await tx.issue.findFirst({
        where: { id: input.parentId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Parent issue not found in this workspace.",
        });
      }
    }

    if (labelIds.length > 0) {
      const count = await tx.label.count({
        where: { id: { in: labelIds }, workspaceId },
      });
      await assertIdsCount({
        found: count,
        expected: labelIds.length,
        message: "All labels must belong to this workspace.",
      });
    }

    if (input.claimedById) {
      const member = await tx.membership.findFirst({
        where: { workspaceId, userId: input.claimedById },
        select: { userId: true },
      });
      if (!member) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Claimed user must be a member of this workspace.",
        });
      }
    }

    let assignedAgentForCreate: {
      profileKey: string;
      engagementMode: EngagementMode | null;
    } | null = null;

    if (input.assignedAgentId) {
      const agent = await tx.agent.findFirst({
        where: { id: input.assignedAgentId, workspaceId },
        select: { profileKey: true, engagementMode: true },
      });
      if (!agent) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Agent not found in this workspace.",
        });
      }
      assignedAgentForCreate = agent;
    }

    const authorId = await resolveAuthorId(tx, workspaceId, actorId);
    const assigneeIds = await resolveDefaultIssueAssigneeIds(tx, {
      workspaceId,
      authorId,
      requestedAssigneeIds,
    });
    if (assigneeIds.length > 0) {
      const count = await tx.membership.count({
        where: { workspaceId, userId: { in: assigneeIds } },
      });
      await assertIdsCount({
        found: count,
        expected: assigneeIds.length,
        message: "All assignees must be members of this workspace.",
      });
    }

    const last = await tx.issue.findFirst({
      where: { workspaceId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;

    const issue = await tx.issue.create({
      data: {
        workspaceId,
        number,
        kind: input.kind ?? WorkItemKind.ISSUE,
        title: input.title,
        description: input.description ?? undefined,
        projectId: input.projectId ?? undefined,
        parentId: input.parentId ?? undefined,
        statusId: status.id,
        priority: input.priority ?? Priority.NONE,
        authorId,
        claimedById: input.claimedById ?? undefined,
        assignedAgentId: input.assignedAgentId ?? undefined,
        dueDate: input.dueDate ?? undefined,
        estimate: input.estimate ?? undefined,
        slaMinutes: input.slaMinutes ?? undefined,
        queued: input.queued ?? false,
        assignees: {
          create: assigneeIds.map((userId) => ({ userId })),
        },
        labels: {
          create: labelIds.map((labelId) => ({ labelId })),
        },
      },
      include: { status: true, assignees: true, labels: true },
    });

    await autoWatchActor(tx, {
      workspaceId,
      issueId: issue.id,
      userId: actorId,
      callerAgentId: actorAgentId,
    });
    for (const userId of assigneeIds) {
      await autoWatchUser(tx, { workspaceId, issueId: issue.id, userId });
    }
    if (input.assignedAgentId) {
      await setIssueAgentWakeTarget(tx, {
        workspaceId,
        issueId: issue.id,
        agentId: input.assignedAgentId,
      });
    }

    await recordChange(tx, {
      workspaceId,
      actorId,
      actorAgentId,
      entity: "Issue",
      entityId: issue.id,
      action: "create",
      after: issue,
      eventKind: EventKind.ISSUE_CREATED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        number: issue.number,
        title: issue.title,
        ...(input.eventPayload ?? {}),
      },
      ip,
      userAgent,
    });

    if (input.assignedAgentId) {
      const reasonBlob = await recordManualDispatchReason(tx, {
        issueId: issue.id,
        agentProfileKey: assignedAgentForCreate?.profileKey ?? input.assignedAgentId,
        actorId,
      });
      const ws = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: {
          assignmentEngagementMode: true,
          mentionEngagementPolicy: true,
          mentionDefaultMode: true,
        },
      });
      const engagementMode = resolveEngagementMode({
        surface: "assignment",
        explicit: null,
        workspace: {
          ...ws,
          assignmentAgentEngagementMode:
            assignedAgentForCreate?.engagementMode ?? null,
        },
      }).mode;
      await recordChange(tx, {
        workspaceId,
        actorId,
        actorAgentId,
        entity: "Issue",
        entityId: issue.id,
        action: "assign-agent",
        after: { assignedAgentId: input.assignedAgentId },
        eventKind: EventKind.AGENT_ASSIGNED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: {
          agentId: input.assignedAgentId,
          previousAgentId: null,
          dispatchReason: reasonBlob,
          engagementMode,
        },
        ip,
        userAgent,
      });
      await maybeApplyAgentTemplate(tx, issue.id, input.assignedAgentId);
    }

    await maybeAutoDispatch(tx, issue.id);
    return issue;
  });
}
