import { it, expect, afterAll, afterEach, beforeAll } from "vitest";
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
  getPrisma,
  type TestFixture,
} from "./helpers";
import { describeIfMinio } from "./minio-probe";

const fixtures: TestFixture[] = [];

// Probe MinIO once per file. When the dev container isn't running, swap
// `describe` for `describe.skip` so the suite reports "skipped" instead
// of dozens of ECONNREFUSED failures.
const { describe } = await describeIfMinio();

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
  it("allows chat-message uploads for the owning human thread", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: { workspaceId: fixture.workspace.id, profileKey: `chat-${Date.now()}`, name: "Chat Agent" },
    });
    const thread = await prisma.chatThread.create({
      data: { workspaceId: fixture.workspace.id, userId: fixture.user.id, agentId: agent.id },
    });
    const message = await prisma.chatMessage.create({
      data: { workspaceId: fixture.workspace.id, threadId: thread.id, role: "USER", body: "with file" },
    });

    const init = await caller.initUpload({
      targetType: "chat-message",
      targetId: message.id,
      filename: "chat.txt",
      mimeType: "text/plain",
      size: 4,
    });
    expect(init.attachmentId).toBeTruthy();

    const link = await caller.attachLink({
      targetType: "chat-message",
      targetId: message.id,
      url: "https://example.com/context",
      title: "Context link",
    });
    const rows = await caller.list({ targetType: "chat-message", targetId: message.id });
    expect(rows.map((r) => r.id)).toContain(link.id);
  });

  it("rejects chat-message uploads from other thread participants", async () => {
    const { fixture } = await setup();
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: { workspaceId: fixture.workspace.id, profileKey: `chatx-${Date.now()}`, name: "Chat Agent" },
    });
    const thread = await prisma.chatThread.create({
      data: { workspaceId: fixture.workspace.id, userId: fixture.user.id, agentId: agent.id },
    });
    const message = await prisma.chatMessage.create({
      data: { workspaceId: fixture.workspace.id, threadId: thread.id, role: "USER", body: "owned by user1" },
    });
    const otherCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const otherCaller = attachmentRouter.createCaller(otherCtx);

    await expect(
      otherCaller.initUpload({
        targetType: "chat-message",
        targetId: message.id,
        filename: "leak.txt",
        mimeType: "text/plain",
        size: 4,
      }),
    ).rejects.toThrow(/thread owner|agent/i);
  });

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
