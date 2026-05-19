import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ArtifactStatus, ArtifactType, Prisma } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
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
          limit: z.number().int().positive().max(100).default(50),
          cursor: z.string().optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.artifact.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          type: input.type,
          issueId: input.issueId,
          projectId: input.projectId,
          archivedAt: input.includeArchived ? undefined : null,
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
