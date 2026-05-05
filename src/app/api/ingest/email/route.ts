import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { db } from "@/server/db";
import { recordChange } from "@/server/audit";
import { EventKind } from "@prisma/client";
import {
  ALLOWED_MIME_TYPES,
  ensureWorkspaceBucket,
  getS3Client,
  isStorageConfigured,
  MAX_FILE_SIZE_BYTES,
} from "@/server/services/storage";

/**
 * Inbound email-to-issue webhook.
 *
 * Contract (POST `/api/ingest/email`):
 *   Headers
 *     `content-type: application/json`
 *     `x-forge-email-signature: <hex hmac-sha256 of raw body>`
 *
 *   Body (JSON):
 *     {
 *       workspaceKey: string,                   // e.g. "AXI"
 *       from:         string,                   // sender email
 *       subject:      string,                   // becomes issue title
 *       body:         string,                   // plain or markdown body
 *       replyTo?:     string,
 *       headers?:     Record<string, string>,
 *       attachments?: { filename, mimeType, base64 }[]
 *     }
 *
 * Auth flow:
 *   1. Resolve workspace by key (404 on miss).
 *   2. Reject if `emailIngestEnabled = false` (403).
 *   3. Verify HMAC against the workspace's `emailIngestSecret` using
 *      timing-safe compare (401 on miss/mismatch).
 *   4. Find author by `from` email (case-insensitive). Used to set
 *      `Issue.claimedById` if a workspace member matches; otherwise
 *      the issue lands unassigned and queueable.
 *   5. Create the issue in the workspace's default status, with
 *      `title = subject` and `body = "From: <from>\n\n<body>"`.
 *      Attachments (if any) are uploaded directly to MinIO via
 *      `PutObjectCommand` and linked through `Attachment` rows
 *      pointing at the new issue.
 *
 * Out of scope for this run:
 *   - Real provider wiring (Postmark / SendGrid inbound). The endpoint
 *     is the contract; whatever upstream signs the payload owns delivery.
 *   - Threading: replies are not stitched into existing issues. Future:
 *     parse `In-Reply-To` / `References` headers and append a comment.
 */
