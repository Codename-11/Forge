import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessions: [] as unknown[],
  links: [] as unknown[],
  deliveryError: false,
  githubError: false,
  mutate: vi.fn(),
}));
vi.mock("@/hooks/use-workspace", () => ({ useWorkspace: () => ({ role: "OWNER" }) }));
vi.mock("@/lib/trpc", () => {
  const mutation = { useMutation: () => ({ mutate: state.mutate, isPending: false }) };
  return {
    trpc: {
      useUtils: () => ({}),
      workSession: {
        listForIssue: {
          useQuery: () => ({
            data: state.sessions,
            isLoading: false,
            isError: state.deliveryError,
          }),
        },
        claim: mutation,
        heartbeat: mutation,
        advance: mutation,
        reconcileOwnership: mutation,
      },
      github: {
        listLinked: {
          useQuery: () => ({ data: state.links, isLoading: false, isError: state.githubError }),
        },
        listMappings: { useQuery: () => ({ data: [] }) },
        sync: mutation,
      },
      system: { buildInfo: { useQuery: () => ({ data: {} }) } },
    },
  };
});
vi.mock("@/components/issue-detail/github-link-modal", () => ({
  GitHubLinkModal: ({ defaultKind }: { defaultKind?: string }) =>
    React.createElement("span", { "data-default-link-kind": defaultKind, hidden: true }),
}));
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const { IssueAutomationPanel } = await import("@/components/issue-detail/issue-automation-panel");
const { WorkCoordinationPanel } = await import("@/components/issue-detail/work-coordination-panel");

const render = (children?: React.ReactNode) =>
  renderToStaticMarkup(
    React.createElement(
      IssueAutomationPanel,
      {
        issueId: "issue-1",
        issueKey: "FRG-20",
        onAskAgent: state.mutate,
        onAssignAgent: state.mutate,
      },
      children,
    ),
  );

describe("issue automation entry point", () => {
  beforeEach(() => {
    state.sessions = [];
    state.links = [];
    state.deliveryError = false;
    state.githubError = false;
    state.mutate.mockClear();
  });

  it("keeps an empty issue's entry point discoverable without empty delivery and GitHub cards", () => {
    const html = render();
    expect(html).toContain("Automation &amp; delivery");
    expect(html).toContain("Add agent or delivery…");
    expect(html).toContain("Ask an agent");
    expect(html).toContain("Assign an agent");
    expect(html).toContain("Discuss, Research, Review, or Execute");
    expect(html).toContain("Start delivery session");
    expect(html).not.toContain('aria-label="Code work coordination"');
    expect(html).not.toContain('id="github-links"');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("opens implementation linking with the native IMPLEMENTS relation", () => {
    const html = render();
    expect(html).toContain("Link implementation PR");
    expect(html).toContain('data-default-link-kind="IMPLEMENTS"');
  });

  it("keeps workstream outcomes and required actions outside the collapsed add menu", () => {
    const html = render(React.createElement("div", null, "Waiting on you · Approve request"));
    expect(html.indexOf("Waiting on you · Approve request")).toBeGreaterThan(
      html.indexOf("</details>"),
    );
  });

  it("shows an existing delivery stage and PR while preventing a second active session", () => {
    state.sessions = [
      {
        id: "session-1",
        status: "MERGED",
        source: "MCP",
        repoFullName: "owner/repo",
        branch: "codex/frg-20",
        baseBranch: "main",
        participants: [],
        ownerAgent: { id: "agent-1", name: "Codex", profileKey: "codex" },
        ownerUser: { name: "Bailey" },
        ownerConnection: null,
        lastHeartbeatAt: new Date(),
        pullRequest: {
          url: "https://github.com/owner/repo/pull/12",
          repoFullName: "owner/repo",
          number: 12,
          state: "merged",
        },
      },
    ];
    const html = render();
    expect(html).toContain("Merged");
    expect(html).toContain("owner/repo#12");
    expect(html).toContain("This issue already has an open delivery session");
    expect(html).toContain("MCP status is unconfirmed");
    expect(html).toContain("Delivery evidence");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("keeps linked PR summary, relation and state visible while evidence stays collapsed", () => {
    state.links = [
      {
        id: "link-1",
        kind: "IMPLEMENTS",
        externalResource: {
          id: "resource-1",
          resourceType: "PULL_REQUEST",
          title: "Implement daily workflow",
          url: "https://github.com/owner/repo/pull/12",
          repoFullName: "owner/repo",
          number: 12,
          state: "merged",
          metadata: { checks: { status: "pending" } },
        },
      },
    ];
    const html = render();
    expect(html).toContain("Implement daily workflow");
    expect(html).toContain("implements");
    expect(html).toContain("merged");
    expect(html).toContain("GitHub evidence");
    expect(html).not.toContain("checks pending");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it("does not mistake failed queries for an empty issue", () => {
    state.deliveryError = true;
    state.githubError = true;
    const html = render();
    expect(html).toContain("Delivery could not be loaded");
    expect(html).toContain("GitHub links could not be loaded");
    expect(html).toContain("Existing ownership may still apply");
  });

  it("opens an explicit claim form after an earlier session is terminal without claiming on render", () => {
    state.sessions = [{ id: "old", status: "VERIFIED", source: "MANUAL", participants: [] }];
    const html = renderToStaticMarkup(
      React.createElement(WorkCoordinationPanel, {
        issueId: "issue-1",
        issueKey: "FRG-20",
        embedded: true,
        createOpen: true,
      }),
    );
    expect(html).toContain("Start delivery session");
    expect(html).toContain("Repository");
    expect(html).toContain("codex/frg-20-work");
    expect(html).toContain("Claim work");
    expect(html).not.toContain(">Verified<");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("retains the active session when ownership changes while the claim form is open", () => {
    state.sessions = [
      {
        id: "other",
        status: "IN_PROGRESS",
        source: "MANUAL",
        participants: [],
        lastHeartbeatAt: new Date(),
        branch: "existing",
      },
    ];
    const html = renderToStaticMarkup(
      React.createElement(WorkCoordinationPanel, {
        issueId: "issue-1",
        issueKey: "FRG-20",
        embedded: true,
        createOpen: true,
      }),
    );
    expect(html).toContain("In progress");
    expect(html).toContain("existing");
    expect(html).not.toContain("Claim work");
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
