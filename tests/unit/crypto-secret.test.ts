import { describe, it, expect, beforeAll } from "vitest";
import { encryptSecret, decryptSecret } from "@/server/crypto";

// AES-256-GCM round-trip for stored SSO client secrets.
describe("crypto secret encryption", () => {
  beforeAll(() => {
    process.env.AUTH_SECRET = "test-auth-secret-for-vitest-0123456789";
  });

  it("round-trips a secret through encrypt → decrypt", () => {
    const secret = "gho_SuperSecretClientSecret_!@#$%^&*()_+";
    const blob = encryptSecret(secret);
    expect(blob).not.toContain(secret); // ciphertext, not plaintext
    expect(blob.split(":")).toHaveLength(3); // iv:tag:ciphertext
    expect(decryptSecret(blob)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("rejects a tampered payload (auth tag mismatch)", () => {
    const blob = encryptSecret("tamper-me");
    const [iv, tag, ct] = blob.split(":");
    // Flip a byte in the ciphertext.
    const bad = Buffer.from(ct, "base64");
    bad[0] ^= 0xff;
    expect(() => decryptSecret([iv, tag, bad.toString("base64")].join(":"))).toThrow();
  });

  it("throws on a malformed payload", () => {
    expect(() => decryptSecret("not-a-valid-blob")).toThrow();
  });
});
