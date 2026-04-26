import "server-only";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  PutBucketCorsCommand,
  type ObjectIdentifier,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";

/**
 * Object storage service backed by MinIO (S3-compatible).
 *
 * One bucket per workspace: `forge-${workspace.slug}`. Slugs are already
 * validated as lowercase alphanumeric-with-dashes by the workspace router,
 * which is a subset of S3 bucket naming rules (3-63 chars, lowercase).
 *
 * Storage keys are random UUIDs nested under the target type/id to keep
 * listings navigable in console tools.
 */

// -- Config ------------------------------------------------------------------

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB hard cap per upload
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Mime allowlist. Reject anything not in here during `initUpload`.
 * Grouped for readability.
 */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set<string>([
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Documents
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Archives
  "application/zip",
]);

export const ALLOWED_TARGET_TYPES: ReadonlySet<string> = new Set<string>([
  "issue",
  "comment",
  "project",
  "initiative",
  "cycle",
]);

// -- Client ------------------------------------------------------------------

/**
 * Thrown when the runtime cannot find S3 credentials in the environment.
 * Distinct from generic Error so the tRPC layer can map it to a precise
 * `PRECONDITION_FAILED` response (vs. a generic 400) and the UI can
 * detect the case and render an admin-friendly banner.
 */
export class StorageNotConfiguredError extends Error {
  constructor(
    message = "Object storage is not configured. Ask an admin to set S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY.",
  ) {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

/**
 * Cheap, side-effect-free check used by routers / UI to decide whether
 * to even attempt a storage call. Mirrors the credential check inside
 * `getS3Client()` but never throws and never instantiates the client.
 */
export function isStorageConfigured(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_ACCESS_KEY &&
      process.env.S3_SECRET_KEY,
  );
}

let _client: S3Client | null = null;
let _presignClient: S3Client | null = null;

function readSharedConfig() {
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const region = process.env.S3_REGION ?? "us-east-1";
  const forcePathStyle =
    (process.env.S3_FORCE_PATH_STYLE ?? "true").toLowerCase() !== "false";
  if (!accessKeyId || !secretAccessKey) {
    throw new StorageNotConfiguredError();
  }
  return { accessKeyId, secretAccessKey, region, forcePathStyle };
}

/**
 * Internal SDK client — talks directly to MinIO over the Docker
 * bridge for bucket ops, head, list, delete. Endpoint is
 * `S3_ENDPOINT` (typically `http://minio:9000` in compose).
 */
export function getS3Client(): S3Client {
  if (_client) return _client;
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint) throw new StorageNotConfiguredError();
  const { accessKeyId, secretAccessKey, region, forcePathStyle } =
    readSharedConfig();
  _client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });
  return _client;
}

/**
 * Presign-only client — uses `S3_PUBLIC_ENDPOINT` (browser-reachable
 * HTTPS through Traefik) so generated PUT/GET URLs work from the
 * browser without mixed-content blocks or DNS lookups against
 * Docker-internal hostnames. Falls back to `S3_ENDPOINT` when
 * `S3_PUBLIC_ENDPOINT` is unset (single-host dev setups).
 *
 * Uploads: the browser issues a signed PUT against this URL → Traefik
 * routes to MinIO → MinIO accepts (signature host matches).
 * Downloads: same path with a signed GET.
 */
export function getPresignClient(): S3Client {
  if (_presignClient) return _presignClient;
  const endpoint =
    process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
  if (!endpoint) throw new StorageNotConfiguredError();
  const { accessKeyId, secretAccessKey, region, forcePathStyle } =
    readSharedConfig();
  _presignClient = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });
  return _presignClient;
}

/** Reset cached clients (tests only). */
export function _resetS3ClientForTests(): void {
  _client = null;
  _presignClient = null;
}

function bucketNameFromSlug(slug: string): string {
  return `forge-${slug}`;
}

// -- Helpers -----------------------------------------------------------------

async function loadWorkspace(workspaceId: string): Promise<{
  id: string;
  slug: string;
  attachmentQuotaMb: number;
}> {
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { id: true, slug: true, attachmentQuotaMb: true },
  });
  return ws;
}

/**
 * Idempotently create the bucket for a workspace. Safe to call on every
 * workspace create + on app startup. Returns the bucket name.
 */
export async function ensureWorkspaceBucket(workspaceId: string): Promise<string> {
  const ws = await loadWorkspace(workspaceId);
  const bucket = bucketNameFromSlug(ws.slug);
  const s3 = getS3Client();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return bucket;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    // 404 or NotFound -> create it; anything else rethrow.
    if (status !== 404 && (err as { name?: string })?.name !== "NotFound") {
      // MinIO sometimes reports 301/403 on HEAD for missing buckets; fall through to create.
      if (status !== 301 && status !== 403 && status !== undefined) {
        throw err;
      }
    }
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const code = (err as { name?: string })?.name;
    // Race or already exists — fine.
    if (
      code !== "BucketAlreadyOwnedByYou" &&
      code !== "BucketAlreadyExists"
    ) {
      throw err;
    }
  }
  await applyBucketCors(s3, bucket);
  return bucket;
}

