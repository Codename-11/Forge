import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { ArtifactContentType, Prisma, PrismaClient } from "@prisma/client";
import {
  ArtifactDeploymentStatus,
  ArtifactPublicationAudience,
  ArtifactPublicationStatus,
  ArtifactStatus,
  EventKind,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";

type DbClient = Prisma.TransactionClient | PrismaClient;

export function checksumArtifactContent(input: {
  title: string;
  body: string;
  summary: string | null;
  contentType: ArtifactContentType;
  rendererVersion?: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: input.title,
        body: input.body,
        summary: input.summary,
        contentType: input.contentType,
        rendererVersion: input.rendererVersion ?? 1,
      }),
    )
    .digest("hex");
}

export function issuePublicationToken(): { raw: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString("base64url");
  const prefix = randomBytes(4).toString("hex");
  const raw = `forge_art_${prefix}_${secret}`;
  return { raw, prefix, hash: createHash("sha256").update(raw).digest("hex") };
}

export function hashPublicationToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function buildArtifactAssetManifest(
  db: DbClient,
  workspaceId: string,
  body: string,
): Promise<Prisma.InputJsonValue> {
  const ids = Array.from(
    new Set(Array.from(body.matchAll(/forge-attachment:([a-z0-9]{20,})/gi), (match) => match[1]!)),
  );
  if (!ids.length) return [];
  const attachments = await db.attachment.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true, filename: true, mimeType: true, size: true, kind: true, url: true },
  });
  if (attachments.length !== ids.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Artifact references an unavailable attachment.",
    });
  }
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return ids.map((id, position) => {
    const attachment = byId.get(id)!;
    return {
      id,
      position,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind,
      integrity: createHash("sha256")
        .update(
          JSON.stringify({
            id,
            url: attachment.url,
            size: attachment.size,
            mimeType: attachment.mimeType,
          }),
        )
        .digest("hex"),
    };
  });
}

export async function requestArtifactReview(
  db: PrismaClient,
  params: {
    workspaceId: string;
    artifactId: string;
    actorId: string;
    actorAgentId?: string | null;
  },
) {
  return db.$transaction(async (tx) => {
    const artifact = await tx.artifact.findFirst({
      where: { id: params.artifactId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true, status: true, currentVersionId: true },
    });
    if (!artifact?.currentVersionId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Save a version before requesting review.",
      });
    }
    const now = new Date();
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { status: ArtifactStatus.IN_REVIEW, reviewRequestedAt: now },
    });
    await recordArtifactAction(tx, params, "review-requested", {
      versionId: artifact.currentVersionId,
    });
    return { versionId: artifact.currentVersionId, reviewRequestedAt: now };
  });
}

export async function acceptArtifactVersion(
  db: PrismaClient,
  params: {
    workspaceId: string;
    artifactId: string;
    versionId?: string;
    actorId: string;
    actorAgentId?: string | null;
  },
) {
  return db.$transaction(async (tx) => {
    const artifact = await tx.artifact.findFirst({
      where: { id: params.artifactId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true, currentVersionId: true },
    });
    if (!artifact) throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
    const versionId = params.versionId ?? artifact.currentVersionId;
    if (!versionId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Artifact has no saved version." });
    const version = await tx.artifactVersion.findFirst({
      where: { id: versionId, artifactId: artifact.id, workspaceId: params.workspaceId },
      select: { id: true, version: true, assetManifest: true },
    });
    if (!version)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Version does not belong to this artifact.",
      });
    const assetIds = Array.isArray(version.assetManifest)
      ? version.assetManifest.flatMap((entry) =>
          typeof entry === "object" && entry && "id" in entry && typeof entry.id === "string"
            ? [entry.id]
            : [],
        )
      : [];
    if (assetIds.length) {
      const available = await tx.attachment.count({
        where: { workspaceId: params.workspaceId, id: { in: assetIds } },
      });
      if (available !== assetIds.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A version asset is no longer available.",
        });
      }
    }
    const now = new Date();
    await tx.artifact.update({
      where: { id: artifact.id },
      data: {
        status: ArtifactStatus.ACCEPTED,
        acceptedVersionId: version.id,
        acceptedAt: now,
        acceptedById: params.actorId,
      },
    });
    await recordArtifactAction(tx, params, "version-accepted", {
      versionId: version.id,
      version: version.version,
    });
    return { versionId: version.id, version: version.version, acceptedAt: now };
  });
}

