import { describe, it, expect, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { publicOrigin } from "@/server/integrations/public-origin";

function fakeReq(headers: Record<string, string>, url = "https://0.0.0.0:3000/api/x"): NextRequest {
  return {
    url,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("publicOrigin", () => {
  it("prefers X-Forwarded-Host/-Proto over the internal request origin", () => {
    const req = fakeReq({
      "x-forwarded-host": "forge.axiom-labs.dev",
      "x-forwarded-proto": "https",
    });
    expect(publicOrigin(req)).toBe("https://forge.axiom-labs.dev");
  });

  it("takes the first value from comma-listed forwarded headers", () => {
    const req = fakeReq({
      "x-forwarded-host": "forge.axiom-labs.dev, internal",
      "x-forwarded-proto": "https, http",
    });
    expect(publicOrigin(req)).toBe("https://forge.axiom-labs.dev");
  });

  it("falls back to NEXT_PUBLIC_APP_URL when no forwarded host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://forge.example.com/";
    expect(publicOrigin(fakeReq({}))).toBe("https://forge.example.com");
  });

  it("falls back to the raw request origin as a last resort", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.AUTH_URL;
    expect(publicOrigin(fakeReq({}, "https://host:3000/api/x"))).toBe("https://host:3000");
  });
});
