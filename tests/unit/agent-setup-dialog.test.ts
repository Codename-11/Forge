import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({
  default: (props: React.ComponentProps<"a">) => React.createElement("a", props),
}));
vi.mock("@/components/ui/modal", () => ({
  CenterModal: ({
    children,
    footer,
    title,
  }: {
    children: React.ReactNode;
    footer: React.ReactNode;
    title: string;
  }) => React.createElement("section", {}, title, children, footer),
}));
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ ariaLabel }: { ariaLabel: string }) =>
    React.createElement("button", { "aria-label": ariaLabel }),
}));
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const { AgentSetupDialog } = await import("@/app/(app)/settings/agents/agent-setup-dialog");
const render = (mode: "external" | "managed", role = "OWNER") =>
  renderToStaticMarkup(
    React.createElement(AgentSetupDialog, {
      mode,
      workspaces: [{ id: "ws-one", slug: "forge", name: "Forge", key: "FRG", role }],
      profiles: [],
      isInstanceAdmin: true,
      onClose: vi.fn(),
      onCreate: vi.fn(),
    }),
  );
describe("agent setup entry choices", () => {
  it("opens managed setup on host registration even with no identities", () => {
    const html = render("managed");
    expect(html).toContain("Connect a runtime");
    expect(html).toContain("Configure an agent");
    expect(html).toContain("/w/forge/settings/runtimes?create=1");
    expect(html).not.toContain('aria-label="Setup agent identity"');
    expect(html).not.toContain("issued key");
  });
  it("does not offer a registration link to a workspace member", () => {
    expect(render("managed", "MEMBER")).not.toContain('href="/w/forge/settings/runtimes');
    expect(render("managed", "MEMBER")).toContain("requires an owner or admin");
  });
  it("keeps personal MCP setup available without an agent or runtime", () => {
    const html = render("external");
    expect(html).toContain("/w/forge/settings/access?create=personal");
    expect(html).toContain("agent identity is optional");
    expect(html).not.toContain("managed-setup-task");
  });
});
