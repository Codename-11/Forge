import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, RelationKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

/**
 * Issue relations — directed, typed links between two issues.
 *
 * Reciprocal semantics:
 *   BLOCKS      ⇄ BLOCKED_BY   (maintained on both sides)
 *   DUPLICATES  → (unidirectional)
 *   RELATES_TO  → (unidirectional)
 *
 * We keep both rows explicit rather than inferring the opposite at query
 * time so that UI filters / counts stay symmetrical without a JOIN.
 */

function reciprocalKind(kind: RelationKind): RelationKind | null {
  if (kind === RelationKind.BLOCKS) return RelationKind.BLOCKED_BY;
  if (kind === RelationKind.BLOCKED_BY) return RelationKind.BLOCKS;
  return null;
}

export const addInput = z.object({
  fromIssueId: z.string().cuid(),
  toIssueId: z.string().cuid(),
  kind: z.nativeEnum(RelationKind),
});

export const removeInput = z.object({
  relationId: z.string().cuid(),
});

export const listForIssueInput = z.object({
  issueId: z.string().cuid(),
});

export const relationRouter = router({
  add: workspaceProcedure.input(addInput).mutation(async ({ ctx, input }) => {
    if (input.fromIssueId === input.toIssueId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot relate an issue to itself.",
      });
    }

    return ctx.db.$transaction(async (tx) => {
      // Both issues must live in the caller's workspace. We check both
      // explicitly because workspaceId isn't part of the IssueRelation
      // lookup path yet.
      const [from, to] = await Promise.all([
        tx.issue.findFirst({
          where: { id: input.fromIssueId, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        }),
        tx.issue.findFirst({
          where: { id: input.toIssueId, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        }),
      ]);
      if (!from || !to) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Both issues must belong to this workspace.",
        });
      }

      const existing = await tx.issueRelation.findUnique({
        where: {
          fromIssueId_toIssueId_kind: {
            fromIssueId: input.fromIssueId,
            toIssueId: input.toIssueId,
            kind: input.kind,
          },
        },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That relation already exists.",
        });
      }

      const primary = await tx.issueRelation.create({
        data: {
          workspaceId: ctx.workspaceId,
          fromIssueId: input.fromIssueId,
          toIssueId: input.toIssueId,
          kind: input.kind,
        },
      });

      const mirror = reciprocalKind(input.kind);
      let reciprocal: typeof primary | null = null;
      if (mirror) {
        // Upsert to tolerate a pre-existing mirror row from a prior ad-hoc
        // creation — keeps the invariant clean without surfacing noise.
        reciprocal = await tx.issueRelation.upsert({
          where: {
            fromIssueId_toIssueId_kind: {
              fromIssueId: input.toIssueId,
              toIssueId: input.fromIssueId,
              kind: mirror,
            },
          },
          create: {
            workspaceId: ctx.workspaceId,
            fromIssueId: input.toIssueId,
            toIssueId: input.fromIssueId,
            kind: mirror,
          },
          update: {},
        });
      }

      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        entity: "Issue",
        entityId: input.fromIssueId,
        action: "relation.add",
        after: primary,
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "issue",
        subjectId: input.fromIssueId,
        payload: {
          relationId: primary.id,
          kind: primary.kind,
          toIssueId: primary.toIssueId,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { relation: primary, reciprocal };
    });
  }),

  remove: workspaceProcedure.input(removeInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const relation = await tx.issueRelation.findFirst({
        where: { id: input.relationId, workspaceId: ctx.workspaceId },
      });
      if (!relation) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Relation not found." });
      }

      await tx.issueRelation.delete({ where: { id: relation.id } });

      const mirror = reciprocalKind(relation.kind);
      if (mirror) {
        await tx.issueRelation.deleteMany({
          where: {
            workspaceId: ctx.workspaceId,
            fromIssueId: relation.toIssueId,
            toIssueId: relation.fromIssueId,
            kind: mirror,
          },
        });
      }

      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        entity: "Issue",
        entityId: relation.fromIssueId,
        action: "relation.remove",
        before: relation,
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "issue",
        subjectId: relation.fromIssueId,
        payload: {
          relationId: relation.id,
          kind: relation.kind,
          toIssueId: relation.toIssueId,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { ok: true };
    });
  }),

  listForIssue: workspaceProcedure.input(listForIssueInput).query(async ({ ctx, input }) => {
    // Confirm scope before we read relation rows (which don't filter by
    // workspaceId in their unique index).
    const issue = await ctx.db.issue.findFirst({
      where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!issue) throw new TRPCError({ code: "NOT_FOUND" });

    // We only look at outgoing edges. BLOCKS/BLOCKED_BY already have a
    // mirror row on the other side (written in `add`), so every
    // reciprocal relationship is visible as an outgoing edge on *some*
    // issue — which avoids double-counting here.
    const rows = await ctx.db.issueRelation.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        fromIssueId: input.issueId,
      },
      include: {
        toIssue: {
          select: {
            id: true,
            number: true,
            title: true,
            statusId: true,
            status: { select: { category: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const grouped: Record<
      RelationKind,
      Array<{
        relationId: string;
        kind: RelationKind;
        target: { id: string; number: number; title: string; statusId: string; statusCategory: string };
      }>
    > = {
      [RelationKind.BLOCKS]: [],
      [RelationKind.BLOCKED_BY]: [],
      [RelationKind.DUPLICATES]: [],
      [RelationKind.RELATES_TO]: [],
    };

    for (const row of rows) {
      grouped[row.kind].push({
        relationId: row.id,
        kind: row.kind,
        target: {
          id: row.toIssue.id,
          number: row.toIssue.number,
          title: row.toIssue.title,
          statusId: row.toIssue.statusId,
          statusCategory: row.toIssue.status.category,
        },
      });
    }

    return grouped;
  }),
});
