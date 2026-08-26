import { describe, expect, it } from "vitest";
import {
  detectAvatarMimeType,
  globalStorageBucket,
  MAX_AVATAR_SIZE_BYTES,
} from "@/server/services/user-avatar";

describe("user avatar validation", () => {
  it.each([
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["JPEG", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    ["GIF87a", [...Buffer.from("GIF87a")], "image/gif"],
    ["GIF89a", [...Buffer.from("GIF89a")], "image/gif"],
    ["WebP", [...Buffer.from("RIFF0000WEBP")], "image/webp"],
  ])("detects %s signatures", (_label, bytes, expected) => {
    expect(detectAvatarMimeType(Uint8Array.from(bytes as number[]))).toBe(expected);
  });

  it("rejects executable, SVG, and truncated content", () => {
    expect(detectAvatarMimeType(Buffer.from("<svg><script>alert(1)</script></svg>"))).toBeNull();
    expect(detectAvatarMimeType(Buffer.from("MZ executable"))).toBeNull();
    expect(detectAvatarMimeType(Uint8Array.from([0x89, 0x50]))).toBeNull();
  });

  it("uses a dedicated configurable global bucket", () => {
    const previous = process.env.S3_GLOBAL_BUCKET;
    try {
      delete process.env.S3_GLOBAL_BUCKET;
      expect(globalStorageBucket()).toBe("forge-global");
      process.env.S3_GLOBAL_BUCKET = "forge-identity-assets";
      expect(globalStorageBucket()).toBe("forge-identity-assets");
      process.env.S3_GLOBAL_BUCKET = "INVALID_BUCKET";
      expect(() => globalStorageBucket()).toThrow(/valid S3 bucket/i);
    } finally {
      if (previous === undefined) delete process.env.S3_GLOBAL_BUCKET;
      else process.env.S3_GLOBAL_BUCKET = previous;
    }
  });

  it("keeps the upload cap bounded to five MiB", () => {
    expect(MAX_AVATAR_SIZE_BYTES).toBe(5 * 1024 * 1024);
  });
});
