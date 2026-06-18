import { describe, expect, it } from "vitest";
import {
  assertSafeExternalUrl,
  isSafeExternalUrl,
  isSafeInternalAppPath,
  toRenderableHref,
} from "@/lib/url-safety";

describe("url safety helpers", () => {
  it("allows only http(s) external URLs", () => {
    expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
    expect(isSafeExternalUrl(" http://example.com ")).toBe(true);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeExternalUrl("mailto:ops@example.com")).toBe(false);
    expect(isSafeExternalUrl("/w/axiom-labs/issues/AXI-85")).toBe(false);
  });

  it("allows internal app paths without accepting protocol-relative URLs", () => {
    expect(isSafeInternalAppPath("/w/axiom-labs/issues/AXI-85")).toBe(true);
    expect(isSafeInternalAppPath("//evil.example/path")).toBe(false);
    expect(isSafeInternalAppPath("/\\evil.example/path")).toBe(false);
    expect(isSafeInternalAppPath("/%5cevil.example/path")).toBe(false);
  });

  it("normalizes renderable hrefs to external, internal, or inert", () => {
    expect(toRenderableHref("https://example.com")).toEqual({
      href: "https://example.com",
      kind: "external",
    });
    expect(toRenderableHref("/w/axiom-labs")).toEqual({
      href: "/w/axiom-labs",
      kind: "internal",
    });
    expect(toRenderableHref("javascript:alert(1)")).toBeNull();
    expect(toRenderableHref("data:text/html,<h1>x</h1>")).toBeNull();
  });

  it("throws a stable validation message for unsafe external URLs", () => {
    expect(assertSafeExternalUrl(" https://example.com ")).toBe("https://example.com");
    expect(() => assertSafeExternalUrl("javascript:alert(1)")).toThrow(/http or https/i);
  });
});
