import "server-only";

import {
  CreateBucketCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import {
  getPresignClient,
  getS3Client,
  isStorageConfigured,
  StorageNotConfiguredError,
  UPLOAD_URL_TTL_SECONDS,
} from "@/server/services/storage";

export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_AVATAR_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type AvatarMimeType = (typeof ALLOWED_AVATAR_MIME_TYPES)[number];

const ALLOWED_AVATAR_MIME_SET = new Set<string>(ALLOWED_AVATAR_MIME_TYPES);
const DEFAULT_GLOBAL_BUCKET = "forge-global";
const AVATAR_UPLOAD_KEY_PATTERN = /^avatar-uploads\/([^/]+)\/([0-9a-f-]{36})$/;

export class InvalidAvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAvatarError";
  }
}

export function globalStorageBucket(): string {
  const bucket = process.env.S3_GLOBAL_BUCKET?.trim() || DEFAULT_GLOBAL_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new StorageNotConfiguredError("S3_GLOBAL_BUCKET is not a valid S3 bucket name.");
  }
  return bucket;
}

function avatarObjectKey(userId: string): string {
  return `avatar-uploads/${userId}/${randomUUID()}`;
}

function canonicalAvatarKey(userId: string, uploadKey: string): string {
  const match = AVATAR_UPLOAD_KEY_PATTERN.exec(uploadKey);
  if (!match || match[1] !== userId) {
    throw new InvalidAvatarError("Avatar upload does not belong to this account.");
  }
  return `avatars/${userId}/${match[2]}`;
}

export function detectAvatarMimeType(bytes: Uint8Array): AvatarMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.subarray(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function assertAvatarShape(
  contentType: string,
  sizeBytes: number,
): asserts contentType is AvatarMimeType {
  if (!ALLOWED_AVATAR_MIME_SET.has(contentType)) {
    throw new InvalidAvatarError("Avatar must be a PNG, JPEG, GIF, or WebP image.");
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_AVATAR_SIZE_BYTES) {
    throw new InvalidAvatarError(
      `Avatar must be between 1 byte and ${MAX_AVATAR_SIZE_BYTES} bytes.`,
    );
  }
}

async function applyGlobalBucketCors(bucket: string): Promise<void> {
  const raw = process.env.S3_CORS_ALLOWED_ORIGINS ?? process.env.NEXT_PUBLIC_APP_URL ?? "*";
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await getS3Client().send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins.length > 0 ? origins : ["*"],
            AllowedMethods: ["GET", "PUT", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
}

export async function ensureGlobalStorageBucket(): Promise<string> {
  if (!isStorageConfigured()) throw new StorageNotConfiguredError();
  const bucket = globalStorageBucket();
  const s3 = getS3Client();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return bucket;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (![undefined, 301, 403, 404].includes(status) && name !== "NotFound") throw error;
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== "BucketAlreadyExists" && name !== "BucketAlreadyOwnedByYou") throw error;
  }
  try {
    await applyGlobalBucketCors(bucket);
  } catch (error) {
    console.warn("[user-avatar] Failed to configure global bucket CORS:", (error as Error).message);
  }
  return bucket;
}

export async function presignUserAvatarUpload(input: {
  userId: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{
  uploadUrl: string;
  objectKey: string;
  headers: { "Content-Type": AvatarMimeType };
  expiresInSeconds: number;
}> {
  assertAvatarShape(input.contentType, input.sizeBytes);
  const bucket = await ensureGlobalStorageBucket();
  const objectKey = avatarObjectKey(input.userId);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: input.contentType,
    ContentLength: input.sizeBytes,
  });
  const uploadUrl = await getSignedUrl(getPresignClient(), command, {
    expiresIn: UPLOAD_URL_TTL_SECONDS,
  });
  return {
    uploadUrl,
    objectKey,
    headers: { "Content-Type": input.contentType },
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  };
}

async function readObjectBytes(bucket: string, objectKey: string): Promise<Uint8Array> {
  const object = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!object.Body) throw new InvalidAvatarError("Uploaded avatar has no content.");
  return (
    object.Body as { transformToByteArray: () => Promise<Uint8Array> }
  ).transformToByteArray();
}

async function removeObjectQuietly(bucket: string, objectKey: string): Promise<void> {
  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch {
    // The database pointer is authoritative. Orphan cleanup can be retried;
    // account removal and avatar replacement should still complete.
  }
}

