import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Symmetric secret encryption for values that must round-trip back to
 * plaintext server-side (unlike API-key hashes, which are one-way).
 *
 * Used for {@link SsoProvider.clientSecret}: OAuth/OIDC client secrets have
 * to be sent to the IdP at sign-in time, so they can't be hashed — but they
 * must never sit in the DB (or leak to the client) in the clear.
 *
 * AES-256-GCM with a per-value random 12-byte IV. The 32-byte key is derived
 * from `AUTH_SECRET` (the same secret NextAuth signs sessions with) via
 * SHA-256, so there's no new key to manage. Rotating `AUTH_SECRET` therefore
 * invalidates stored secrets — re-enter them in the admin UI after rotation.
 *
 * Wire format: `base64(iv) : base64(authTag) : base64(ciphertext)`.
 */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required to encrypt/decrypt provider secrets.");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed encrypted secret.");
  }
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}
