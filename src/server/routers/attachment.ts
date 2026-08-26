import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind } from "@prisma/client";
import type { PrismaClient, Role } from "@prisma/client";
import {
  assertSafeExternalUrl,
  isSafeExternalUrl,
  safeExternalUrlMessage,
} from "@/lib/url-safety";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import {
  ALLOWED_MIME_TYPES,
  ALLOWED_TARGET_TYPES,
  MAX_FILE_SIZE_BYTES,
  StorageNotConfiguredError,
  createLinkAttachment,
  deleteAttachment,
  fetchLinkMetadata,
  finalizeAttachment,
  presignDownloadUrl,
  presignUploadUrl,
  workspaceQuotaStats,
} from "@/server/services/storage";
import { parseGitHubIssueOrPrRef } from "@/lib/github-ref";
import { linkGitHubUrlToIssue } from "@/server/services/github/resource-sync";
import {
  assertProjectAction,
  buildIssueAccessWhere,
} from "@/server/services/authorization";
import { artifactReadWhere } from "@/server/services/artifact-access";

/**
 * Map an exception from the storage layer onto a tRPC error. We use a
 * dedicated `PRECONDITION_FAILED` code for `StorageNotConfiguredError`
 * so callers (UI banner, MCP clients) can detect the misconfiguration
 * and surface an admin-friendly hint, rather than confusing it with a
 * one-off bad request. Anything else stays a `BAD_REQUEST` to preserve
 * existing behaviour.
 */
function mapStorageError(err: unknown): TRPCError {
  if (err instanceof StorageNotConfiguredError) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: err.message,
    });
  }
  return new TRPCError({
    code: "BAD_REQUEST",
    message: (err as Error).message,
  });
}

/**
 * Attachment router — polymorphic `targetType`/`targetId` refs, backed by
 * MinIO. Upload flow:
 *   1. `initUpload` -> presigned PUT URL + attachmentId
 *   2. client PUTs bytes directly to MinIO
 *   3. `finalize` confirms the object and flips the row from pending to ready
 *
 * All endpoints gate by `workspaceProcedure` so attachments can never cross
 * tenants.
 */

const targetTypeSchema = z
  .string()
  .min(1)
  .refine((v) => ALLOWED_TARGET_TYPES.has(v), {
    message: `targetType must be one of ${[...ALLOWED_TARGET_TYPES].join(", ")}`,
  });

const initUploadInput = z.object({
  targetType: targetTypeSchema,
  targetId: z.string().cuid(),
  filename: z.string().min(1).max(255),
  mimeType: z
    .string()
    .refine((v) => ALLOWED_MIME_TYPES.has(v), { message: "mimeType not allowed" }),
  size: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
});

const finalizeInput = z.object({
  attachmentId: z.string().cuid(),
});

const attachLinkInput = z.object({
  targetType: targetTypeSchema,
  targetId: z.string().cuid(),
  url: z.string().max(2048).refine(isSafeExternalUrl, {
    message: safeExternalUrlMessage(),
  }),
  title: z.string().max(255).optional(),
});

const listInput = z.object({
  targetType: targetTypeSchema,
  targetId: z.string().cuid(),
});

const byIdInput = z.object({
  attachmentId: z.string().cuid(),
});

