import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ArtifactContentType,
  ArtifactStatus,
  ArtifactType,
  ArtifactVisibility,
  EventKind,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import {
  buildArtifactAssetManifest,
  checksumArtifactContent,
} from "@/server/services/artifact-studio";

const SLUG_MAX = 64;

type DbClient = Prisma.TransactionClient | PrismaClient;

/**
 * Build a deterministic slug for an artifact title. Lowercase
 * alphanumerics + dashes, max 64 chars, fallback `artifact` when the
 * title sanitises to empty. Same shape as initiative/project slugs.
 */
export function slugifyArtifactTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, SLUG_MAX) || "artifact"
  );
}

/**
 * Pick a slug that's unique within the workspace. Appends `-2`, `-3`,
 * … to the base slug until the unique index would accept it. Used by
 * artifact.create and by promotions where the caller didn't supply a
 * slug.
 */
export async function pickUniqueArtifactSlug(
  db: DbClient,
  workspaceId: string,
  candidate: string,
): Promise<string> {
  const base = slugifyArtifactTitle(candidate);
  let attempt = base;
  let n = 2;
  while (true) {
    const existing = await db.artifact.findFirst({
      where: { workspaceId, slug: attempt },
      select: { id: true },
    });
    if (!existing) return attempt;
    const suffix = `-${n}`;
    attempt = `${base.slice(0, SLUG_MAX - suffix.length)}${suffix}`;
    n += 1;
    if (n > 1000) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not allocate unique artifact slug after 1000 attempts.",
      });
    }
  }
}

export interface CreateArtifactInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  title: string;
  slug?: string;
  type?: ArtifactType;
  status?: ArtifactStatus;
  visibility?: ArtifactVisibility;
  contentType?: ArtifactContentType;
  body: string;
  summary?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  issueId?: string | null;
  projectId?: string | null;
}

/**
 * Create an Artifact + version 1 + audit/activity in a single
 * transaction. The created artifact's `currentVersionId` always points
 * at the seeded version row.
 *
 * Authorization is the caller's responsibility — this service trusts
 * that `workspaceId` has already been validated against the actor's
 * membership/api-key scope.
 */
export async function createArtifact(
  db: PrismaClient,
  input: CreateArtifactInput,
): Promise<{ id: string; slug: string }> {
  if (input.status === ArtifactStatus.ACCEPTED || input.status === ArtifactStatus.ARCHIVED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Create artifacts as a draft; use the review or archive workflow for lifecycle transitions.",
    });
  }
  const slug =
    input.slug?.toLowerCase().trim() ||
    (await pickUniqueArtifactSlug(db, input.workspaceId, input.title));

  // Validate the issue/project belong to this workspace if provided.
  if (input.issueId) {
    const issue = await db.issue.findFirst({
      where: { id: input.issueId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!issue) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Issue ${input.issueId} not in this workspace.`,
      });
    }
  }
  if (input.projectId) {
    const project = await db.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!project) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Project ${input.projectId} not in this workspace.`,
      });
    }
  }

  const assetManifest = await buildArtifactAssetManifest(db, input.workspaceId, input.body);
  const { id } = await db.$transaction(async (tx) => {
    const artifact = await tx.artifact.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title.trim(),
        slug,
        type: input.type ?? ArtifactType.DOCUMENT,
        status: input.status ?? ArtifactStatus.DRAFT,
        visibility: input.visibility ?? ArtifactVisibility.PRIVATE,
        body: input.body,
        summary: input.summary ?? null,
        createdById: input.actorId,
        createdByAgentId: input.actorAgentId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
      },
      select: { id: true, slug: true, title: true, type: true, status: true },
    });
    const version = await tx.artifactVersion.create({
      data: {
        workspaceId: input.workspaceId,
        artifactId: artifact.id,
        version: 1,
        title: artifact.title,
        body: input.body,
        summary: input.summary ?? null,
        changelog: "Initial version",
        contentType: input.contentType ?? ArtifactContentType.MARKDOWN,
        contentChecksum: checksumArtifactContent({
          title: artifact.title,
          body: input.body,
          summary: input.summary ?? null,
          contentType: input.contentType ?? ArtifactContentType.MARKDOWN,
        }),
        assetManifest,
        createdById: input.actorId,
        createdByAgentId: input.actorAgentId ?? null,
      },
      select: { id: true },
    });
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { currentVersionId: version.id },
    });
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorAgentId: input.actorAgentId ?? null,
      entity: "artifact",
      entityId: artifact.id,
      action: "created",
      after: {
        title: artifact.title,
        slug: artifact.slug,
        type: artifact.type,
        status: artifact.status,
      } as Prisma.InputJsonValue,
      // Reuse ISSUE_UPDATED for the activity stream until we ship a
      // dedicated ARTIFACT_* event family — keeps the activity feed
      // alive without a schema-blocking enum addition.
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "artifact",
      subjectId: artifact.id,
      payload: {
        artifactSlug: artifact.slug,
        artifactType: artifact.type,
        artifactStatus: artifact.status,
        action: "created",
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      } as Prisma.InputJsonValue,
    });
    return { id: artifact.id };
  });
  return { id, slug };
}