/**
 * Apply a permissive-but-bounded CORS policy so the browser can PUT to
 * presigned URLs from the Forge app origin.
 *
 * Origins come from `S3_CORS_ALLOWED_ORIGINS` (comma-separated) so prod
 * can pin to its public origin while dev sees `*`. Always includes the
 * `x-amz-*` request headers the AWS SDK emits — without those exposed,
 * the browser preflight fails before the PUT even goes out.
 *
 * Idempotent — safe to call on every bucket-create.
 */
async function applyBucketCors(s3: S3Client, bucket: string): Promise<void> {
  const raw =
    process.env.S3_CORS_ALLOWED_ORIGINS ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "*";
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins.length ? origins : ["*"],
              AllowedMethods: ["GET", "PUT", "POST", "HEAD", "DELETE"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  } catch (err) {
    // Don't fail bucket creation on CORS — the browser uploads will
    // still surface the error and the operator can investigate.
    console.warn(
      `[storage.applyBucketCors] CORS apply failed for ${bucket}:`,
      (err as Error).message,
    );
  }
}

export async function workspaceQuotaStats(
  workspaceId: string,
): Promise<{ usedBytes: number; quotaBytes: number }> {
  const ws = await loadWorkspace(workspaceId);
  const agg = await db.attachment.aggregate({
    where: { workspaceId, url: { not: "" } },
    _sum: { size: true },
  });
  const usedBytes = agg._sum.size ?? 0;
  const quotaBytes = ws.attachmentQuotaMb * 1024 * 1024;
  return { usedBytes, quotaBytes };
}

function assertTargetShape(targetType: string | null | undefined, targetId: string | null | undefined): {
  targetType: string;
  targetId: string;
} {
  if (!targetType || !targetId) {
    throw new Error("Attachment requires both targetType and targetId.");
  }
  if (!ALLOWED_TARGET_TYPES.has(targetType)) {
    throw new Error(
      `Invalid targetType '${targetType}'. Allowed: ${[...ALLOWED_TARGET_TYPES].join(", ")}`,
    );
  }
  return { targetType, targetId };
}

function storageKeyFor(
  targetType: string,
  targetId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const uid = randomUUID();
  return `${targetType}/${targetId}/${uid}-${safeName}`;
}

// -- Primary operations ------------------------------------------------------

export interface PresignUploadInput {
  workspaceId: string;
  targetType: string;
  targetId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploaderId: string;
}

export interface PresignUploadResult {
  uploadUrl: string;
  attachmentId: string;
  storageKey: string;
  bucket: string;
  expiresInSeconds: number;
}

