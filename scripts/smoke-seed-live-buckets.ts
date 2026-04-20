/**
 * Ensure MinIO has a bucket for each live workspace. Safe/idempotent.
 *
 * Called once during Phase 2C bring-up. Reads the workspace list from the
 * DATABASE_URL env and creates `forge-${slug}` if missing.
 */
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";

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
    return "present";
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
    return "created";
  }
}

async function main() {
  const workspaces = await prisma.workspace.findMany({
    where: { deletedAt: null },
    select: { slug: true, key: true, name: true },
    orderBy: { key: "asc" },
  });
  for (const w of workspaces) {
    const bucket = `forge-${w.slug}`;
    const state = await ensureBucket(bucket);
    console.log(`[${w.key}] ${bucket}: ${state}`);
  }
  const { Buckets } = await s3.send(new ListBucketsCommand({}));
  console.log(
    `All buckets: [${(Buckets ?? []).map((b) => b.Name).join(", ")}]`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