export interface UpdateArtifactInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  artifactId: string;
  title?: string;
  body?: string;
  summary?: string | null;
  type?: ArtifactType;
  status?: ArtifactStatus;
  changelog?: string;
  contentType?: ArtifactContentType;
  /** Optimistic-concurrency guard supplied by editors. */
  baseVersionId?: string | null;
  /** When set, the new revision records its restore provenance. */
  restoredFromVersionId?: string | null;
  /** When true, append a new ArtifactVersion row. Defaults true on body change. */
  publish?: boolean;
}

/**
 * Update an artifact. Title/summary/type/status edits are in-place;
 * any body change snapshots a new ArtifactVersion (unless
 * `publish: false`) and bumps `currentVersionId`.
 */
export async function updateArtifact(
  db: PrismaClient,
  input: UpdateArtifactInput,
): Promise<{ id: string; version: number }> {
  const existing = await db.artifact.findFirst({
    where: { id: input.artifactId, workspaceId: input.workspaceId, archivedAt: null },
    select: {
      id: true,
      title: true,
      body: true,
      summary: true,
      type: true,
      status: true,
      currentVersionId: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { version: true },
      },
    },
  });
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Artifact ${input.artifactId} not found in this workspace.`,
    });
  }
  if (input.status === ArtifactStatus.ACCEPTED || input.status === ArtifactStatus.ARCHIVED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        input.status === ArtifactStatus.ACCEPTED
          ? "Use acceptVersion to accept an immutable artifact version."
          : "Use the artifact archive operation.",
    });
  }
  if (input.baseVersionId !== undefined && input.baseVersionId !== existing.currentVersionId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A newer artifact version exists. Refresh before saving your changes.",
    });
  }
  const nextVersion = (existing.versions[0]?.version ?? 0) + 1;
  const bodyChanged = input.body !== undefined && input.body !== existing.body;
  const shouldPublish = bodyChanged && (input.publish ?? true);
  const assetManifest = shouldPublish
    ? await buildArtifactAssetManifest(db, input.workspaceId, input.body!)
    : undefined;
  return db.$transaction(async (tx) => {
    let newVersionId: string | null = null;
    if (shouldPublish) {
      const version = await tx.artifactVersion.create({
        data: {
          workspaceId: input.workspaceId,
          artifactId: input.artifactId,
          version: nextVersion,
          title: input.title ?? existing.title,
          body: input.body!,
          summary: input.summary ?? existing.summary,
          changelog: input.changelog ?? null,
          contentType: input.contentType ?? ArtifactContentType.MARKDOWN,
          contentChecksum: checksumArtifactContent({
            title: input.title ?? existing.title,
            body: input.body!,
            summary: input.summary === undefined ? existing.summary : input.summary,
            contentType: input.contentType ?? ArtifactContentType.MARKDOWN,
          }),
          restoredFromVersionId: input.restoredFromVersionId ?? null,
          assetManifest,
          createdById: input.actorId,
          createdByAgentId: input.actorAgentId ?? null,
        },
        select: { id: true },
      });
      newVersionId = version.id;
    }
    await tx.artifact.update({
      where: { id: input.artifactId },
      data: {
        title: input.title ?? undefined,
        body: bodyChanged ? input.body : undefined,
        summary: input.summary === undefined ? undefined : input.summary,
        type: input.type ?? undefined,
        status:
          input.status ??
          (bodyChanged && existing.status === ArtifactStatus.ACCEPTED
            ? ArtifactStatus.DRAFT
            : undefined),
        reviewRequestedAt:
          input.status === ArtifactStatus.IN_REVIEW
            ? new Date()
            : input.status === ArtifactStatus.DRAFT ||
                (bodyChanged && existing.status === ArtifactStatus.ACCEPTED)
              ? null
              : undefined,
        currentVersionId: newVersionId ?? undefined,
      },
    });
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorAgentId: input.actorAgentId ?? null,
      entity: "artifact",
      entityId: input.artifactId,
      action: "updated",
      before: {
        title: existing.title,
        status: existing.status,
        type: existing.type,
      } as Prisma.InputJsonValue,
      after: {
        title: input.title ?? existing.title,
        status: input.status ?? existing.status,
        type: input.type ?? existing.type,
      } as Prisma.InputJsonValue,
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "artifact",
      subjectId: input.artifactId,
      payload: {
        action: shouldPublish ? "version-published" : "metadata-updated",
        version: shouldPublish ? nextVersion : undefined,
      } as Prisma.InputJsonValue,
    });
    return {
      id: input.artifactId,
      version: shouldPublish ? nextVersion : (existing.versions[0]?.version ?? 1),
    };
  });
}

/** Restore a historical snapshot by creating a new head revision. */
export async function restoreArtifactVersion(
  db: PrismaClient,
  params: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    baseVersionId?: string | null;
  },
) {
  const version = await db.artifactVersion.findFirst({
    where: {
      id: params.versionId,
      artifactId: params.artifactId,
      workspaceId: params.workspaceId,
    },
    select: { id: true, version: true, title: true, body: true, summary: true, contentType: true },
  });
  if (!version) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Artifact version not found." });
  }
  return updateArtifact(db, {
    workspaceId: params.workspaceId,
    artifactId: params.artifactId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId,
    title: version.title,
    body: version.body,
    summary: version.summary,
    contentType: version.contentType,
    changelog: `Restored from v${version.version}`,
    baseVersionId: params.baseVersionId,
    restoredFromVersionId: version.id,
  });
}

/**
 * Archive an artifact. Soft-delete via `archivedAt`; the row stays so
 * canvas cards / context-set items can render the dead-ref placeholder
 * rather than disappearing silently.
 */
export async function archiveArtifact(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    artifactId: string;
  },
): Promise<void> {
  const existing = await db.artifact.findFirst({
    where: { id: params.artifactId, workspaceId: params.workspaceId },
    select: { id: true, archivedAt: true, status: true, title: true },
  });
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Artifact ${params.artifactId} not found in this workspace.`,
    });
  }
  if (existing.archivedAt) return;
  await db.$transaction(async (tx) => {
    await tx.artifact.update({
      where: { id: params.artifactId },
      data: { archivedAt: new Date(), status: ArtifactStatus.ARCHIVED },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      entity: "artifact",
      entityId: params.artifactId,
      action: "archived",
      before: { status: existing.status } as Prisma.InputJsonValue,
      after: { status: "ARCHIVED" } as Prisma.InputJsonValue,
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "artifact",
      subjectId: params.artifactId,
      payload: { action: "archived" } as Prisma.InputJsonValue,
    });
  });
}

