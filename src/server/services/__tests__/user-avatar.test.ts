import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  finalizeUserAvatar,
  getUserAvatarState,
  presignUserAvatarUpload,
  readUserAvatar,
  removeUserAvatar,
} from "@/server/services/user-avatar";
import { _resetS3ClientForTests } from "@/server/services/storage";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { describeIfMinio } from "@/server/routers/__tests__/minio-probe";

const fixtures: TestFixture[] = [];
const { describe } = await describeIfMinio();

beforeAll(() => {
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "forge_minio_admin";
  process.env.S3_SECRET_KEY =
    process.env.S3_SECRET_KEY ?? "c3ac4bd95c05c7d809f9b0e97a800d6d4c60f06c";
  process.env.S3_FORCE_PATH_STYLE = "true";
  process.env.S3_GLOBAL_BUCKET = "forge-test-global";
  _resetS3ClientForTests();
});

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await removeUserAvatar(fixture.user.id).catch(() => undefined);
    await removeUserAvatar(fixture.secondUser.id).catch(() => undefined);
    await fixture.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function fixture(): Promise<TestFixture> {
  const next = await createWorkspaceFixture({ keyPrefix: "AV" });
  fixtures.push(next);
  return next;
}

async function put(url: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: Buffer.from(bytes),
  });
  if (!response.ok)
    throw new Error(`Avatar PUT failed: ${response.status} ${await response.text()}`);
}

describe("user avatar service", () => {
  it("uploads, validates, serves, and removes a global user avatar", async () => {
    const current = await fixture();
    const providerImage = "https://avatars.example.com/provider-user.png";
    await getPrisma().user.update({
      where: { id: current.user.id },
      data: { image: providerImage },
    });
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const init = await presignUserAvatarUpload({
      userId: current.user.id,
      contentType: "image/png",
      sizeBytes: bytes.byteLength,
    });
    expect(init.objectKey).toMatch(new RegExp(`^avatar-uploads/${current.user.id}/`));
    await put(init.uploadUrl, bytes, init.headers["Content-Type"]);

    const finalized = await finalizeUserAvatar({
      userId: current.user.id,
      objectKey: init.objectKey,
    });
    expect(finalized.url).toContain(`/api/avatar/${current.user.id}`);

    const state = await getUserAvatarState(current.user.id);
    expect(state.hasLocalAvatar).toBe(true);
    expect(state.resolvedImage).toBe(state.avatarUrl);
    expect(state.fallbackImage).toBe(providerImage);
    await expect(
      getPrisma().user.findUniqueOrThrow({
        where: { id: current.user.id },
        select: { image: true },
      }),
    ).resolves.toEqual({ image: `/api/avatar/${current.user.id}` });
    const stored = await readUserAvatar(current.user.id);
    expect(stored?.contentType).toBe("image/png");
    expect(stored?.bytes).toEqual(bytes);

    await expect(removeUserAvatar(current.user.id)).resolves.toEqual({ removed: true });
    const fallback = await getUserAvatarState(current.user.id);
    expect(fallback.hasLocalAvatar).toBe(false);
    expect(fallback.resolvedImage).toBe(providerImage);
  });

  it("rejects spoofed image content and a different user's upload key", async () => {
    const current = await fixture();
    const spoof = Buffer.from("not really a png");
    const init = await presignUserAvatarUpload({
      userId: current.user.id,
      contentType: "image/png",
      sizeBytes: spoof.byteLength,
    });
    await put(init.uploadUrl, spoof, init.headers["Content-Type"]);

    await expect(
      finalizeUserAvatar({ userId: current.user.id, objectKey: init.objectKey }),
    ).rejects.toThrow(/does not match/i);
    await expect(
      finalizeUserAvatar({ userId: current.secondUser.id, objectKey: init.objectKey }),
    ).rejects.toThrow(/does not belong/i);
  });
});
