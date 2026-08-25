import { describe, expect, it } from "vitest";
import { authPath, safeAuthCallbackUrl } from "@/lib/auth-callback";

describe("safeAuthCallbackUrl", () => {
  it("preserves local paths, queries, and fragments", () => {
    expect(safeAuthCallbackUrl("/invite/example?source=email#accept")).toBe(
      "/invite/example?source=email#accept",
    );
  });

  it.each([
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "javascript:alert(1)",
    "dashboard",
  ])("rejects a non-local callback: %s", (value) => {
    expect(safeAuthCallbackUrl(value)).toBe("/dashboard");
  });

  it("uses the dashboard for missing or malformed callbacks", () => {
    expect(safeAuthCallbackUrl(undefined)).toBe("/dashboard");
    expect(safeAuthCallbackUrl("/%")).toBe("/%");
  });

  it("builds an encoded local auth path", () => {
    expect(authPath("/signin/local", "/w/forge/dashboard?from=invite")).toBe(
      "/signin/local?callbackUrl=%2Fw%2Fforge%2Fdashboard%3Ffrom%3Dinvite",
    );
  });
});