export const attachmentRouter = router({
  /**
   * Kick off an upload. Validates the target exists in the current
   * workspace, then returns a short-lived presigned PUT URL.
   */
  initUpload: workspaceProcedure
    .input(initUploadInput)
    .mutation(async ({ ctx, input }) => {
      await assertTargetInWorkspace(ctx, input.targetType, input.targetId);
      try {
        const result = await presignUploadUrl({
          workspaceId: ctx.workspaceId,
          uploaderId: ctx.session.user.id,
          ...input,
        });
        return result;
      } catch (err) {
        throw mapStorageError(err);
      }
    }),

  /**
   * Confirm the object landed in S3 and promote the pending row to ready.
   * Emits an ISSUE_UPDATED activity event (the closest existing event kind)
   * so plugins can react without schema changes.
   */
  finalize: workspaceProcedure
    .input(finalizeInput)
    .mutation(async ({ ctx, input }) => {
      const pending = await ctx.db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
        select: { targetType: true, targetId: true },
      });
      if (!pending || !pending.targetType || !pending.targetId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Attachment not found." });
      }
      await assertTargetInWorkspace(ctx, pending.targetType, pending.targetId);
      let finalized: Awaited<ReturnType<typeof finalizeAttachment>>;
      try {
        finalized = await finalizeAttachment({
          attachmentId: input.attachmentId,
          workspaceId: ctx.workspaceId,
        });
      } catch (err) {
        throw mapStorageError(err);
      }
      if (finalized.targetType === "issue") {
        await ctx.db.$transaction(async (tx) => {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Attachment",
            entityId: finalized.id,
            action: "attach",
            after: finalized,
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: finalized.targetId,
            payload: {
              attachment: {
                id: finalized.id,
                filename: finalized.filename,
                mimeType: finalized.mimeType,
                size: finalized.size,
              },
              change: "added",
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        });
      }
      return finalized;
    }),

  /**
   * Attach an external link (Google Doc, Linear ticket, …)
   * as a first-class Attachment row. No bytes hit MinIO. Mirrors the
   * MCP `attachments.attachLink` tool — the storage helper enforces
   * the FILE-shaped column population (filename = title ?? hostname,
   * mimeType = "text/url", size = 0, url = externalUrl) so existing
   * list/preview consumers keep working without schema-aware code.
   */
  attachLink: workspaceProcedure
    .input(attachLinkInput)
    .mutation(async ({ ctx, input }) => {
      await assertTargetInWorkspace(ctx, input.targetType, input.targetId);
      const safeUrl = assertSafeExternalUrl(input.url);
      if (input.targetType === "issue" && parseGitHubIssueOrPrRef(safeUrl)) {
        const native = await linkGitHubUrlToIssue({
          db: ctx.db,
          workspaceId: ctx.workspaceId,
          issueId: input.targetId,
          url: safeUrl,
          kind: "RELATES_TO",
          preserveExistingRelation: true,
          actor: {
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
        return { id: native.link.id, routedTo: "github.link" as const, ...native };
      }
      // Caller didn't provide a label → try to scrape <title> off the
      // target page so the chip is meaningful. Fail soft: any error
      // leaves resolvedTitle null and createLinkAttachment falls back
      // to hostname.
      let resolvedTitle: string | null = input.title ?? null;
      if (resolvedTitle === null) {
        const meta = await fetchLinkMetadata(safeUrl);
        if (meta.title) resolvedTitle = meta.title;
      }
      let row: Awaited<ReturnType<typeof createLinkAttachment>>;
      try {
        row = await createLinkAttachment({
          workspaceId: ctx.workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          url: safeUrl,
          title: resolvedTitle,
        });
      } catch (err) {
        throw mapStorageError(err);
      }
      if (row.targetType === "issue") {
        await ctx.db.$transaction(async (tx) => {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Attachment",
            entityId: row.id,
            action: "attach",
            after: {
              id: row.id,
              workspaceId: row.workspaceId,
              targetType: row.targetType,
              targetId: row.targetId,
              filename: row.filename,
              mimeType: row.mimeType,
              size: row.size,
              url: row.url,
              externalUrl: row.externalUrl,
              linkTitle: row.linkTitle,
              kind: row.kind,
              createdAt: row.createdAt.toISOString(),
            },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: row.targetId,
            payload: {
              attachment: {
                id: row.id,
                filename: row.filename,
                mimeType: row.mimeType,
                size: row.size,
                kind: "LINK",
                externalUrl: row.externalUrl,
              },
              change: "added",
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        });
      }
      return row;
    }),

  /**
   * List attachments attached to a given target. Returns finalized FILE
   * rows AND LINK rows; LINK rows are distinguishable by
   * `mimeType === "text/url"` (or the new `kind` column once clients
   * select it).
   */
  list: workspaceProcedure.input(listInput).query(async ({ ctx, input }) => {
    await assertTargetInWorkspace(ctx, input.targetType, input.targetId);
    return ctx.db.attachment.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        targetType: input.targetType,
        targetId: input.targetId,
        NOT: { url: { startsWith: "pending:" } },
      },
      orderBy: { createdAt: "asc" },
    });
  }),

  /**
   * Admin-only roll-up used by the storage settings dashboard. Returns
   * quota stats plus every attachment (finalized only).
   */
  listForWorkspace: adminProcedure.query(async ({ ctx }) => {
    const [rows, quota] = await Promise.all([
      ctx.db.attachment.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          NOT: { url: { startsWith: "pending:" } },
        },
        orderBy: { createdAt: "desc" },
      }),
      workspaceQuotaStats(ctx.workspaceId),
    ]);
    return {
      attachments: rows,
      usedBytes: quota.usedBytes,
      quotaBytes: quota.quotaBytes,
    };
  }),

  /** Generate a presigned GET URL for an attachment. 15 min TTL. */
  getDownloadUrl: workspaceProcedure
    .input(byIdInput)
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!row.targetType || !row.targetId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Attachment has no target.",
        });
      }
      await assertTargetInWorkspace(ctx, row.targetType, row.targetId);
      try {
        return await presignDownloadUrl(input.attachmentId);
      } catch (err) {
        throw mapStorageError(err);
      }
    }),

  /** Delete an attachment. Admin or original uploader (if tracked). */
  delete: workspaceProcedure
    .input(byIdInput)
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      const isAdmin =
        ctx.membership.role === "OWNER" || ctx.membership.role === "ADMIN";
      if (!isAdmin) {
        // Attachment has no `uploaderId` column; fall back to admin-only for now.
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Admin role required to remove attachments.",
        });
      }
      try {
        await deleteAttachment(input.attachmentId);
      } catch (err) {
        throw mapStorageError(err);
      }
      const subjectId = row.targetId;
      if (row.targetType === "issue" && subjectId) {
        await ctx.db.$transaction(async (tx) => {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Attachment",
            entityId: row.id,
            action: "delete",
            before: {
              id: row.id,
              filename: row.filename,
              mimeType: row.mimeType,
              size: row.size,
            },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId,
            payload: {
              attachment: { id: row.id, filename: row.filename },
              change: "removed",
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        });
      }
      return { ok: true };
    }),
});

