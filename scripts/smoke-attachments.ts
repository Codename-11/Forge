/**
 * Smoke test — exercise storage + attachment + narrowing + blocker-skip flows
 * end-to-end against the configured DATABASE_URL and S3 endpoint.
 *
 * This script inlines the S3 + scope logic (rather than importing the
 * `server-only`-guarded modules) so it can be run from a plain `tsx`
 * context without Next.js's RSC machinery.
 */
import { PrismaClient, RelationKind, Role } from "@prisma/client";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const prisma = new PrismaClient();
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

async function ensureBucket(name: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
  }
}

async function emptyBucket(name: string) {
  let token: string | undefined = undefined;
  while (true) {
    let page: ListObjectsV2CommandOutput | null;
    try {
      page = await s3.send(
        new ListObjectsV2Command({ Bucket: name, ContinuationToken: token }),
      );
    } catch {
      return;
    }
    if (!page) return;
    const keys = (page.Contents ?? [])
      .filter((c): c is { Key: string } => typeof c.Key === "string")
      .map((c) => ({ Key: c.Key }));
    if (keys.length) {
      await s3.send(
        new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: keys } }),
      );
    }
    if (!page.IsTruncated) break;
    token = page.NextContinuationToken;
  }
  await s3.send(new DeleteBucketCommand({ Bucket: name })).catch(() => {});
}

async function main() {
  const stamp = Date.now().toString(36);
  const slug = `smoke-${stamp}`;
  const key = `SMK${stamp.slice(-2).toUpperCase()}`.slice(0, 6);

  const user = await prisma.user.create({
    data: { email: `smoke-${stamp}@example.com`, name: "Smoke" },
  });
  const workspace = await prisma.workspace.create({
    data: {
      slug,
      name: `Smoke ${stamp}`,
      key,
      memberships: { create: { userId: user.id, role: Role.OWNER } },
      statuses: {
        create: [
          { name: "Backlog", category: "BACKLOG", color: "#78716c", position: 0 },
          { name: "Todo", category: "TODO", color: "#a8a29e", position: 1, isDefault: true },
          { name: "Done", category: "DONE", color: "#65a30d", position: 2 },
        ],
      },
    },
  });

  const bucket = `forge-${workspace.slug}`;

  try {
    // [1] bucket creation
    await ensureBucket(bucket);
    console.log(`[1] bucket ready: ${bucket}`);

    const todo = await prisma.status.findFirstOrThrow({
      where: { workspaceId: workspace.id, category: "TODO" },
    });
    const label = await prisma.label.create({
      data: { workspaceId: workspace.id, name: "bot", color: "#d97706" },
    });
    const issueA = await prisma.issue.create({
      data: {
        workspaceId: workspace.id,
        number: 1,
        title: "In scope",
        statusId: todo.id,
        authorId: user.id,
        queued: true,
        labels: { create: { labelId: label.id } },
      },
    });
    const issueB = await prisma.issue.create({
      data: {
        workspaceId: workspace.id,
        number: 2,
        title: "Out of scope",
        statusId: todo.id,
        authorId: user.id,
        queued: true,
      },
    });

    // [2] Upload round-trip
    const body = Buffer.from(`smoke-${stamp}`, "utf8");
    const storageKey = `issue/${issueA.id}/${stamp}-smoke.txt`;
    const putUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        ContentType: "text/plain",
        ContentLength: body.byteLength,
      }),
      { expiresIn: 900 },
    );
    const put = await fetch(putUrl, {
      method: "PUT",
      body,
      headers: { "content-type": "text/plain" },
    });
    if (!put.ok) throw new Error(`PUT failed ${put.status}: ${await put.text()}`);

    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));

    const getUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
      { expiresIn: 900 },
    );
    const got = await fetch(getUrl);
    const text = await got.text();
    console.log(
      `[2] upload round-trip: key=${storageKey}, downloaded=${text === body.toString()}`,
    );

    // [3] Narrowed apiKey list filter — buildKeyScopeWhere equivalent
    const narrowed = await prisma.issue.findMany({
      where: {
        workspaceId: workspace.id,
        deletedAt: null,
        OR: [{ labels: { some: { labelId: { in: [label.id] } } } }],
      },
      select: { id: true, title: true },
    });
    console.log(
      `[3] narrowed issues.list: [${narrowed.map((i) => i.title).join(", ")}]`,
    );
    console.log(
      `[3] narrowed excludes 'Out of scope': ${!narrowed.find((i) => i.id === issueB.id)}`,
    );

    // [4] Blocker-skip
    const blocker = await prisma.issue.create({
      data: {
        workspaceId: workspace.id,
        number: 3,
        title: "Blocker (open)",
        statusId: todo.id,
        authorId: user.id,
      },
    });
    const blocked = await prisma.issue.create({
      data: {
        workspaceId: workspace.id,
        number: 4,
        title: "Blocked",
        statusId: todo.id,
        authorId: user.id,
        queued: true,
      },
    });
    await prisma.issueRelation.create({
      data: {
        workspaceId: workspace.id,
        fromIssueId: blocker.id,
        toIssueId: blocked.id,
        kind: RelationKind.BLOCKED_BY,
      },
    });
    await prisma.issueRelation.create({
      data: {
        workspaceId: workspace.id,
        fromIssueId: blocked.id,
        toIssueId: blocker.id,
        kind: RelationKind.BLOCKS,
      },
    });
    const blockers = await prisma.issueRelation.findMany({
      where: {
        workspaceId: workspace.id,
        OR: [
          {
            kind: RelationKind.BLOCKED_BY,
            fromIssue: {
              status: { category: { notIn: ["DONE", "CANCELED"] } },
              deletedAt: null,
            },
          },
          {
            kind: RelationKind.BLOCKS,
            toIssue: {
              status: { category: { notIn: ["DONE", "CANCELED"] } },
              deletedAt: null,
            },
          },
        ],
      },
    });
    const blockedIds = new Set<string>();
    for (const r of blockers) {
      if (r.kind === RelationKind.BLOCKED_BY) blockedIds.add(r.toIssueId);
      if (r.kind === RelationKind.BLOCKS) blockedIds.add(r.fromIssueId);
    }
    const candidates = await prisma.issue.findMany({
      where: {
        workspaceId: workspace.id,
        deletedAt: null,
        queued: true,
        claimedAt: null,
        status: { category: { notIn: ["DONE", "CANCELED"] } },
        id: { notIn: [...blockedIds] },
      },
      select: { id: true, title: true },
    });
    console.log(
      `[4] claim candidates (NO 'Blocked'): [${candidates
        .map((c) => c.title)
        .join(", ")}]`,
    );
  } finally {
    await emptyBucket(bucket).catch(() => {});
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