export async function presignUploadUrl(
  input: PresignUploadInput,
): Promise<PresignUploadResult> {
  // Bail before any DB work / bucket-create attempt if S3 isn't wired up.
  if (!isStorageConfigured()) {
    throw new StorageNotConfiguredError();
  }
  const { targetType, targetId } = assertTargetShape(input.targetType, input.targetId);
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new Error(`Mime type not allowed: ${input.mimeType}`);
  }
  if (!input.filename || input.filename.length > 255) {
    throw new Error("Filename must be 1-255 characters.");
  }
  if (input.size <= 0 || input.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File size out of range (max ${MAX_FILE_SIZE_BYTES} bytes, got ${input.size}).`,
    );
  }

  const ws = await loadWorkspace(input.workspaceId);
  const bucket = bucketNameFromSlug(ws.slug);

  const { usedBytes, quotaBytes } = await workspaceQuotaStats(input.workspaceId);
  if (usedBytes + input.size > quotaBytes) {
    throw new Error(
      `Workspace storage quota exceeded: ${usedBytes} + ${input.size} > ${quotaBytes} bytes.`,
    );
  }

  // Ensure bucket exists (idempotent; cheap after first call).
  await ensureWorkspaceBucket(input.workspaceId);

  const storageKey = storageKeyFor(targetType, targetId, input.filename);
  // Presign against the public endpoint so the URL is reachable from
  // the browser. SDK ops (bucket ensure above) still use the internal
  // client — that path doesn't leave the Docker bridge.
  const presign = getPresignClient();
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ContentType: input.mimeType,
    ContentLength: input.size,
  });
  const uploadUrl = await getSignedUrl(presign, cmd, { expiresIn: UPLOAD_URL_TTL_SECONDS });

  // Record a pending attachment row (url="" marks it as not yet finalized).
  const row = await db.attachment.create({
    data: {
      workspaceId: input.workspaceId,
      targetType,
      targetId,
      ...(targetType === "issue" ? { issueId: targetId } : {}),
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      url: "", // pending — finalized after client PUT completes
    },
    select: { id: true },
  });

  // Stash the storage key alongside by updating the url field's preview.
  // We encode key in `url` during the pending phase as `pending:<key>` so
  // finalize can look it up without widening the schema.
  await db.attachment.update({
    where: { id: row.id },
    data: { url: `pending:${storageKey}` },
  });

  return {
    uploadUrl,
    attachmentId: row.id,
    storageKey,
    bucket,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  };
}

export async function finalizeAttachment(params: {
  attachmentId: string;
  workspaceId: string;
}): Promise<{
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  targetType: string;
  targetId: string;
}> {
  const row = await db.attachment.findFirst({
    where: { id: params.attachmentId, workspaceId: params.workspaceId },
  });
  if (!row) throw new Error("Attachment not found.");
  if (!row.url.startsWith("pending:")) {
    // Already finalized — idempotent return.
    if (!row.targetType || !row.targetId) {
      throw new Error("Attachment has no targetType/targetId.");
    }
    return {
      id: row.id,
      url: row.url,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      targetType: row.targetType,
      targetId: row.targetId,
    };
  }
  const storageKey = row.url.slice("pending:".length);

  const ws = await loadWorkspace(row.workspaceId);
  const bucket = bucketNameFromSlug(ws.slug);
  const s3 = getS3Client();
  // Confirm the object exists — client actually completed the PUT.
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));

  // Store the storage key in `url` as the canonical ref. Download URLs
  // are presigned on demand.
  const updated = await db.attachment.update({
    where: { id: row.id },
    data: { url: storageKey },
  });
  if (!updated.targetType || !updated.targetId) {
    throw new Error("Attachment has no targetType/targetId.");
  }
  return {
    id: updated.id,
    url: updated.url,
    filename: updated.filename,
    mimeType: updated.mimeType,
    size: updated.size,
    targetType: updated.targetType,
    targetId: updated.targetId,
  };
}

export async function presignDownloadUrl(attachmentId: string): Promise<{
  url: string;
  filename: string;
  mimeType: string;
  expiresInSeconds: number;
}> {
  const row = await db.attachment.findUniqueOrThrow({
    where: { id: attachmentId },
  });
  if (!row.url || row.url.startsWith("pending:")) {
    throw new Error("Attachment not finalized yet.");
  }
  const ws = await loadWorkspace(row.workspaceId);
  const bucket = bucketNameFromSlug(ws.slug);
  // Presign against the public endpoint — same reason as upload: the
  // URL ends up in a browser <a download> click.
  const presign = getPresignClient();
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: row.url,
    ResponseContentDisposition: `attachment; filename="${row.filename.replace(/"/g, "")}"`,
  });
  const url = await getSignedUrl(presign, cmd, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  return {
    url,
    filename: row.filename,
    mimeType: row.mimeType,
    expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
  };
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  const row = await db.attachment.findUniqueOrThrow({
    where: { id: attachmentId },
  });
  const ws = await loadWorkspace(row.workspaceId);
  const bucket = bucketNameFromSlug(ws.slug);
  const s3 = getS3Client();
  const storageKey = row.url.startsWith("pending:") ? row.url.slice(8) : row.url;
  if (storageKey) {
    await s3
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
      .catch(() => {
        // If the object already doesn't exist, swallow so the row still removes.
      });
  }
  await db.attachment.delete({ where: { id: attachmentId } });
}

/**
 * Remove every object in a workspace's bucket, then remove the bucket itself.
 * Called during workspace hard-delete.
 */
export async function deleteWorkspaceBucket(workspaceId: string): Promise<void> {
  // Try to look up the workspace — if it's already gone (post-delete), skip.
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!ws) return;
  const bucket = bucketNameFromSlug(ws.slug);
  const s3 = getS3Client();

  // Drain objects in pages of 1000.
  let token: string | undefined = undefined;
  while (true) {
    let page: ListObjectsV2CommandOutput | null;
    try {
      page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
    } catch (err) {
      const code = (err as { name?: string })?.name;
      // NoSuchBucket -> nothing to do.
      if (code === "NoSuchBucket") return;
      throw err;
    }
    if (!page) return;
    const keys: ObjectIdentifier[] = (page.Contents ?? [])
      .filter((c): c is { Key: string } => typeof c.Key === "string")
      .map((c) => ({ Key: c.Key }));
    if (keys.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
    }
    if (!page.IsTruncated) break;
    token = page.NextContinuationToken;
  }
  await s3
    .send(new DeleteBucketCommand({ Bucket: bucket }))
    .catch((err) => {
      const code = (err as { name?: string })?.name;
      if (code !== "NoSuchBucket") throw err;
    });
}