export async function requestArtifactChanges(
  db: PrismaClient,
  params: {
    workspaceId: string;
    artifactId: string;
    actorId: string;
    actorAgentId?: string | null;
  },
) {
  return db.$transaction(async (tx) => {
    const artifact = await tx.artifact.findFirst({
      where: { id: params.artifactId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true, status: true, currentVersionId: true },
    });
    if (!artifact) throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
    if (artifact.status !== ArtifactStatus.IN_REVIEW) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Artifact is not currently in review." });
    }
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { status: ArtifactStatus.DRAFT, reviewRequestedAt: null },
    });
    await recordArtifactAction(tx, params, "changes-requested", {
      versionId: artifact.currentVersionId,
    });
    return { ok: true };
  });
}

export async function publishArtifactVersion(
  db: PrismaClient,
  params: {
    workspaceId: string;
    artifactId: string;
    versionId?: string;
    audience: ArtifactPublicationAudience;
    expiresAt?: Date | null;
    actorId: string;
    actorAgentId?: string | null;
  },
) {
  return db.$transaction(async (tx) => {
    const artifact = await tx.artifact.findFirst({
      where: { id: params.artifactId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true, acceptedVersionId: true },
    });
    if (!artifact?.acceptedVersionId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Accept a version before publishing." });
    }
    const versionId = params.versionId ?? artifact.acceptedVersionId;
    if (versionId !== artifact.acceptedVersionId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Only the accepted version can be published.",
      });
    }
    const version = await tx.artifactVersion.findFirst({
      where: { id: versionId, artifactId: artifact.id, workspaceId: params.workspaceId },
      select: { id: true, version: true },
    });
    if (!version)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Version does not belong to this artifact.",
      });

    const token =
      params.audience === ArtifactPublicationAudience.LINK ? issuePublicationToken() : null;
    const publication = await tx.artifactPublication.create({
      data: {
        workspaceId: params.workspaceId,
        artifactId: artifact.id,
        versionId: version.id,
        audience: params.audience,
        status: ArtifactPublicationStatus.ACTIVE,
        tokenHash: token?.hash ?? null,
        tokenPrefix: token?.prefix ?? null,
        expiresAt: params.expiresAt ?? null,
        createdById: params.actorId,
      },
      select: { id: true, expiresAt: true, audience: true },
    });
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { publishedVersionId: version.id },
    });
    await recordArtifactAction(tx, params, "version-published", {
      publicationId: publication.id,
      versionId: version.id,
      audience: publication.audience,
    });
    return { ...publication, token: token?.raw ?? null, version: version.version };
  });
}

export async function revokeArtifactPublication(
  db: PrismaClient,
  params: {
    workspaceId: string;
    publicationId: string;
    actorId: string;
    actorAgentId?: string | null;
  },
) {
  return db.$transaction(async (tx) => {
    const publication = await tx.artifactPublication.findFirst({
      where: { id: params.publicationId, workspaceId: params.workspaceId },
      select: { id: true, artifactId: true, versionId: true, status: true },
    });
    if (!publication) throw new TRPCError({ code: "NOT_FOUND", message: "Publication not found." });
    if (publication.status !== ArtifactPublicationStatus.ACTIVE) return publication;
    const now = new Date();
    await tx.artifactPublication.update({
      where: { id: publication.id },
      data: {
        status: ArtifactPublicationStatus.REVOKED,
        revokedAt: now,
        revokedById: params.actorId,
      },
    });
    const anotherActive = await tx.artifactPublication.findFirst({
      where: {
        artifactId: publication.artifactId,
        status: ArtifactPublicationStatus.ACTIVE,
        id: { not: publication.id },
      },
      select: { versionId: true },
      orderBy: { createdAt: "desc" },
    });
    await tx.artifact.update({
      where: { id: publication.artifactId },
      data: { publishedVersionId: anotherActive?.versionId ?? null },
    });
    await recordArtifactAction(
      tx,
      { ...params, artifactId: publication.artifactId },
      "publication-revoked",
      { publicationId: publication.id },
    );
    return { ...publication, status: ArtifactPublicationStatus.REVOKED, revokedAt: now };
  });
}