export async function POST(req: NextRequest) {
  const sigHeader = req.headers.get("x-forge-email-signature");
  if (!sigHeader) {
    return NextResponse.json(
      { error: "Missing x-forge-email-signature header." },
      { status: 401 },
    );
  }

  const rawBody = await req.text();
  if (rawBody.length === 0) {
    return NextResponse.json(
      { error: "Empty body." },
      { status: 400 },
    );
  }

  let parsed: EmailIngestBody;
  try {
    parsed = JSON.parse(rawBody) as EmailIngestBody;
  } catch {
    return NextResponse.json(
      { error: "Body is not valid JSON." },
      { status: 400 },
    );
  }

  const validation = validateBody(parsed);
  if (validation) {
    return NextResponse.json({ error: validation }, { status: 400 });
  }

  // Resolve workspace by key. Look-before-leap means an attacker
  // probing keys learns existence; mitigate via 404 on missing
  // (vs. 401 only after auth) — the secret is per-workspace anyway,
  // so existence isn't sensitive in this deployment.
  const workspace = await db.workspace.findUnique({
    where: { key: parsed.workspaceKey },
    select: {
      id: true,
      key: true,
      slug: true,
      deletedAt: true,
      emailIngestEnabled: true,
      emailIngestSecret: true,
    },
  });
  if (!workspace || workspace.deletedAt) {
    return NextResponse.json(
      { error: "Workspace not found." },
      { status: 404 },
    );
  }

  if (!workspace.emailIngestEnabled || !workspace.emailIngestSecret) {
    return NextResponse.json(
      { error: "Email ingest is disabled for this workspace." },
      { status: 403 },
    );
  }

  if (!verifyHmac(workspace.emailIngestSecret, rawBody, sigHeader)) {
    return NextResponse.json(
      { error: "Bad signature." },
      { status: 401 },
    );
  }

  // Look up the author (best-effort). The lookup is workspace-scoped:
  // a matching User must also be a Membership in this workspace, else
  // we leave the issue unassigned.
  const fromEmail = parsed.from.toLowerCase().trim();
  const member = await db.membership.findFirst({
    where: {
      workspaceId: workspace.id,
      user: { email: fromEmail },
    },
    select: { userId: true },
  });
  const authorId = member?.userId ?? null;

  // Default status — created-as-default by every workspace seed.
  const defaultStatus = await db.status.findFirstOrThrow({
    where: { workspaceId: workspace.id, isDefault: true },
    select: { id: true },
  });

  // Pick the next issue number.
  const last = await db.issue.findFirst({
    where: { workspaceId: workspace.id },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const number = (last?.number ?? 0) + 1;

  // Issue.authorId is required (non-null FK in schema) — when no
  // matching member, fall back to the workspace's first OWNER so
  // there's always a valid actor on the row. This mirrors the
  // pattern used by workspace seeds for system-generated rows.
  const fallbackAuthor = await db.membership.findFirst({
    where: { workspaceId: workspace.id, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  const effectiveAuthorId = authorId ?? fallbackAuthor?.userId;
  if (!effectiveAuthorId) {
    return NextResponse.json(
      { error: "Workspace has no owner to attribute the issue to." },
      { status: 500 },
    );
  }

  const composedBody = `From: ${parsed.from}\n\n${parsed.body}`;
  const issueId = await db.$transaction(async (tx) => {
    const issue = await tx.issue.create({
      data: {
        workspaceId: workspace.id,
        number,
        kind: "TASK",
        title: parsed.subject.slice(0, 200),
        description: composedBody,
        statusId: defaultStatus.id,
        priority: "NONE",
        authorId: effectiveAuthorId,
        claimedById: authorId, // null if from-email isn't a member
      },
      select: { id: true, number: true, title: true },
    });

    await recordChange(tx, {
      workspaceId: workspace.id,
      actorId: authorId,
      entity: "Issue",
      entityId: issue.id,
      action: "create",
      after: issue,
      eventKind: EventKind.ISSUE_CREATED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        number: issue.number,
        title: issue.title,
        source: "email-ingest",
        from: parsed.from,
      },
    });

    return issue.id;
  });

  // Attachments: upload + link AFTER the transaction so a failed S3
  // PUT doesn't roll the issue back. Each failure is logged but
  // non-fatal — the issue still exists, just without that file.
  let attachmentsLinked = 0;
  let attachmentsFailed = 0;
  if (parsed.attachments && parsed.attachments.length > 0) {
    if (!isStorageConfigured()) {
      console.warn(
        `[ingest/email] Skipping ${parsed.attachments.length} attachment(s) — S3 not configured.`,
      );
      attachmentsFailed = parsed.attachments.length;
    } else {
      const s3 = getS3Client();
      const bucket = await ensureWorkspaceBucket(workspace.id);
      for (const att of parsed.attachments) {
        try {
          const result = await uploadEmailAttachment({
            s3,
            bucket,
            workspaceId: workspace.id,
            issueId,
            attachment: att,
          });
          if (result === "skipped") attachmentsFailed++;
          else attachmentsLinked++;
        } catch (err) {
          attachmentsFailed++;
          console.warn(
            `[ingest/email] Attachment "${att.filename}" failed:`,
            (err as Error).message,
          );
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    issueId,
    number,
    attachmentsLinked,
    attachmentsFailed,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EmailIngestBody {
  workspaceKey: string;
  from: string;
  subject: string;
  body: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    base64: string;
  }>;
}

function validateBody(b: EmailIngestBody): string | null {
  if (typeof b.workspaceKey !== "string" || b.workspaceKey.length === 0) {
    return "workspaceKey is required.";
  }
  if (typeof b.from !== "string" || !/^[^@]+@[^@]+\.[^@]+$/.test(b.from)) {
    return "from must be a valid email address.";
  }
  if (typeof b.subject !== "string" || b.subject.length === 0) {
    return "subject is required.";
  }
  if (typeof b.body !== "string") {
    return "body must be a string.";
  }
  if (b.attachments !== undefined && !Array.isArray(b.attachments)) {
    return "attachments must be an array.";
  }
  for (const att of b.attachments ?? []) {
    if (
      typeof att.filename !== "string" ||
      typeof att.mimeType !== "string" ||
      typeof att.base64 !== "string"
    ) {
      return "each attachment requires filename, mimeType, base64.";
    }
  }
  return null;
}

function verifyHmac(secret: string, body: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function uploadEmailAttachment(args: {
  s3: S3Client;
  bucket: string;
  workspaceId: string;
  issueId: string;
  attachment: { filename: string; mimeType: string; base64: string };
}): Promise<"linked" | "skipped"> {
  const { s3, bucket, workspaceId, issueId, attachment } = args;
  // Reject mime types we don't allow on the regular upload path —
  // email shouldn't be a back-door for arbitrary mimes.
  if (!ALLOWED_MIME_TYPES.has(attachment.mimeType)) {
    console.warn(
      `[ingest/email] Disallowed mime type for "${attachment.filename}": ${attachment.mimeType}`,
    );
    return "skipped";
  }
  const buf = Buffer.from(attachment.base64, "base64");
  if (buf.length === 0 || buf.length > MAX_FILE_SIZE_BYTES) {
    console.warn(
      `[ingest/email] Attachment "${attachment.filename}" size out of range (${buf.length} bytes).`,
    );
    return "skipped";
  }
  const safeFilename = attachment.filename
    .replace(/[^\w.\-+ ]/g, "_")
    .slice(0, 255);
  // Storage key shape mirrors `storage.ts#storageKeyFor` (`<targetType>/<targetId>/<random>-<filename>`).
  const random = crypto.randomUUID();
  const storageKey = `issue/${issueId}/${random}-${safeFilename}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: buf,
      ContentType: attachment.mimeType,
      ContentLength: buf.length,
    }),
  );
  await db.attachment.create({
    data: {
      workspaceId,
      targetType: "issue",
      targetId: issueId,
      issueId,
      filename: safeFilename,
      mimeType: attachment.mimeType,
      size: buf.length,
      url: storageKey,
    },
  });
  return "linked";
}
