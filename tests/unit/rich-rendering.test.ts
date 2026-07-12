import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PreviewControlState } from "@/components/markdown/attachment-renderer";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    attachment: {
      getDownloadUrl: {
        useQuery: () => ({ data: null, isLoading: false, error: null }),
      },
    },
    embed: {
      fetch: {
        useQuery: () => ({ data: null, isLoading: false, error: null }),
      },
    },
  },
}));

vi.mock("@/hooks/use-workspace", () => ({
  useMaybeWorkspace: () => null,
}));

vi.mock("@/components/attachments/attachment-lightbox", () => ({
  useAttachmentLightbox: () => ({ openLightbox: vi.fn() }),
}));

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { RichContentRenderer, reducePreviewControlState } =
  await import("@/components/markdown/attachment-renderer");

function render(body: string): string {
  return renderToStaticMarkup(React.createElement(RichContentRenderer, { body }));
}

describe("RichContentRenderer rich link and media behavior", () => {
  it("renders plain text without inventing link or media previews", () => {
    const html = render("Plain release note with no URLs.");

    expect(html).toContain("Plain release note with no URLs.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
  });

  it("promotes image and video URLs to direct media previews", () => {
    const imageHtml = render("https://cdn.example.com/screenshot.png?token=abc");
    const videoHtml = render("https://cdn.example.com/demo.webm");

    expect(imageHtml).toContain("Image preview");
    expect(imageHtml).toContain("<img");
    expect(imageHtml).toContain('src="https://cdn.example.com/screenshot.png?token=abc"');
    expect(videoHtml).toContain("Video preview");
    expect(videoHtml).toContain("<video");
    expect(videoHtml).toContain('src="https://cdn.example.com/demo.webm"');
  });

  it("renders known video URLs as preview cards", () => {
    const html = render("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    expect(html).toContain("YouTube preview");
    expect(html).toContain("youtube.com");
    expect(html).toContain("Play YouTube video");
    expect(html).toContain("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  it("keeps normal prose links inline and supports multiple links", () => {
    const html = render(
      "Compare https://example.com/docs with https://forge.axiom-labs.dev/w/axiom.",
    );

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="https://forge.axiom-labs.dev/w/axiom"');
    expect(html).not.toContain("Image preview");
    expect(html).not.toContain("Video preview");
    expect(html).not.toContain("YouTube preview");
  });

  it("falls back safely for unsupported and malformed URLs", () => {
    const unsupported = render("https://example.com/download.txt");
    const malformed = render("https://[not-valid]");

    expect(unsupported).toContain('href="https://example.com/download.txt"');
    expect(unsupported).not.toContain("preview");
    expect(malformed).toContain("https://[not-valid");
    expect(malformed).toContain("]</p>");
    expect(malformed).not.toContain("<iframe");
    expect(malformed).not.toContain("<img");
    expect(malformed).not.toContain("<video");
  });

  it("does not render scriptable markdown link hrefs", () => {
    const html = render(
      "[safe](https://example.com) [mail](mailto:team@example.com) [bad](javascript:alert(1))",
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:team@example.com"');
    expect(html).toContain("bad)");
    expect(html).not.toContain("javascript:");
  });

  it("labels preview action controls for assistive technology", () => {
    const html = render("https://cdn.example.com/screenshot.png");
    const source = readFileSync(
      resolve(process.cwd(), "src/components/markdown/attachment-renderer.tsx"),
      "utf8",
    );

    expect(html).toContain('aria-label="Image preview actions"');
    expect(source).toContain('aria-label={collapsed ? "Expand preview" : "Collapse preview"}');
    expect(source).toContain("aria-label={`Open ${host} in a new tab`}");
    expect(source).toContain('aria-label="Hide preview"');
  });
});

describe("rich preview control state", () => {
  it("collapses, hides, and restores previews through the reducer", () => {
    const start: PreviewControlState = {
      hidden: false,
      collapsed: false,
      menuOpen: false,
    };

    const menuOpen = reducePreviewControlState(start, { type: "toggleMenu" });
    expect(menuOpen).toEqual({ hidden: false, collapsed: false, menuOpen: true });

    const collapsed = reducePreviewControlState(menuOpen, {
      type: "toggleCollapsed",
    });
    expect(collapsed).toEqual({
      hidden: false,
      collapsed: true,
      menuOpen: false,
    });

    const hidden = reducePreviewControlState(collapsed, { type: "hide" });
    expect(hidden).toEqual({ hidden: true, collapsed: true, menuOpen: false });

    expect(reducePreviewControlState(hidden, { type: "show" })).toEqual(start);
  });
});

describe("issue detail rich rendering integration", () => {
  it("routes issue descriptions and comments through RichContentRenderer", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/issue-detail/issue-main.tsx"),
      "utf8",
    );

    expect(source).toContain("<RichContentRenderer body={description} />");
    expect(source).toContain("body={comment.body}");
  });
});
