import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  _resetS3ClientForTests,
  deleteAttachment,
  deleteWorkspaceBucket,
  ensureWorkspaceBucket,
  finalizeAttachment,
  getS3Client,
  presignDownloadUrl,
  presignUploadUrl,
  workspaceQuotaStats,
} from "@/server/services/storage";

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";

const fixtures: TestFixture[] = [];

async function putToPresigned(url: string, body: Buffer, mimeType: string) {
  const res = await fetch(url, {
    method: "PUT",
    body: new Uint8Array(body),
    headers: { "content-type": mimeType },
  });
  if (!res.ok) {
    throw new Error(`PUT failed ${res.status}: ${await res.text()}`);
  }
}

beforeAll(() => {
  // Point the storage client at the localhost-exposed MinIO (same process
  // host, not the Docker network name which only resolves in-cluster).
  process.env.S3_ENDPOINT = S3_ENDPOINT;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "forge_minio_admin";
  process.env.S3_SECRET_KEY =
    process.env.S3_SECRET_KEY ?? "c3ac4bd95c05c7d809f9b0e97a800d6d4c60f06c";
  process.env.S3_FORCE_PATH_STYLE = "true";
  _resetS3ClientForTests();
});

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    // Try to remove the bucket before the workspace so orphan objects
    // don't accumulate in MinIO across the suite.
    await deleteWorkspaceBucket(f.workspace.id).catch(() => {});
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("storage service", () => {
  it("ensureWorkspaceBucket is idempotent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SBK" });
    fixtures.push(fixture);
    const name = await ensureWorkspaceBucket(fixture.workspace.id);
    expect(name).toBe(`forge-${fixture.workspace.slug}`);
    // Second call should not throw.
    const nameAgain = await ensureWorkspaceBucket(fixture.workspace.id);
    expect(nameAgain).toBe(name);
  });

  it("rejects disallowed mime types and oversize uploads", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SMI" });
    fixtures.push(fixture);
    const issue = await createIssue(fixture);
    await ensureWorkspaceBucket(fixture.workspace.id);

    await expect(
      presignUploadUrl({
        workspaceId: fixture.workspace.id,
        targetType: "issue",
        targetId: issue.id,
        filename: "evil.exe",
        mimeType: "application/x-msdownload",
        size: 1024,
        uploaderId: fixture.user.id,
      }),
    ).rejects.toThrow(/not allowed/);

    await expect(
      presignUploadUrl({
        workspaceId: fixture.workspace.id,
        targetType: "issue",
        targetId: issue.id,
        filename: "huge.pdf",
        mimeType: "application/pdf",
        size: MAX_FILE_SIZE_BYTES + 1,
        uploaderId: fixture.user.id,
      }),
    ).rejects.toThrow(/size/i);

    expect(ALLOWED_MIME_TYPES.has("application/pdf")).toBe(true);
  });

  it("presign upload → PUT → finalize → download round-trip", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SRT" });
    fixtures.push(fixture);
    const issue = await createIssue(fixture);

    const body = Buffer.from("hello forge attachments", "utf8");
    const init = await presignUploadUrl({
      workspaceId: fixture.workspace.id,
      targetType: "issue",
      targetId: issue.id,
      filename: "notes.txt",
      mimeType: "text/plain",
      size: body.byteLength,
      uploaderId: fixture.user.id,
    });

    await putToPresigned(init.uploadUrl, body, "text/plain");

    const final = await finalizeAttachment({
      attachmentId: init.attachmentId,
      workspaceId: fixture.workspace.id,
    });
    expect(final.url).toBe(init.storageKey);
    expect(final.mimeType).toBe("text/plain");

    // Presigned GET should resolve and return the bytes.
    const dl = await presignDownloadUrl(init.attachmentId);
    const got = await fetch(dl.url);
    expect(got.status).toBe(200);
    const text = await got.text();
    expect(text).toBe("hello forge attachments");

    // Quota reflects the finalized attachment size.
    const quota = await workspaceQuotaStats(fixture.workspace.id);
    expect(quota.usedBytes).toBeGreaterThanOrEqual(body.byteLength);
    expect(quota.quotaBytes).toBe(
      fixture.workspace.attachmentQuotaMb * 1024 * 1024,
    );

    await deleteAttachment(init.attachmentId);
  });

  it("enforces workspace quota", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SQA" });
    fixtures.push(fixture);
    // Squeeze quota down so a 1 KB file bumps right up against it.
    const prisma = (await import("@/server/db")).db;
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { attachmentQuotaMb: 0 }, // 0 MB => any nonzero upload is rejected
    });
    const issue = await createIssue(fixture);

    await expect(
      presignUploadUrl({
        workspaceId: fixture.workspace.id,
        targetType: "issue",
        targetId: issue.id,
        filename: "a.txt",
        mimeType: "text/plain",
        size: 1024,
        uploaderId: fixture.user.id,
      }),
    ).rejects.toThrow(/quota/);
  });

  it("deleteWorkspaceBucket removes bucket + all objects", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SDB" });
    fixtures.push(fixture);
    const issue = await createIssue(fixture);

    const body = Buffer.from("bye", "utf8");
    const init = await presignUploadUrl({
      workspaceId: fixture.workspace.id,
      targetType: "issue",
      targetId: issue.id,
      filename: "bye.txt",
      mimeType: "text/plain",
      size: body.byteLength,
      uploaderId: fixture.user.id,
    });
    await putToPresigned(init.uploadUrl, body, "text/plain");
    await finalizeAttachment({
      attachmentId: init.attachmentId,
      workspaceId: fixture.workspace.id,
    });

    await deleteWorkspaceBucket(fixture.workspace.id);

    // HEAD the bucket — it should 404.
    const s3 = getS3Client();
    await expect(
      s3.send(
        // dynamic import to avoid top-level churn
        new (await import("@aws-sdk/client-s3")).HeadBucketCommand({
          Bucket: `forge-${fixture.workspace.slug}`,
        }),
      ),
    ).rejects.toThrow();
  });
});