/**
 * Promote a chat message / comment / note / agent-run summary into an
 * Artifact. Returns the new artifact id + slug. The source row is
 * preserved (no destructive promotion); the artifact carries the
 * `sourceType`/`sourceId` backlink so the UI can render provenance.
 *
 * `sourceType` is restricted to the set of polymorphic refs that
 * make sense as artifact provenance — adding a new one means adding
 * a hydration branch here.
 */
export type ArtifactSourceType = "chat-message" | "comment" | "note" | "agent-run" | "issue";

export async function promoteToArtifact(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    sourceType: ArtifactSourceType;
    sourceId: string;
    title?: string;
    body?: string;
    summary?: string | null;
    type?: ArtifactType;
    issueId?: string | null;
    projectId?: string | null;
  },
): Promise<{ id: string; slug: string }> {
  const fetched = await fetchSource(db, params.workspaceId, params.sourceType, params.sourceId);
  if (!fetched) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `${params.sourceType} ${params.sourceId} not in this workspace.`,
    });
  }
  return createArtifact(db, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId,
    title: params.title ?? fetched.title,
    body: params.body ?? fetched.body,
    summary: params.summary ?? fetched.summary,
    type: params.type,
    status: ArtifactStatus.DRAFT,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    issueId: params.issueId ?? fetched.issueId ?? null,
    projectId: params.projectId ?? null,
  });
}

