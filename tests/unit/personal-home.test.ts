import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => ({
  data: [] as unknown[],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({ trpc: { global: { work: { useQuery: () => query } } } }));
vi.mock("@/components/global-shell/global-shell", () => ({ WorkspaceBadge: () => null }));
vi.mock("@/components/reminders/reminder-inbox", () => ({
  ReminderInbox: () => React.createElement("section", { "aria-label": "Your reminders" }),
}));
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const { PersonalHome } = await import("@/components/global-shell/personal-home");

const workspace = { id: "ws-1", slug: "forge", name: "Forge", key: "FRG" };
const render = () =>
  renderToStaticMarkup(React.createElement(PersonalHome, { workspaces: [workspace] }));

describe("Personal Home", () => {
  beforeEach(() => {
    query.data = [];
    query.isLoading = false;
    query.isError = false;
  });

  it("offers everyday work without managed runtime setup", () => {
    const html = render();
    expect(html).toContain("No open assignments");
    expect(html).toContain('aria-label="Your reminders"');
    expect(html).toContain('href="/workspaces"');
    expect(html).toContain('href="/w/forge"');
    expect(html).toContain('href="/inbox"');
    expect(html).not.toContain("Register runtime");
  });

  it("renders the full issue key, title and owning workspace destination", () => {
    query.data = [
      {
        id: "issue-1",
        number: 20,
        title: "Improve onboarding",
        workspace,
        status: { name: "In progress" },
      },
    ];
    const html = render();
    expect(html).toContain("FRG-20");
    expect(html).toContain("Improve onboarding");
    expect(html).toContain('href="/w/forge/issues/issue-1"');
    expect(html).toContain("In progress");
  });

  it("caps the initial assignment list and offers expansion", () => {
    query.data = Array.from({ length: 10 }, (_, index) => ({
      id: `issue-${index}`,
      number: index,
      title: `Task ${index}`,
      workspace,
      status: { name: "Todo" },
    }));
    const html = render();
    expect(html).toContain("Task 7");
    expect(html).not.toContain("Task 8");
    expect(html).toContain("Show 2 more");
    expect(html).toContain('aria-expanded="false"');
  });

  it("keeps workspace navigation available if assignments fail", () => {
    query.isError = true;
    const html = render();
    expect(html).toContain("Assignments are unavailable");
    expect(html).toContain("Try again");
    expect(html).toContain('href="/w/forge"');
    expect(html).not.toContain("No open assignments");
  });
});
