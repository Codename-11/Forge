import { describe, it, expect } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "@/server/services/plugin-runtime";

describe("webhook signing", () => {
  it("round-trips a signature", () => {
    const secret = "shh";
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ ok: true });
    const sig = signWebhookBody(secret, ts, body);
    expect(verifyWebhookSignature(secret, ts, body, sig)).toBe(true);
  });

  it("rejects tampered bodies", () => {
    const secret = "shh";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhookBody(secret, ts, "a");
    expect(verifyWebhookSignature(secret, ts, "b", sig)).toBe(false);
  });

  it("rejects old timestamps", () => {
    const secret = "shh";
    const ts = String(Math.floor(Date.now() / 1000) - 10_000);
    const sig = signWebhookBody(secret, ts, "ok");
    expect(verifyWebhookSignature(secret, ts, "ok", sig, 300)).toBe(false);
  });
});
