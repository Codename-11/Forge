import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  data: null as null | {
    version: string;
    gitSha: string | null;
    release: string;
    buildTime: string | null;
  },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: { system: { buildInfo: { useQuery: () => ({ data: state.data }) } } },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/agents" }));
vi.mock("next/link", () => ({
  default: (props: React.ComponentProps<"a">) => React.createElement("a", props),
}));
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const { VersionChip } = await import("@/components/global-shell/version-chip");
const { AdminPage } = await import("@/components/admin-shell/admin-shell");

describe("canonical build labels", () => {
  it("uses the same real build in the admin header and footer", () => {
    state.data = {
      version: "0.36.0",
      gitSha: "ec5a989b26780a726026aa2682499f9ed634b123",
      release: "v0.36.0",
      buildTime: "2026-10-15T19:11:15Z",
    };
    const html = renderToStaticMarkup(React.createElement(AdminPage, null, "Content"));
    const visibleText = html.replace(/<[^>]*>/g, "");
    expect(visibleText.match(/v0\.36\.0/g)).toHaveLength(2);
    expect(visibleText.match(/ec5a989/g)).toHaveLength(2);
    expect(visibleText).not.toContain(state.data.gitSha);
    expect(visibleText).not.toContain("vdev");
    expect(html).toContain(`build ${state.data.gitSha}`);
    expect(html).toContain("max-w-full");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain('aria-label="Administration"');
    expect(html).toContain("overflow-y-auto");
  });
  it("does not invent a dev version while build information is unavailable", () => {
    state.data = null;
    const html = renderToStaticMarkup(React.createElement(VersionChip));
    expect(html).toContain("Forge");
    expect(html).not.toContain("vdev");
  });
  it("supports a version without a stamped commit", () => {
    state.data = { version: "0.36.0", gitSha: null, release: "v0.36.0", buildTime: null };
    const html = renderToStaticMarkup(React.createElement(VersionChip));
    expect(html).toContain("v0.36.0");
    expect(html).not.toContain("build null");
  });
});
