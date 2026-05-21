import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ArtifactStatus, ArtifactType, EventKind } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import {
  archiveArtifact,
  createArtifact,
  promoteToArtifact,
  type ArtifactSourceType,
  updateArtifact,
} from "@/server/services/artifact-service";

/**
 * Artifact router — durable, versionable output objects (specs,
 * decisions, runbooks, reports, briefs, verification logs).
 *
 * All endpoints are workspace-scoped via `workspaceProcedure`. Writes
 * delegate to `artifact-service.ts` which handles the version snapshot
 * + AuditLog + ActivityEvent in one transaction.
 */

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes.");

const promoteSourceTypeSchema = z.enum([
  "chat-message",
  "comment",
  "note",
  "agent-run",
  "issue",
]);

const artifactSelect = {
  id: true,
  workspaceId: true,
  title: true,
  slug: true,
  type: true,
  status: true,
  body: true,
  summary: true,
  createdById: true,
  createdByAgentId: true,
  sourceType: true,
  sourceId: true,
  currentVersionId: true,
  issueId: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} as const satisfies Prisma.ArtifactSelect;

export const artifactRouter = router({
  /** List artifacts in this workspace. */
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(ArtifactStatus).optional(),
          type: z.nativeEnum(ArtifactType).optional(),
          issueId: z.string().cuid().optional(),
          projectId: z.string().cuid().optional(),
          /** When true, include archived rows (default: hide). */
          includeArchived: z.boolean().default(false),
          /** When true, return ONLY archived rows. Wins over includeArchived. */
          archivedOnly: z.boolean().default(false),
          limit: z.number().int().positive().max(100).default(50),
          cursor: z.string().optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const archivedFilter = input.archivedOnly
        ? { not: null }
        : input.includeArchived
          ? undefined
          : null;
      const rows = await ctx.db.artifact.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          type: input.type,
          issueId: input.issueId,
          projectId: input.projectId,
          archivedAt: archivedFilter,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: artifactSelect,
      });
      const nextCursor = rows.length > input.limit ? rows.pop()!.id : null;
      return { items: rows, nextCursor };
    }),

  /** Fetch one artifact by id with its latest 20 versions. */
  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.artifact.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: {
          ...artifactSelect,
          versions: {
            orderBy: { version: "desc" },
            take: 20,
            select: {
              id: true,
              version: true,
              title: true,
              summary: true,
              changelog: true,
              createdById: true,
              createdByAgentId: true,
              createdAt: true,
            },
          },
          createdBy: { select: { id: true, name: true, email: true, image: true } },
          createdByAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
        },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
      }
      return row;
    }),

  /**
   * Compact render payload for inline artifact embeds in the markdown
   * renderer (`:::artifact <id>` directive). Returns just enough for
   * the embed to decide how to render itself: kind ("markdown" | "image"
   * | "code" | "file"), title, type, status, body, and optional language
   * hint inferred from the first code fence.
   *
   * Lightweight on purpose — does not include version history or the
   * actor relations the artifact detail page needs.
   */
  getForRender: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.artifact.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          slug: true,
          title: true,
          type: true,
          status: true,
          body: true,
          summary: true,
          updatedAt: true,
        },
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Artifact not found.",
        });
      }
      const body = row.body ?? "";
      // Heuristic render-kind: an image-only body (single inline image
      // token) renders as a poster; a body that's *entirely* a single
      // fenced code block renders as code with the fence's language;
      // everything else falls back to markdown.
      const trimmed = body.trim();
      const imageOnly = /^!\[[^\]]*\]\((?:forge-attachment:[a-z0-9]{20,}|https?:\/\/[^\s)]+)\)$/i.test(
        trimmed,
      );
      const codeFenceMatch = trimmed.match(
        /^```([a-z0-9+#-]*)\s*\n([\s\S]*?)\n```$/i,
      );
      let renderKind: "image" | "code" | "markdown" = "markdown";
      let codeLang: string | null = null;
      let codeBody: string | null = null;
      if (imageOnly) {
        renderKind = "image";
      } else if (codeFenceMatch) {
        renderKind = "code";
        codeLang = (codeFenceMatch[1] || "").toLowerCase() || null;
        codeBody = codeFenceMatch[2] ?? "";
      }
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        type: row.type,
        status: row.status,
        summary: row.summary,
        body,
        updatedAt: row.updatedAt,
        renderKind,
        codeLang,
        codeBody,
      };
    }),

  /** Fetch by workspace + slug — useful for URLs. */
  getBySlug: workspaceProcedure
    .input(z.object({ slug: slugSchema }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.artifact.findFirst({
        where: { slug: input.slug, workspaceId: ctx.workspaceId },
        select: artifactSelect,
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
      }
      return row;
    }),

  /** List the version history of an artifact. */
  listVersions: workspaceProcedure
    .input(
      z.object({
        artifactId: z.string().cuid(),
        limit: z.number().int().positive().max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Confirm the artifact lives in this workspace first.
      const artifact = await ctx.db.artifact.findFirst({
        where: { id: input.artifactId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!artifact) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
      }
      const rows = await ctx.db.artifactVersion.findMany({
        where: { artifactId: input.artifactId, workspaceId: ctx.workspaceId },
        orderBy: { version: "desc" },
        take: input.limit,
        select: {
          id: true,
          version: true,
          title: true,
          body: true,
          summary: true,
          changelog: true,
          createdAt: true,
          createdById: true,
          createdByAgentId: true,
        },
      });
      return { items: rows };
    }),

  /** Create a fresh artifact. */
  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1).max(200),
        body: z.string().max(200_000).default(""),
        slug: slugSchema.optional(),
        type: z.nativeEnum(ArtifactType).default(ArtifactType.DOCUMENT),
        status: z.nativeEnum(ArtifactStatus).default(ArtifactStatus.DRAFT),
        summary: z.string().max(2_000).nullable().optional(),
        issueId: z.string().cuid().optional(),
        projectId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, slug } = await createArtifact(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        slug: input.slug,
        body: input.body,
        type: input.type,
        status: input.status,
        summary: input.summary ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
      });
      return { id, slug };
    }),

  /** Update an artifact in-place. Body edits append a new version row. */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(200_000).optional(),
        summary: z.string().max(2_000).nullable().optional(),
        type: z.nativeEnum(ArtifactType).optional(),
        status: z.nativeEnum(ArtifactStatus).optional(),
        changelog: z.string().max(1_000).optional(),
        publish: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await updateArtifact(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        artifactId: input.id,
        title: input.title,
        body: input.body,
        summary: input.summary === undefined ? undefined : input.summary,
        type: input.type,
        status: input.status,
        changelog: input.changelog,
        publish: input.publish,
      });
      return result;
    }),

  /** Soft-delete (archive) an artifact. */
  archive: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await archiveArtifact(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        artifactId: input.id,
      });
      return { ok: true };
    }),

  /** Clear `archivedAt`, restoring the artifact to its prior status. */
  restore: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.artifact.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, title: true, status: true, archivedAt: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
      }
      const archivedAt = existing.archivedAt;
      if (!archivedAt) return { ok: true };
      const nextStatus =
        existing.status === ArtifactStatus.ARCHIVED
          ? ArtifactStatus.DRAFT
          : existing.status;
      await ctx.db.$transaction(async (tx) => {
        await tx.artifact.update({
          where: { id: input.id },
          data: { archivedAt: null, status: nextStatus },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "artifact",
          entityId: input.id,
          action: "restore",
          before: {
            archivedAt: archivedAt.toISOString(),
            status: existing.status,
          } as Prisma.InputJsonValue,
          after: { archivedAt: null, status: nextStatus } as Prisma.InputJsonValue,
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: input.id,
          payload: { action: "restored", artifactTitle: existing.title } as Prisma.InputJsonValue,
        });
      });
      return { ok: true };
    }),

  /**
   * Clone an artifact into a new DRAFT row. Title defaults to
   * `Copy of <original>` unless `newTitle` is supplied; the body is
   * copied so version 1 of the new artifact matches the source's
   * current published body. Versions/attachments are NOT cloned in v1.
   */
  duplicate: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        newTitle: z.string().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const source = await ctx.db.artifact.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          title: true,
          body: true,
          type: true,
          summary: true,
          issueId: true,
          projectId: true,
        },
      });
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
      }
      const newTitle = input.newTitle?.trim() || `Copy of ${source.title}`;
      const { id, slug } = await createArtifact(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: newTitle,
        body: source.body,
        summary: source.summary,
        type: source.type,
        status: ArtifactStatus.DRAFT,
        issueId: source.issueId ?? null,
        projectId: source.projectId ?? null,
      });
      return { id, slug };
    }),

  /**
   * Hard-delete an artifact + all its versions. `confirm` must match
   * the artifact's current title (case-sensitive). Admin-only.
   */
  delete: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        confirm: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        ctx.membership.role !== "OWNER" &&
        ctx.membership.role !== "ADMIN"
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Admin role required to hard-delete an artifact.",
        });
      }
      const existing = await ctx.db.artifact.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, title: true, status: true, slug: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
      }
      if (input.confirm !== existing.title) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Confirmation text does not match the artifact title.",
        });
      }
      await ctx.db.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "artifact",
          entityId: existing.id,
          action: "delete",
          before: {
            title: existing.title,
            slug: existing.slug,
            status: existing.status,
          } as Prisma.InputJsonValue,
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: existing.id,
          payload: { action: "deleted", artifactTitle: existing.title } as Prisma.InputJsonValue,
        });
        // currentVersionId references a version row; clear it before
        // we drop the versions (no SetNull cycle handling needed since
        // both rows go away in the same txn).
        await tx.artifact.update({
          where: { id: existing.id },
          data: { currentVersionId: null },
        });
        await tx.artifactVersion.deleteMany({ where: { artifactId: existing.id } });
        await tx.artifact.delete({ where: { id: existing.id } });
      });
      return { ok: true };
    }),

  /** Promote a chat-message/comment/note/agent-run/issue into an Artifact. */
  promoteFromSource: workspaceProcedure
    .input(
      z.object({
        sourceType: promoteSourceTypeSchema,
        sourceId: z.string().cuid(),
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(200_000).optional(),
        summary: z.string().max(2_000).nullable().optional(),
        type: z.nativeEnum(ArtifactType).default(ArtifactType.DOCUMENT),
        issueId: z.string().cuid().optional(),
        projectId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, slug } = await promoteToArtifact(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        sourceType: input.sourceType as ArtifactSourceType,
        sourceId: input.sourceId,
        title: input.title,
        body: input.body,
        summary: input.summary ?? null,
        type: input.type,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
      });
      return { id, slug };
    }),
});
