import { describe, expect, it } from "vitest";
import {
  PASSWORD_HASH_PREFIX,
  hashPassword,
  needsPasswordRehash,
  verifyPassword,
  verifyPasswordOrDummy,
} from "@/server/services/local-credentials";

describe("local credential hashing", () => {
  it("creates salted, versioned scrypt hashes and verifies the right password", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect(first).toContain("$n=32768,r=8,p=3$");
    expect(second).not.toBe(first);
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
    expect(needsPasswordRehash(first)).toBe(false);
    expect(needsPasswordRehash(first.replace("p=3", "p=1"))).toBe(true);
  });

  it("fails closed for malformed hashes and executes the dummy path", async () => {
    await expect(verifyPassword("password", "not-a-forge-hash")).resolves.toBe(false);
    await expect(verifyPasswordOrDummy("password", null)).resolves.toBe(false);
    await expect(verifyPasswordOrDummy("password", "not-a-forge-hash")).resolves.toBe(false);
    expect(needsPasswordRehash("not-a-forge-hash")).toBe(true);
  });

  it("rejects empty and unreasonably large password inputs", async () => {
    await expect(hashPassword("")).rejects.toThrow(/must not be empty/i);
    await expect(hashPassword("x".repeat(5000))).rejects.toThrow(/too long/i);
  });
});