async function fetchSource(
  db: PrismaClient,
  workspaceId: string,
  sourceType: ArtifactSourceType,
  sourceId: string,
): Promise<{ title: string; body: string; summary: string | null; issueId: string | null } | null> {
  switch (sourceType) {
    case "chat-message": {
      const row = await db.chatMessage.findFirst({
        where: { id: sourceId, workspaceId },
        select: { body: true, thread: { select: { title: true, topic: true } } },
      });
      if (!row) return null;
      const title =
        row.thread.title || row.thread.topic || row.body.slice(0, 60) || "Chat artifact";
      return { title, body: row.body, summary: null, issueId: null };
    }
    case "comment": {
      const row = await db.comment.findFirst({
        where: { id: sourceId, workspaceId, deletedAt: null },
        select: {
          body: true,
          issueId: true,
          issue: { select: { title: true } },
        },
      });
      if (!row) return null;
      return {
        // Comment.issue is nullable post-migration 0040 (step comments
        // have no parent issue). Promotion currently only flows from
        // issue-attached comments; keep the fallback in case a step
        // comment is ever promoted in the future.
        title: row.issue?.title ? `Re: ${row.issue.title}` : "Comment artifact",
        body: row.body,
        summary: null,
        issueId: row.issueId,
      };
    }
    case "note": {
      const row = await db.note.findFirst({
        where: { id: sourceId, workspaceId },
        select: { title: true, body: true },
      });
      if (!row) return null;
      return {
        title: row.title || row.body.slice(0, 60) || "Note artifact",
        body: row.body,
        summary: null,
        issueId: null,
      };
    }
    case "agent-run": {
      const row = await db.agentRun.findFirst({
        where: { id: sourceId, workspaceId },
        select: {
          summary: true,
          issueId: true,
          issue: { select: { title: true } },
        },
      });
      if (!row) return null;
      const body = row.summary ?? "(no summary)";
      return {
        title: row.issue.title ? `Run summary: ${row.issue.title}` : "Agent run summary",
        body,
        summary: row.summary,
        issueId: row.issueId,
      };
    }
    case "issue": {
      const row = await db.issue.findFirst({
        where: { id: sourceId, workspaceId, deletedAt: null },
        select: { title: true, description: true },
      });
      if (!row) return null;
      return {
        title: row.title,
        body: row.description ?? "",
        summary: null,
        issueId: sourceId,
      };
    }
    default: {
      const exhaustive: never = sourceType;
      void exhaustive;
      return null;
    }
  }
}
