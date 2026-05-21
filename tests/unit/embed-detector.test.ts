import { describe, expect, it } from "vitest";
import { matchEmbedUrl } from "@/components/embeds/embed-detector";

/**
 * URL pattern matcher for inline embeds. The renderer runs this on
 * every lone URL it encounters; keep the matcher cheap and explicit
 * so we know exactly which URLs become embed cards.
 */
describe("matchEmbedUrl", () => {
  it("matches a youtube watch URL", () => {
    const m = matchEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(m?.kind).toBe("youtube");
    if (m?.kind === "youtube") {
      expect(m.payload.videoId).toBe("dQw4w9WgXcQ");
    }
  });

  it("matches a youtu.be short URL", () => {
    const m = matchEmbedUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(m?.kind).toBe("youtube");
  });

  it("matches a youtube /embed URL", () => {
    const m = matchEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(m?.kind).toBe("youtube");
  });

  it("matches a github pull URL", () => {
    const m = matchEmbedUrl("https://github.com/anthropic/forge/pull/123");
    expect(m?.kind).toBe("github");
    if (m?.kind === "github") {
      expect(m.payload.owner).toBe("anthropic");
      expect(m.payload.repo).toBe("forge");
      expect(m.payload.number).toBe(123);
      expect(m.payload.type).toBe("pull");
    }
  });

  it("matches a github issue URL", () => {
    const m = matchEmbedUrl("https://github.com/foo/bar/issues/7");
    expect(m?.kind).toBe("github");
    if (m?.kind === "github") {
      expect(m.payload.type).toBe("issue");
      expect(m.payload.number).toBe(7);
    }
  });

  it("matches a loom share URL", () => {
    const m = matchEmbedUrl(
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
    );
    expect(m?.kind).toBe("loom");
  });

  it("matches a figma file URL and builds an embed_host URL", () => {
    const m = matchEmbedUrl(
      "https://www.figma.com/file/AbCdEf/My-Design",
    );
    expect(m?.kind).toBe("figma");
    if (m?.kind === "figma") {
      expect(m.payload.embedUrl).toContain("figma.com/embed");
      expect(m.payload.embedUrl).toContain("embed_host=forge");
      expect(m.payload.embedUrl).toContain(
        encodeURIComponent("https://www.figma.com/file/AbCdEf/My-Design"),
      );
    }
  });

  it("returns null for unsupported URLs", () => {
    expect(matchEmbedUrl("https://example.com/")).toBeNull();
    expect(matchEmbedUrl("https://github.com/foo/bar")).toBeNull();
    expect(matchEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(matchEmbedUrl("not a url")).toBeNull();
  });

  it("does not match github tree/blob URLs", () => {
    expect(
      matchEmbedUrl("https://github.com/anthropic/forge/tree/main"),
    ).toBeNull();
    expect(
      matchEmbedUrl("https://github.com/anthropic/forge/blob/main/README.md"),
    ).toBeNull();
  });
});
