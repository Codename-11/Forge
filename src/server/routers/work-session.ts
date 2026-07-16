import { WorkSessionSource } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import {
  advanceWorkSession,
  attachPullRequest,
  claimWorkSession,
  listIssueWorkSessions,
  touchWorkSession,
} from "@/server/services/work-session";
import { handoffWorkSession, joinWorkSession } from "@/server/services/work-session-participant";

const repoSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/, "Repository must be owner/name.");
const branchSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9._/-]+$/, "Branch contains unsupported characters.");

async function assertSessionManager(
  ctx: {
    db: Parameters<typeof touchWorkSession>[0];
    workspaceId: string;
    membership: { role: string };
    session: { user: { id: string } };
  },
  sessionId: string,
  releaseAuthority = false,
) {
  const isAdmin = ctx.membership.role === "OWNER" || ctx.membership.role === "ADMIN";
  if (releaseAuthority && !isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workspace admin approval is required for release and deployment milestones.",
    });
  }
  const session = await ctx.db.workSession.findFirst({
    where: { id: sessionId, workspaceId: ctx.workspaceId },
    select: { ownerUserId: true },
  });
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Work session not found." });
  if (!isAdmin && session.ownerUserId !== ctx.session.user.id) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the work-session owner or a workspace admin can manage this session.",
    });
  }
}

export const workSessionRouter = router({
  active: workspaceProcedure.query(({ ctx }) =>
    ctx.db.workSession.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        status: { notIn: ["VERIFIED", "ABANDONED"] },
      },
      orderBy: [{ staleAt: "desc" }, { updatedAt: "desc" }],
      take: 20,
      include: {
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            status: { select: { name: true, category: true, color: true } },
            workspace: { select: { key: true, slug: true } },
          },
        },
        ownerUser: { select: { id: true, name: true, email: true, image: true } },
        ownerAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
        ownerConnection: {
          select: {
            id: true,
            kind: true,
            status: true,
            confidence: true,
            displayName: true,
            clientName: true,
            lastSeenAt: true,
            agent: { select: { id: true, name: true, profileKey: true } },
          },
        },
        pullRequest: {
          select: { number: true, repoFullName: true, url: true, state: true, metadata: true },
        },
      },
    }),
  ),

  listForIssue: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .query(({ ctx, input }) => listIssueWorkSessions(ctx.db, ctx.workspaceId, input.issueId)),

  join: workspaceProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        connectionId: z.string().cuid(),
        role: z.enum(["CONTRIBUTOR", "REVIEWER"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertSessionManager(ctx, input.sessionId);
      return joinWorkSession(ctx.db, {
        workspaceId: ctx.workspaceId,
        sessionId: input.sessionId,
        connectionId: input.connectionId,
        role: input.role,
        actor: { userId: ctx.session.user.id },
      });
    }),

  reconcileOwnership: adminProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        targetConnectionId: z.string().cuid(),
        reason: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handoffWorkSession(ctx.db, {
        workspaceId: ctx.workspaceId,
        sessionId: input.sessionId,
        toConnectionId: input.targetConnectionId,
        actor: { userId: ctx.session.user.id },
        reason: input.reason,
      }),
    ),

  claim: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        repoFullName: repoSchema,
        branch: branchSchema,
        baseBranch: branchSchema.default("main"),
        worktreePath: z.string().max(1_000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      claimWorkSession(ctx.db, {
        workspaceId: ctx.workspaceId,
        ...input,
        source: WorkSessionSource.MANUAL,
        actor: { userId: ctx.session.user.id, agentId: ctx.apiKey?.linkedAgentId ?? null },
      }),
    ),

  heartbeat: workspaceProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        headSha: z
          .string()
          .regex(/^[a-f0-9]{7,64}$/i)
          .nullable()
          .optional(),
        worktreePath: z.string().max(1_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertSessionManager(ctx, input.sessionId);
      return touchWorkSession(ctx.db, {
        workspaceId: ctx.workspaceId,
        ...input,
        actor: { userId: ctx.session.user.id, agentId: ctx.apiKey?.linkedAgentId ?? null },
      });
    }),

  attachPullRequest: workspaceProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        externalResourceId: z.string().cuid(),
        timelineUpdate: z.object({ body: z.string().trim().min(1).max(50_000) }).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertSessionManager(ctx, input.sessionId);
      return attachPullRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        ...input,
        actor: { userId: ctx.session.user.id, agentId: ctx.apiKey?.linkedAgentId ?? null },
      });
    }),

  advance: workspaceProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        status: z.enum(["RELEASED", "DEPLOYED", "VERIFIED", "ABANDONED"]),
        releasedVersion: z.string().max(80).nullable().optional(),
        deployedSha: z
          .string()
          .regex(/^[a-f0-9]{7,64}$/i)
          .nullable()
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertSessionManager(ctx, input.sessionId, input.status !== "ABANDONED");
      return advanceWorkSession(ctx.db, {
        workspaceId: ctx.workspaceId,
        ...input,
        actor: { userId: ctx.session.user.id, agentId: ctx.apiKey?.linkedAgentId ?? null },
      });
    }),
});