export async function findPublishedArtifactByToken(db: DbClient, rawToken: string) {
  const now = new Date();
  const publication = await db.artifactPublication.findFirst({
    where: {
      tokenHash: hashPublicationToken(rawToken),
      audience: ArtifactPublicationAudience.LINK,
      status: ArtifactPublicationStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: {
      id: true,
      workspaceId: true,
      expiresAt: true,
      artifact: { select: { id: true, title: true, slug: true, type: true, summary: true } },
      version: {
        select: {
          id: true,
          version: true,
          title: true,
          body: true,
          summary: true,
          contentType: true,
          createdAt: true,
        },
      },
    },
  });
  return publication;
}

export async function deployArtifactPreview(
  db: PrismaClient,
  params: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    publicationId?: string | null;
    actorId: string;
  },
) {
  const baseUrl = process.env.ARTIFACT_PREVIEW_URL?.replace(/\/$/, "");
  const token = process.env.ARTIFACT_PREVIEW_TOKEN ?? process.env.ARTIFACT_PREVIEW_API_KEY;
  if (!baseUrl || !token) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Artifact Preview is not configured.",
    });
  }
  const artifact = await db.artifact.findFirst({
    where: { id: params.artifactId, workspaceId: params.workspaceId, archivedAt: null },
    select: { publishedVersionId: true },
  });
  if (!artifact || artifact.publishedVersionId !== params.versionId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Artifact Preview deployments must use the currently published version.",
    });
  }
  const source = await db.artifactVersion.findFirst({
    where: { id: params.versionId, artifactId: params.artifactId, workspaceId: params.workspaceId },
    select: {
      id: true,
      title: true,
      body: true,
      summary: true,
      contentChecksum: true,
      artifact: { select: { slug: true } },
    },
  });
  if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Artifact version not found." });
  const workspace = await db.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { artifactPreviewEnabled: true },
  });
  if (!workspace?.artifactPreviewEnabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Artifact Preview is disabled for this workspace.",
    });
  }
  const deployment = await db.artifactDeployment.create({
    data: {
      workspaceId: params.workspaceId,
      artifactId: params.artifactId,
      versionId: params.versionId,
      publicationId: params.publicationId ?? null,
      status: ArtifactDeploymentStatus.DEPLOYING,
      bundleChecksum: source.contentChecksum,
      createdById: params.actorId,
    },
  });
  try {
    const html = renderStandaloneArtifactHtml(source.title, source.body);
    const body = JSON.stringify({
      files: { "index.html": html },
      slug: source.artifact.slug,
      title: source.title,
      description: source.summary ?? "Published from Forge",
      visibility: "private",
    });
    const request = (method: "PUT" | "POST", path: string) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(60_000),
      });
    let response = await request("PUT", `/api/sites/${encodeURIComponent(source.artifact.slug)}`);
    if (response.status === 404) response = await request("POST", "/api/sites");
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(
        typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`,
      );
    const externalUrl = `${baseUrl}/${source.artifact.slug}/`;
    return await db.artifactDeployment.update({
      where: { id: deployment.id },
      data: {
        status: ArtifactDeploymentStatus.READY,
        externalId: source.artifact.slug,
        externalUrl,
        deployedAt: new Date(),
      },
    });
  } catch (error) {
    await db.artifactDeployment.update({
      where: { id: deployment.id },
      data: {
        status: ArtifactDeploymentStatus.FAILED,
        errorMessage: error instanceof Error ? error.message : "Deployment failed",
      },
    });
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Artifact Preview deployment failed.",
      cause: error,
    });
  }
}

function renderStandaloneArtifactHtml(title: string, markdown: string): string {
  const data = JSON.stringify(markdown).replace(/</g, "\\u003c");
  const safeTitle = title.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>body{margin:0;background:#f4efe6;color:#292724;font:16px/1.65 ui-sans-serif,system-ui}main{max-width:860px;margin:auto;padding:48px 24px}pre{white-space:pre-wrap;font:14px/1.6 ui-monospace,monospace;background:#e9e1d5;padding:20px;border-radius:12px}</style></head><body><main><h1>${safeTitle}</h1><pre id="content"></pre></main><script>document.getElementById("content").textContent=${data}</script></body></html>`;
}

async function recordArtifactAction(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    artifactId: string;
    actorId: string;
    actorAgentId?: string | null;
  },
  action: string,
  payload: Prisma.InputJsonValue,
) {
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    entity: "artifact",
    entityId: params.artifactId,
    action,
    eventKind: EventKind.ISSUE_UPDATED,
    subjectType: "artifact",
    subjectId: params.artifactId,
    payload: {
      action,
      ...((payload as Record<string, Prisma.JsonValue>) ?? {}),
    } as Prisma.InputJsonValue,
  });
}
