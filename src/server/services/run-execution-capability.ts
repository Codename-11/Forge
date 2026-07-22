import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CAPABILITY_PREFIX = "frun_";

export function hashRunExecutionCapability(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function issueRunExecutionCapability(): { raw: string; hash: string } {
  const raw = `${CAPABILITY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashRunExecutionCapability(raw) };
}

export function verifyRunExecutionCapability(raw: string | null | undefined, hash: string | null) {
  if (!raw || !hash) return false;
  const supplied = Buffer.from(hashRunExecutionCapability(raw), "hex");
  const expected = Buffer.from(hash, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