export async function finalizeUserAvatar(input: {
  userId: string;
  objectKey: string;
}): Promise<{ url: string; contentType: AvatarMimeType; sizeBytes: number; updatedAt: Date }> {
  const canonicalKey = canonicalAvatarKey(input.userId, input.objectKey);
  const bucket = globalStorageBucket();
  const s3 = getS3Client();
  let contentType: string;
  let sizeBytes: number;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: input.objectKey }));
    contentType = head.ContentType ?? "";
    sizeBytes = head.ContentLength ?? 0;
    assertAvatarShape(contentType, sizeBytes);
    const bytes = await readObjectBytes(bucket, input.objectKey);
    if (bytes.byteLength !== sizeBytes || bytes.byteLength > MAX_AVATAR_SIZE_BYTES) {
      throw new InvalidAvatarError("Uploaded avatar size does not match its declared size.");
    }
    const detectedType = detectAvatarMimeType(bytes);
    if (!detectedType || detectedType !== contentType) {
      throw new InvalidAvatarError(
        "Uploaded avatar content does not match its declared image type.",
      );
    }
  } catch (error) {
    if (error instanceof InvalidAvatarError) {
      await removeObjectQuietly(bucket, input.objectKey);
    }
    throw error;
  }

  let etag: string | null = null;
  try {
    const copied = await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: canonicalKey,
        CopySource: `${bucket}/${input.objectKey}`,
        ContentType: contentType,
        MetadataDirective: "REPLACE",
      }),
    );
    etag = copied.CopyObjectResult?.ETag?.replace(/^"|"$/g, "") ?? null;
  } finally {
    // A presigned staging key remains writable until its URL expires. Move
    // validated bytes to a server-only key before storing the DB pointer.
    await removeObjectQuietly(bucket, input.objectKey);
  }

  const stableUrl = `/api/avatar/${input.userId}`;
  const [previous, currentUser] = await Promise.all([
    db.userAvatar.findUnique({ where: { userId: input.userId } }),
    db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { image: true } }),
  ]);
  const fallbackImage =
    previous?.fallbackImage ??
    (currentUser.image && currentUser.image !== stableUrl ? currentUser.image : null);
  let avatar;
  try {
    avatar = await db.$transaction(async (tx) => {
      const updated = await tx.userAvatar.upsert({
        where: { userId: input.userId },
        update: { objectKey: canonicalKey, contentType, sizeBytes, etag, fallbackImage },
        create: {
          userId: input.userId,
          objectKey: canonicalKey,
          contentType,
          sizeBytes,
          etag,
          fallbackImage,
        },
      });
      // User.image remains the global read contract across the existing UI.
      // Preserve its provider value on UserAvatar so removal can restore it.
      await tx.user.update({ where: { id: input.userId }, data: { image: stableUrl } });
      return updated;
    });
  } catch (error) {
    await removeObjectQuietly(bucket, canonicalKey);
    throw error;
  }
  if (previous && previous.objectKey !== canonicalKey) {
    await removeObjectQuietly(bucket, previous.objectKey);
  }
  return {
    url: stableUrl,
    contentType: contentType as AvatarMimeType,
    sizeBytes,
    updatedAt: avatar.updatedAt,
  };
}

export async function removeUserAvatar(
  userId: string,
  options: { restoreFallback?: boolean } = {},
): Promise<{ removed: boolean }> {
  const avatar = await db.userAvatar.findUnique({ where: { userId } });
  if (!avatar) return { removed: false };
  if (options.restoreFallback === false) {
    await db.userAvatar.delete({ where: { userId } });
  } else {
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { image: avatar.fallbackImage } }),
      db.userAvatar.delete({ where: { userId } }),
    ]);
  }
  try {
    await removeObjectQuietly(globalStorageBucket(), avatar.objectKey);
  } catch {
    // Invalid/missing storage configuration must not resurrect a DB pointer.
    // Object cleanup remains a safe operational retry.
  }
  return { removed: true };
}

export async function getUserAvatarState(userId: string): Promise<{
  hasLocalAvatar: boolean;
  avatarUrl: string | null;
  fallbackImage: string | null;
  resolvedImage: string | null;
  updatedAt: Date | null;
}> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      image: true,
      avatar: { select: { updatedAt: true, fallbackImage: true } },
    },
  });
  if (!user) throw new InvalidAvatarError("User not found.");
  const avatarUrl = user.avatar ? `/api/avatar/${userId}` : null;
  return {
    hasLocalAvatar: Boolean(user.avatar),
    avatarUrl,
    fallbackImage: user.avatar?.fallbackImage ?? user.image,
    resolvedImage: avatarUrl ?? user.image,
    updatedAt: user.avatar?.updatedAt ?? null,
  };
}

export async function readUserAvatar(userId: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
  etag: string | null;
  updatedAt: Date;
} | null> {
  const avatar = await db.userAvatar.findFirst({
    where: { userId, user: { deletedAt: null } },
  });
  if (!avatar) return null;
  const bytes = await readObjectBytes(globalStorageBucket(), avatar.objectKey);
  if (bytes.byteLength !== avatar.sizeBytes || detectAvatarMimeType(bytes) !== avatar.contentType) {
    throw new InvalidAvatarError("Stored avatar failed integrity validation.");
  }
  return {
    bytes,
    contentType: avatar.contentType,
    etag: avatar.etag,
    updatedAt: avatar.updatedAt,
  };
}
