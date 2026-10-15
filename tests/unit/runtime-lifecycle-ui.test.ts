import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trpc", () => ({ trpc: {} }));
(globalThis as typeof globalThis & { React: typeof React }).React = React;
const { RuntimeLifecycleActions } = await import("@/components/settings/runtime-lifecycle");

describe("runtime lifecycle entry points", () => {
  it("does not render management actions without instance-admin capability", () => {
    expect(
      renderToStaticMarkup(
        React.createElement(RuntimeLifecycleActions, { id: "runtime-1", canManage: false }),
      ),
    ).toBe("");
  });

  it("makes archive, transfer and permanent removal distinct actions", () => {
    const html = renderToStaticMarkup(
      React.createElement(RuntimeLifecycleActions, { id: "runtime-1", canManage: true }),
    );
    expect(html).toContain("Archive &amp; disable");
    expect(html).toContain("Transfer ownership / home");
    expect(html).toContain("Remove registration");
    expect(html).not.toContain('role="dialog"');
  });
});