/**
 * Confirm the (targetType, targetId) pair references an actual row in the
 * caller's workspace. Keeps attachments from ever referencing foreign rows.
 */
async function assertTargetInWorkspace(
  ctx: {
    db: PrismaClient;
    workspaceId: string;
    session?: { user?: { id?: string | null } } | null;
    membership: { id: string; role: Role };
    apiKey?: { linkedAgentId?: string | null } | null;
  },
  targetType: string,
  targetId: string,
): Promise<void> {
  const { db, workspaceId } = ctx;
  const found = await (async () => {
    switch (targetType) {
      case "issue":
        return db.issue.findFirst({
          where: {
            id: targetId,
            ...buildIssueAccessWhere({
              workspaceId,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
              action: "READ",
            }),
          },
          select: { id: true },
        });
      case "comment":
        return db.comment.findFirst({
          where: { id: targetId, workspaceId, deletedAt: null },
          select: { id: true },
        });
      case "project":
        return assertProjectAction(db, {
          projectId: targetId,
          workspaceId,
          membershipId: ctx.membership.id,
          membershipRole: ctx.membership.role,
          action: "READ",
        }).then((decision) => ({ id: decision.project.id }));
      case "initiative":
        return db.initiative.findFirst({
          where: { id: targetId, workspaceId },
          select: { id: true },
        });
      case "cycle":
        return db.cycle.findFirst({
          where: { id: targetId, workspaceId },
          select: { id: true },
        });
      case "chat-message": {
        const message = await db.chatMessage.findFirst({
          where: { id: targetId, workspaceId },
          select: {
            id: true,
            thread: { select: { userId: true, agentId: true } },
          },
        });
        if (!message) return null;
        const sessionUserId = ctx.session?.user?.id ?? null;
        const linkedAgentId = ctx.apiKey?.linkedAgentId ?? null;
        const ownsThread = Boolean(sessionUserId && sessionUserId === message.thread.userId);
        const isThreadAgent = Boolean(linkedAgentId && linkedAgentId === message.thread.agentId);
        if (!ownsThread && !isThreadAgent) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the chat thread owner or linked agent may attach to this message.",
          });
        }
        return { id: message.id };
      }
      case "artifact":
        return db.artifact.findFirst({
          where: {
            id: targetId,
            archivedAt: null,
            ...artifactReadWhere({
              workspaceId,
              userId: ctx.session?.user?.id ?? "",
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
            }),
          },
          select: { id: true },
        });
      case "canvas": {
        const canvas = await db.workspaceCanvas.findFirst({
          where: { id: targetId, workspaceId, archivedAt: null },
          select: { id: true, scopeType: true, scopeId: true },
        });
        if (!canvas) return null;
        if (canvas.scopeType && canvas.scopeId) {
          await assertTargetInWorkspace(ctx, canvas.scopeType, canvas.scopeId);
        }
        return { id: canvas.id };
      }
      default:
        return null;
    }
  })();
  if (!found) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `${targetType} ${targetId} not in this workspace.`,
    });
  }
}
