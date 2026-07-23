import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssueReference } from "@/components/issue-reference";

const issue = {
  id: "issue-143",
  number: 143,
  title: "Surface actionable status on issues",
  workspace: { key: "AXI", slug: "axiom-labs" },
};

describe("IssueReference", () => {
  it("pairs a scannable identifier with the human-readable issue title", () => {
    const html = renderToStaticMarkup(React.createElement(IssueReference, { issue }));

    expect(html).toContain("AXI-143");
    expect(html).toContain("Surface actionable status on issues");
    expect(html).toContain('aria-label="AXI-143: Surface actionable status on issues"');
  });

  it("links the complete issue identity when an href is supplied", () => {
    const html = renderToStaticMarkup(
      React.createElement(IssueReference, {
        issue,
        href: "/w/axiom-labs/issues/issue-143",
      }),
    );

    expect(html).toContain('href="/w/axiom-labs/issues/issue-143"');
    expect(html).toContain("AXI-143");
    expect(html).toContain("Surface actionable status on issues");
  });
});
