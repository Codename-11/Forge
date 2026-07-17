import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";

(globalThis as unknown as { React: typeof React }).React = React;

function renderMarkdown(body: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownWithAttachments, { body }));
}

describe("MarkdownWithAttachments URL safety", () => {
  it("renders safe external markdown links as new-tab anchors", () => {
    const html = renderMarkdown("[Example](https://example.com/docs)");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Example");
  });

  it("renders internal app paths as internal links", () => {
    const html = renderMarkdown("[Issue](/w/axiom-labs/issues/AXI-85)");

    expect(html).toContain('href="/w/axiom-labs/issues/AXI-85"');
    expect(html).toContain("Issue");
    expect(html).not.toContain('target="_blank"');
  });

  it("renders the complete compact GitHub reference instead of splitting at the slash", () => {
    const html = renderMarkdown("Merged PR CODENAME-11/Forge#56 recommends completion.");

    expect(html).toContain('href="https://github.com/CODENAME-11/Forge/issues/56"');
    expect(html).toContain(">CODENAME-11/Forge#56</a>");
    expect(html).not.toContain("/issues/CODENAME-11");
  });

  it("keeps issue-looking tokens inside bare URLs clickable as one URL", () => {
    const url = "https://forge.example/w/acme/issues/AXI-123";
    const html = renderMarkdown(`Inspect ${url} before closing.`);

    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`>${url}</a>`);
    expect(html).not.toContain('href="/issues/AXI-123"');
  });

  it("does not render javascript or data markdown links as clickable hrefs", () => {
    const jsHtml = renderMarkdown("[bad](javascript:alert(1))");
    const dataHtml = renderMarkdown("[bad](data:text/html,<h1>x</h1>)");

    expect(jsHtml).toContain("bad");
    expect(jsHtml).not.toContain("javascript:alert");
    expect(jsHtml).not.toContain("<a ");
    expect(dataHtml).toContain("bad");
    expect(dataHtml).not.toContain("data:text/html");
    expect(dataHtml).not.toContain("<a ");
  });

  it("keeps forge-link chips limited to http(s)", () => {
    const html = renderMarkdown(
      "[good](forge-link:https://example.com) [bad](forge-link:javascript:alert(1))",
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("good");
    expect(html).toContain("forge-link:javascript:alert(1)");
    expect(html).not.toContain('href="javascript:alert');
  });
});
