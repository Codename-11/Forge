import { describe, expect, it } from "vitest";
import { PluginScope } from "@prisma/client";
import {
  MCP_DEFAULT_PROFILE,
  MCP_TOOL_PROFILES,
  mcpNamespaces,
  mcpToolNames,
  mcpToolNamespace,
  selectMcpToolNames,
} from "@/server/services/mcp";

/**
 * AXI-82 regression: `tools/list` must be narrowable so providers that cap the
 * advertised tool count (xAI/Grok rejects >200) aren't blown out by the full
 * registry. These assert the selector's contract, not exact counts that churn
 * as tools are added.
 */

// Headroom target: a client typically stacks several MCP servers + the
// runtime's own core tools under one provider cap (xAI = 200). A recommended
// profile must leave plenty of room.
const CAP = 200;
const PROFILE_BUDGET = 150;

describe("mcp tool profiles (AXI-82)", () => {
  it("the full registry is the large surface this issue is about", () => {
    expect(mcpToolNames.length).toBeGreaterThan(150);
    // Full is opt-in; the public/default catalog should be compact.
    expect(selectMcpToolNames({ profile: "full" }).length).toBe(mcpToolNames.length);
    expect(selectMcpToolNames({}).length).toBe(
      selectMcpToolNames({ profile: MCP_DEFAULT_PROFILE }).length,
    );
    expect(selectMcpToolNames({ profile: "nope-typo" }).length).toBe(
      selectMcpToolNames({ profile: MCP_DEFAULT_PROFILE }).length,
    );
  });

  it("every named profile references only real namespaces or tools", () => {
    const known = new Set([...mcpNamespaces, ...mcpToolNames]);
    for (const [name, namespaces] of Object.entries(MCP_TOOL_PROFILES)) {
      for (const ns of namespaces) {
        expect(known, `profile "${name}" → unknown namespace "${ns}"`).toContain(ns);
      }
    }
  });

  it("every named profile is a non-empty subset that stays well under the cap", () => {
    const all = new Set<string>(mcpToolNames);
    for (const profile of Object.keys(MCP_TOOL_PROFILES)) {
      const names = selectMcpToolNames({ profile });
      expect(names.length, `profile "${profile}" is empty`).toBeGreaterThan(0);
      expect(names.length, `profile "${profile}" exceeds budget`).toBeLessThan(PROFILE_BUDGET);
      expect(names.length).toBeLessThan(CAP);
      for (const n of names) expect(all).toContain(n);
    }
  });

  it("the core profile is a tight everyday working set", () => {
    const core = selectMcpToolNames({ profile: "core" });
    expect(core.length).toBeLessThan(100);
    // Issue tracking essentials are present…
    expect(core).toContain("issues.list");
    expect(core).toContain("comments.create");
    // …and the heavy canvas namespace is excluded.
    expect(core.some((n) => mcpToolNamespace(n) === "canvases")).toBe(false);
  });

  it("the runtime default leaves room for native and third-party tools", () => {
    const runtime = selectMcpToolNames({});
    // JSON-RPC also advertises 3 catalog helpers; keep the combined Forge
    // default under 50 so Hermes/native/other-MCP tools have real headroom.
    expect(runtime.length + 3).toBeLessThan(50);
    expect(runtime).toContain("issues.list");
    expect(runtime).toContain("comments.create");
    expect(runtime).toContain("runs.complete");
    expect(runtime).toContain("actionRequests.list");
    expect(runtime).toContain("workSessions.claim");
    expect(runtime.some((n) => mcpToolNamespace(n) === "canvases")).toBe(false);
  });

  it("explicit ?tools= namespaces win over profile and bound the result", () => {
    const names = selectMcpToolNames({
      namespaces: ["issues", "comments"],
      profile: "canvas", // ignored when namespaces are given
    });
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(["issues", "comments"]).toContain(mcpToolNamespace(n));
    }
  });

  it("scope filtering mirrors call-time authorization", () => {
    // A read-only-issues key can only see tools requiring nothing beyond it.
    const readOnly = selectMcpToolNames({ scopes: [PluginScope.READ_ISSUES] });
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly).toContain("issues.list");
    expect(readOnly).not.toContain("issues.create"); // needs WRITE_ISSUES
    expect(readOnly.length).toBeLessThan(mcpToolNames.length);

    // A FULL-scope key (all scopes) does not widen the advertised profile by
    // itself. Full catalog exposure must be requested explicitly.
    const defaultFullScope = selectMcpToolNames({ scopes: Object.values(PluginScope) });
    expect(defaultFullScope.length).toBeLessThan(mcpToolNames.length);
    const full = selectMcpToolNames({ profile: "full", scopes: Object.values(PluginScope) });
    expect(full.length).toBe(mcpToolNames.length);
  });

  it("namespace and scope filters compose", () => {
    const names = selectMcpToolNames({
      namespaces: ["issues"],
      scopes: [PluginScope.READ_ISSUES],
    });
    for (const n of names) {
      expect(mcpToolNamespace(n)).toBe("issues");
    }
    expect(names).toContain("issues.list");
    expect(names).not.toContain("issues.create");
  });
});
