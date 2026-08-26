import { z } from "zod";
import { diffLines } from "diff";
import { TRPCError } from "@trpc/server";
import {
  ArtifactContentType,
  ArtifactPublicationAudience,
  ArtifactRole,
  ArtifactStatus,
  ArtifactType,
  ArtifactVisibility,
  EventKind,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import {
  archiveArtifact,
  createArtifact,
  promoteToArtifact,
  restoreArtifactVersion,
  type ArtifactSourceType,
  updateArtifact,
} from "@/server/services/artifact-service";
import { artifactReadWhere, assertArtifactRole } from "@/server/services/artifact-access";
import {
  acceptArtifactVersion,
  deployArtifactPreview,
  publishArtifactVersion,
  requestArtifactReview,
  requestArtifactChanges,
  revokeArtifactPublication,
} from "@/server/services/artifact-studio";

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

const promoteSourceTypeSchema = z.enum(["chat-message", "comment", "note", "agent-run", "issue"]);

const artifactSelect = {
  id: true,
  workspaceId: true,
  title: true,
  slug: true,
  type: true,
  status: true,
  visibility: true,
  body: true,
  summary: true,
  createdById: true,
  createdByAgentId: true,
  sourceType: true,
  sourceId: true,
  currentVersionId: true,
  acceptedVersionId: true,
  publishedVersionId: true,
  reviewRequestedAt: true,
  acceptedAt: true,
  acceptedById: true,
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
          search: z.string().trim().max(200).optional(),
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
          AND: [
            artifactReadWhere({
              workspaceId: ctx.workspaceId,
              userId: ctx.session.user.id,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
            }),
            {
              status: input.status,
              type: input.type,
              issueId: input.issueId,
              projectId: input.projectId,
              OR: input.search
                ? [
                    { title: { contains: input.search, mode: "insensitive" } },
                    { summary: { contains: input.search, mode: "insensitive" } },
                    { body: { contains: input.search, mode: "insensitive" } },
                  ]
                : undefined,
              archivedAt: archivedFilter,
            },
          ],
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
        where: {
          AND: [
            { id: input.id },
            artifactReadWhere({
              workspaceId: ctx.workspaceId,
              userId: ctx.session.user.id,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
            }),
          ],
        },
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
              contentType: true,
              contentChecksum: true,
              restoredFromVersionId: true,
              createdById: true,
              createdByAgentId: true,
              createdAt: true,
            },
          },
          createdBy: { select: { id: true, name: true, email: true, image: true } },
          createdByAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
          acceptedBy: { select: { id: true, name: true, image: true } },
          publications: {
            orderBy: { createdAt: "desc" },
            take: 20,
            select: {
              id: true,
              versionId: true,
              audience: true,
              status: true,
              tokenPrefix: true,
              expiresAt: true,
              revokedAt: true,
              createdAt: true,
            },
          },
          deployments: {
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
              id: true,
              versionId: true,
              provider: true,
              status: true,
              externalUrl: true,
              errorMessage: true,
              createdAt: true,
              deployedAt: true,
            },
          },
          grants: {
            where: { userId: ctx.session.user.id },
            select: { role: true },
            take: 1,
          },
        },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
      }
      const effectiveRole: ArtifactRole =
        ctx.membership.role === "OWNER" ||
        ctx.membership.role === "ADMIN" ||
        row.createdById === ctx.session.user.id
          ? ArtifactRole.OWNER
          : (row.grants[0]?.role ?? ArtifactRole.COMMENTER);
      const { grants: _grants, ...artifact } = row;
      return { ...artifact, effectiveRole };
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
        where: {
          AND: [
            { id: input.id },
            artifactReadWhere({
              workspaceId: ctx.workspaceId,
              userId: ctx.session.user.id,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
            }),
          ],
        },
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
      const imageOnly =
        /^!\[[^\]]*\]\((?:forge-attachment:[a-z0-9]{20,}|https?:\/\/[^\s)]+)\)$/i.test(trimmed);
      const codeFenceMatch = trimmed.match(/^```([a-z0-9+#-]*)\s*\n([\s\S]*?)\n```$/i);
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
        where: {
          AND: [
            { slug: input.slug },
            artifactReadWhere({
              workspaceId: ctx.workspaceId,
              userId: ctx.session.user.id,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
            }),
          ],
        },
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
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.VIEWER,
      });
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
          contentType: true,
          contentChecksum: true,
          restoredFromVersionId: true,
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
        visibility: z.nativeEnum(ArtifactVisibility).default(ArtifactVisibility.PRIVATE),
        contentType: z.nativeEnum(ArtifactContentType).default(ArtifactContentType.MARKDOWN),
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
        visibility: input.visibility,
        contentType: input.contentType,
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
        contentType: z.nativeEnum(ArtifactContentType).optional(),
        baseVersionId: z.string().cuid().nullable().optional(),
        publish: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.EDITOR,
      });
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
        contentType: input.contentType,
        baseVersionId: input.baseVersionId,
        publish: input.publish,
      });
      return result;
    }),

  /** Soft-delete (archive) an artifact. */
  archive: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.EDITOR,
      });
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
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.EDITOR,
      });
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
        existing.status === ArtifactStatus.ARCHIVED ? ArtifactStatus.DRAFT : existing.status;
      await ctx.db.$transaction(async (tx) => {
        await tx.artifact.update({
          where: { id: input.id },
          data: { archivedAt: null, status: nextStatus },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.VIEWER,
      });
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
      if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
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
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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
          data: { currentVersionId: null, acceptedVersionId: null, publishedVersionId: null },
        });
        await tx.artifactDeployment.deleteMany({ where: { artifactId: existing.id } });
        await tx.artifactPublication.deleteMany({ where: { artifactId: existing.id } });
        await tx.artifactComment.deleteMany({ where: { artifactId: existing.id } });
        await tx.artifactVersion.deleteMany({ where: { artifactId: existing.id } });
        await tx.artifact.delete({ where: { id: existing.id } });
      });
      return { ok: true };
    }),

  getVersion: workspaceProcedure
    .input(z.object({ artifactId: z.string().cuid(), versionId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.VIEWER,
      });
      const version = await ctx.db.artifactVersion.findFirst({
        where: { id: input.versionId, artifactId: input.artifactId, workspaceId: ctx.workspaceId },
      });
      if (!version)
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact version not found." });
      return version;
    }),

  compareVersions: workspaceProcedure
    .input(
      z.object({
        artifactId: z.string().cuid(),
        fromVersionId: z.string().cuid(),
        toVersionId: z.string().cuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.VIEWER,
      });
      const versions = await ctx.db.artifactVersion.findMany({
        where: {
          artifactId: input.artifactId,
          workspaceId: ctx.workspaceId,
          id: { in: [input.fromVersionId, input.toVersionId] },
        },
        select: {
          id: true,
          version: true,
          title: true,
          body: true,
          contentType: true,
          contentChecksum: true,
          createdAt: true,
        },
      });
      const from = versions.find((version) => version.id === input.fromVersionId);
      const to = versions.find((version) => version.id === input.toVersionId);
      if (!from || !to)
        throw new TRPCError({ code: "NOT_FOUND", message: "Artifact version not found." });
      const textTypes = new Set<ArtifactContentType>([
        ArtifactContentType.MARKDOWN,
        ArtifactContentType.TEXT,
        ArtifactContentType.CODE,
        ArtifactContentType.HTML,
      ]);
      if (!textTypes.has(from.contentType) || !textTypes.has(to.contentType)) {
        return { kind: "metadata" as const, from, to, changes: [] };
      }
      const changes = diffLines(from.body, to.body, { newlineIsToken: true }).map((part) => ({
        value: part.value,
        added: part.added ?? false,
        removed: part.removed ?? false,
        count: part.count ?? 0,
      }));
      return {
        kind: "text" as const,
        from: { ...from, body: undefined },
        to: { ...to, body: undefined },
        changes,
      };
    }),

  exportVersion: workspaceProcedure
    .input(
      z.object({
        artifactId: z.string().cuid(),
        versionId: z.string().cuid(),
        format: z.enum(["markdown", "html"]).default("markdown"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.VIEWER,
      });
      return ctx.db.$transaction(async (tx) => {
        const version = await tx.artifactVersion.findFirst({
          where: {
            id: input.versionId,
            artifactId: input.artifactId,
            workspaceId: ctx.workspaceId,
          },
          select: {
            id: true,
            version: true,
            title: true,
            body: true,
            contentChecksum: true,
            artifact: { select: { slug: true } },
          },
        });
        if (!version)
          throw new TRPCError({ code: "NOT_FOUND", message: "Artifact version not found." });
        const safeTitle = version.title.replace(
          /[&<>"']/g,
          (char) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
        );
        const content =
          input.format === "markdown"
            ? `---\ntitle: ${JSON.stringify(version.title)}\nversion: ${version.version}\nchecksum: ${version.contentChecksum ?? "unknown"}\n---\n\n${version.body}`
            : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>body{max-width:860px;margin:48px auto;padding:0 24px;font:16px/1.65 system-ui;background:#f4efe6;color:#292724}pre{white-space:pre-wrap}</style></head><body><h1>${safeTitle}</h1><pre id="content"></pre><script>document.getElementById("content").textContent=${JSON.stringify(version.body).replace(/</g, "\\u003c")}</script></body></html>`;
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "artifact",
          entityId: input.artifactId,
          action: "version-exported",
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: input.artifactId,
          payload: { action: "version-exported", versionId: version.id, format: input.format },
        });
        return {
          filename: `${version.artifact.slug}-v${version.version}.${input.format === "markdown" ? "md" : "html"}`,
          mimeType:
            input.format === "markdown" ? "text/markdown;charset=utf-8" : "text/html;charset=utf-8",
          content,
        };
      });
    }),

  restoreVersion: workspaceProcedure
    .input(
      z.object({
        artifactId: z.string().cuid(),
        versionId: z.string().cuid(),
        baseVersionId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.EDITOR,
      });
      return restoreArtifactVersion(ctx.db, {
        workspaceId: ctx.workspaceId,
        artifactId: input.artifactId,
        versionId: input.versionId,
        baseVersionId: input.baseVersionId,
        actorId: ctx.session.user.id,
      });
    }),

  setVisibility: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), visibility: z.nativeEnum(ArtifactVisibility) }))
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      return ctx.db.$transaction(async (tx) => {
        const existing = await tx.artifact.findUniqueOrThrow({
          where: { id: input.id },
          select: { visibility: true },
        });
        const artifact = await tx.artifact.update({
          where: { id: input.id },
          data: { visibility: input.visibility },
          select: { id: true, visibility: true },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "artifact",
          entityId: input.id,
          action: "visibility-updated",
          before: { visibility: existing.visibility },
          after: { visibility: input.visibility },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: input.id,
          payload: { action: "visibility-updated", visibility: input.visibility },
        });
        return artifact;
      });
    }),

  requestReview: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.EDITOR,
      });
      return requestArtifactReview(ctx.db, {
        workspaceId: ctx.workspaceId,
        artifactId: input.id,
        actorId: ctx.session.user.id,
      });
    }),

  acceptVersion: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), versionId: z.string().cuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      return acceptArtifactVersion(ctx.db, {
        workspaceId: ctx.workspaceId,
        artifactId: input.id,
        versionId: input.versionId,
        actorId: ctx.session.user.id,
      });
    }),

  requestChanges: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      return requestArtifactChanges(ctx.db, {
        workspaceId: ctx.workspaceId,
        artifactId: input.id,
        actorId: ctx.session.user.id,
      });
    }),

  publishVersion: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        versionId: z.string().cuid().optional(),
        audience: z
          .nativeEnum(ArtifactPublicationAudience)
          .default(ArtifactPublicationAudience.LINK),
        expiresAt: z.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      const workspace = await ctx.db.workspace.findUnique({
        where: { id: ctx.workspaceId },
        select: { artifactExternalSharingEnabled: true, artifactDefaultLinkExpiryDays: true },
      });
      if (
        input.audience === ArtifactPublicationAudience.LINK &&
        !workspace?.artifactExternalSharingEnabled
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "External artifact sharing is disabled in workspace settings.",
        });
      }
      const expiresAt =
        input.expiresAt === undefined && input.audience === ArtifactPublicationAudience.LINK
          ? new Date(Date.now() + (workspace?.artifactDefaultLinkExpiryDays ?? 7) * 86_400_000)
          : input.expiresAt;
      return publishArtifactVersion(ctx.db, {
        workspaceId: ctx.workspaceId,
        artifactId: input.id,
        versionId: input.versionId,
        audience: input.audience,
        expiresAt,
        actorId: ctx.session.user.id,
      });
    }),

  revokePublication: workspaceProcedure
    .input(z.object({ artifactId: z.string().cuid(), publicationId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      return revokeArtifactPublication(ctx.db, {
        workspaceId: ctx.workspaceId,
        publicationId: input.publicationId,
        actorId: ctx.session.user.id,
      });
    }),

  deployPreview: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        versionId: z.string().cuid(),
        publicationId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.id,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      return deployArtifactPreview(ctx.db, {
        workspaceId: ctx.workspaceId,
        artifactId: input.id,
        versionId: input.versionId,
        publicationId: input.publicationId,
        actorId: ctx.session.user.id,
      });
    }),

  listComments: workspaceProcedure
    .input(
      z.object({
        artifactId: z.string().cuid(),
        versionId: z.string().cuid().optional(),
        includeResolved: z.boolean().default(true),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.VIEWER,
      });
      return ctx.db.artifactComment.findMany({
        where: {
          artifactId: input.artifactId,
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          versionId: input.versionId,
          status: input.includeResolved ? undefined : "OPEN",
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          versionId: true,
          parentId: true,
          body: true,
          status: true,
          anchor: true,
          quotedText: true,
          resolvedAt: true,
          createdAt: true,
          updatedAt: true,
          author: { select: { id: true, name: true, image: true } },
          authoringAgent: { select: { id: true, name: true, avatar: true, profileKey: true } },
        },
      });
    }),

  addComment: workspaceProcedure
    .input(
      z.object({
        artifactId: z.string().cuid(),
        versionId: z.string().cuid().optional(),
        parentId: z.string().cuid().optional(),
        body: z.string().trim().min(1).max(20_000),
        anchor: z.unknown().optional(),
        quotedText: z.string().max(2_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.COMMENTER,
      });
      if (input.versionId) {
        const version = await ctx.db.artifactVersion.findFirst({
          where: {
            id: input.versionId,
            artifactId: input.artifactId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!version)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Version does not belong to this artifact.",
          });
      }
      return ctx.db.$transaction(async (tx) => {
        const comment = await tx.artifactComment.create({
          data: {
            workspaceId: ctx.workspaceId,
            artifactId: input.artifactId,
            versionId: input.versionId ?? null,
            parentId: input.parentId ?? null,
            authorId: ctx.session.user.id,
            body: input.body,
            anchor: input.anchor as Prisma.InputJsonValue | undefined,
            quotedText: input.quotedText ?? null,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "artifactComment",
          entityId: comment.id,
          action: "created",
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: input.artifactId,
          payload: {
            action: "comment-added",
            artifactId: input.artifactId,
            versionId: input.versionId ?? null,
          },
        });
        return comment;
      });
    }),

  resolveComment: workspaceProcedure
    .input(
      z.object({
        artifactId: z.string().cuid(),
        commentId: z.string().cuid(),
        resolved: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.EDITOR,
      });
      return ctx.db.$transaction(async (tx) => {
        const comment = await tx.artifactComment.updateMany({
          where: {
            id: input.commentId,
            artifactId: input.artifactId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          data: input.resolved
            ? { status: "RESOLVED", resolvedAt: new Date(), resolvedById: ctx.session.user.id }
            : { status: "OPEN", resolvedAt: null, resolvedById: null },
        });
        if (comment.count === 0)
          throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found." });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "artifactComment",
          entityId: input.commentId,
          action: input.resolved ? "resolved" : "reopened",
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: input.artifactId,
          payload: { action: input.resolved ? "comment-resolved" : "comment-reopened" },
        });
        return { ok: true };
      });
    }),

  listGrants: workspaceProcedure
    .input(z.object({ artifactId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      return ctx.db.artifactGrant.findMany({
        where: { artifactId: input.artifactId, workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "asc" },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
          agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
        },
      });
    }),

  setGrant: workspaceProcedure
    .input(
      z
        .object({
          artifactId: z.string().cuid(),
          userId: z.string().cuid().optional(),
          agentId: z.string().cuid().optional(),
          role: z.nativeEnum(ArtifactRole),
        })
        .refine(
          (value) => Boolean(value.userId) !== Boolean(value.agentId),
          "Choose exactly one user or agent.",
        ),
    )
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      if (input.userId) {
        const member = await ctx.db.membership.findUnique({
          where: { userId_workspaceId: { userId: input.userId, workspaceId: ctx.workspaceId } },
          select: { id: true },
        });
        if (!member)
          throw new TRPCError({ code: "BAD_REQUEST", message: "User is not a workspace member." });
      }
      if (input.agentId) {
        const agent = await ctx.db.agent.findFirst({
          where: { id: input.agentId, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (!agent)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Agent is not in this workspace." });
      }
      return ctx.db.$transaction(async (tx) => {
        const grant = input.userId
          ? await tx.artifactGrant.upsert({
              where: { artifactId_userId: { artifactId: input.artifactId, userId: input.userId } },
              create: {
                workspaceId: ctx.workspaceId,
                artifactId: input.artifactId,
                userId: input.userId,
                role: input.role,
              },
              update: { role: input.role },
            })
          : await tx.artifactGrant.upsert({
              where: {
                artifactId_agentId: { artifactId: input.artifactId, agentId: input.agentId! },
              },
              create: {
                workspaceId: ctx.workspaceId,
                artifactId: input.artifactId,
                agentId: input.agentId!,
                role: input.role,
              },
              update: { role: input.role },
            });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "artifactGrant",
          entityId: grant.id,
          action: "upserted",
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: input.artifactId,
          payload: {
            action: "grant-upserted",
            role: input.role,
            principalId: input.userId ?? input.agentId!,
          },
        });
        return grant;
      });
    }),

  removeGrant: workspaceProcedure
    .input(z.object({ artifactId: z.string().cuid(), grantId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertArtifactRole(ctx.db, {
        artifactId: input.artifactId,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        minimum: ArtifactRole.OWNER,
      });
      return ctx.db.$transaction(async (tx) => {
        const result = await tx.artifactGrant.deleteMany({
          where: { id: input.grantId, artifactId: input.artifactId, workspaceId: ctx.workspaceId },
        });
        if (!result.count) throw new TRPCError({ code: "NOT_FOUND", message: "Grant not found." });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "artifactGrant",
          entityId: input.grantId,
          action: "removed",
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "artifact",
          subjectId: input.artifactId,
          payload: { action: "grant-removed" },
        });
        return { ok: true };
      });
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
