import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  attachments: { data: [] as unknown[], isLoading: false, isError: false, refetch: vi.fn() },
  relations: {
    data: {} as Record<string, unknown[]>,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  role: "OWNER",
  mutate: vi.fn(),
}));

vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ key: "FRG", slug: "forge", role: state.role }),
}));
vi.mock("@/components/attachments/attachment-lightbox", () => ({
  useAttachmentLightbox: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/attachments/attachment-chip", () => ({ LinkFavicon: () => null }));
vi.mock("@/components/ui/modal", () => ({ Confirm: () => null }));
vi.mock("@/components/relations/issue-relations-graph", () => ({
  IssueRelationsGraph: () => null,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    attachment: {
      list: { useQuery: () => state.attachments },
      getDownloadUrl: { useQuery: () => ({ data: { url: "/test-thumbnail.png" } }) },
      initUpload: { useMutation: () => ({ mutate: state.mutate }) },
      finalize: { useMutation: () => ({ mutate: state.mutate }) },
      attachLink: { useMutation: () => ({ mutate: state.mutate }) },
      delete: { useMutation: () => ({ mutate: state.mutate }) },
    },
    relation: {
      listForIssue: { useQuery: () => state.relations },
      remove: { useMutation: () => ({ mutate: state.mutate }) },
    },
  },
}));

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const { IssueAttachmentsPanel } = await import("@/components/attachments/issue-attachments-panel");
const { IssueRelationsPanel } = await import("@/components/relations/issue-relations-panel");

const renderAttachments = () =>
  renderToStaticMarkup(React.createElement(IssueAttachmentsPanel, { issueId: "issue-1" }));
const renderRelations = (props = {}) =>
  renderToStaticMarkup(React.createElement(IssueRelationsPanel, { issueId: "issue-1", ...props }));
const relation = (index: number, statusCategory = "TODO") => ({
  relationId: `relation-${index}`,
  target: { id: `issue-${index}`, number: index, title: `Related task ${index}`, statusCategory },
});

beforeEach(() => {
  state.attachments.data = [];
  state.attachments.isLoading = false;
  state.attachments.isError = false;
  state.relations.data = {};
  state.relations.isLoading = false;
  state.relations.isError = false;
  state.role = "OWNER";
  state.mutate.mockClear();
});

describe("inline issue attachments", () => {
  it("keeps Add file discoverable in the compact empty state", () => {
    const html = renderAttachments();
    expect(html).toContain('id="issue-attachments"');
    expect(html).toContain("Add file");
    expect(html).toContain("No files attached");
    expect(html).not.toContain("paste from clipboard");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("caps the visible file strip without hiding its total or expansion", () => {
    state.attachments.data = Array.from({ length: 6 }, (_, index) => ({
      id: `attachment-${index}`,
      filename: `document-${index}.pdf`,
      mimeType: "application/pdf",
      size: 2048,
    }));
    const html = renderAttachments();
    expect(html).toContain("document-3.pdf");
    expect(html).not.toContain("document-4.pdf");
    expect(html).toContain("View all attachments (6)");
    expect(html).toContain('aria-controls="attachment-list-issue-1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("2.0 KB");
  });

  it("keeps image names visible and exposes preview/delete to keyboard users", () => {
    state.attachments.data = [
      { id: "image-1", filename: "Kitchen plan.png", mimeType: "image/png", size: 100 },
    ];
    const html = renderAttachments();
    expect(html).toContain('aria-label="Preview attachment: Kitchen plan.png"');
    expect(html).toContain('aria-label="Delete attachment: Kitchen plan.png"');
    expect(html).toContain("Kitchen plan.png</div>");
    expect(html).not.toContain("opacity-0");
    state.role = "MEMBER";
    expect(renderAttachments()).not.toContain('aria-label="Delete attachment:');
  });

  it("distinguishes load failure from no attachments and offers retry", () => {
    state.attachments.isError = true;
    const html = renderAttachments();
    expect(html).toContain("Attachments could not be loaded");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No files attached");
  });
});

describe("visible related work", () => {
  it("surfaces parent and subtasks without inventing a status or count", () => {
    const html = renderRelations({
      parentIssue: { id: "parent-1", number: 10, title: "Prepare home office" },
    });
    expect(html).toContain("Prepare home office");
    expect(html).toContain("FRG-10");
    expect(html).toContain('href="/w/forge/issues/parent-1"');
    expect(html).toContain('href="#issue-subtasks"');
    expect(html).toContain("View or add");
    expect(html).not.toContain("0 · View or add");
  });

  it("prioritizes blockers with readable status and issue titles", () => {
    state.relations.data = {
      BLOCKS: [relation(2, "IN_PROGRESS")],
      BLOCKED_BY: [relation(1, "BLOCKED")],
    };
    const html = renderRelations();
    expect(html.indexOf("Related task 1")).toBeLessThan(html.indexOf("Related task 2"));
    expect(html).toContain("In progress");
    expect(html).toContain("Blocked");
    expect(html).toContain('aria-label="Remove blocked by relation: FRG-1 Related task 1"');
    expect(html).not.toContain('role="tablist"');
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("caps each relation group and makes overflow discoverable", () => {
    state.relations.data = { RELATES_TO: Array.from({ length: 5 }, (_, index) => relation(index)) };
    const html = renderRelations();
    expect(html).toContain("Related task 2");
    expect(html).not.toContain("Related task 3");
    expect(html).toContain("View all related to (5)");
    expect(html).toContain('aria-controls="relations-issue-1-RELATES_TO"');
    expect(html).toContain("Explore dependency map");
  });

  it("keeps parent navigation when relation loading fails", () => {
    state.relations.isError = true;
    const html = renderRelations({
      parentIssue: { id: "parent-1", number: 10, title: "Parent title" },
    });
    expect(html).toContain("Parent title");
    expect(html).toContain("Related work could not be loaded");
    expect(html).not.toContain("No linked issues");
  });
});
