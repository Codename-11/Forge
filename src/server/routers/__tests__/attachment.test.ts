import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { attachmentRouter } from "@/server/routers/attachment";
import {
  _resetS3ClientForTests,
  deleteWorkspaceBucket,
} from "@/server/services/storage";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

beforeAll(() => {
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
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
    await deleteWorkspaceBucket(f.workspace.id).catch(() => {});
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "ATT" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = attachmentRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

async function putBytes(url: string, body: Buffer, mimeType: string) {
  const res = await fetch(url, {
    method: "PUT",
    body: new Uint8Array(body),
    headers: { "content-type": mimeType },
  });
  if (!res.ok) throw new Error(`PUT failed ${res.status}: ${await res.text()}`);
}

describe("attachmentRouter", () => {
  it("initUpload → finalize → list → download → delete", async () => {
    const { caller, fixture } = await setup();
    const issue = await createIssue(fixture);

    const body = Buffer.from("# markdown\nhello", "utf8");
    const init = await caller.initUpload({
      targetType: "issue",
      targetId: issue.id,
      filename: "notes.md",
      mimeType: "text/markdown",
      size: body.byteLength,
    });
    expect(init.attachmentId).toBeTruthy();

    await putBytes(init.uploadUrl, body, "text/markdown");

    const finalized = await caller.finalize({ attachmentId: init.attachmentId });
    expect(finalized.url).toBe(init.storageKey);

    const list = await caller.list({ targetType: "issue", targetId: issue.id });
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe("notes.md");

    const dl = await caller.getDownloadUrl({ attachmentId: init.attachmentId });
    const got = await fetch(dl.url);
    expect(got.status).toBe(200);

    await caller.delete({ attachmentId: init.attachmentId });
    const listAfter = await caller.list({
      targetType: "issue",
      targetId: issue.id,
    });
    expect(listAfter).toHaveLength(0);
  });

  it("rejects init for targets outside the workspace", async () => {
    const { caller } = await setup();
    await expect(
      caller.initUpload({
        targetType: "issue",
        // Well-formed but non-existent cuid.
        targetId: "clxxxxxxxxxxxxxxxxxxxxxxx",
        filename: "x.txt",
        mimeType: "text/plain",
        size: 10,
      }),
    ).rejects.toThrow();
  });

  it("listForWorkspace returns quota + attachments for admins", async () => {
    const { caller, fixture } = await setup();
    const issue = await createIssue(fixture);
    const body = Buffer.from("z", "utf8");
    const init = await caller.initUpload({
      targetType: "issue",
      targetId: issue.id,
      filename: "z.txt",
      mimeType: "text/plain",
      size: body.byteLength,
    });
    await putBytes(init.uploadUrl, body, "text/plain");
    await caller.finalize({ attachmentId: init.attachmentId });

    const rollup = await caller.listForWorkspace();
    expect(rollup.attachments.length).toBe(1);
    expect(rollup.quotaBytes).toBe(
      fixture.workspace.attachmentQuotaMb * 1024 * 1024,
    );
    expect(rollup.usedBytes).toBeGreaterThan(0);
  });
});
