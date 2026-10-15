import { describe, expect, it } from "vitest";
import { prepareAgentRequestDraft, resolveComposerAgentRequests } from "@/lib/agent-request-draft";
import { resolveAgentRequests } from "@/lib/agent-request-parser";

describe("explicit Ask agent selection", () => {
  it("replaces prior Execute text and override with the newly selected Discuss", () => {
    const previousOverrides = { codex: { mode: "EXECUTE" as const, assignIssue: true } };
    const next = prepareAgentRequestDraft(
      "@codex /execute fix this",
      "codex",
      "DISCUSS",
      "@codex /discuss ",
    );
    const overrides = { ...previousOverrides, [next.profileKey]: next.override };
    expect(next.body).toBe("@codex /discuss fix this");
    const submitted = resolveComposerAgentRequests(next.body, overrides);
    expect(resolveAgentRequests(submitted, next.body)).toEqual([
      { profileKey: "codex", mode: "DISCUSS", assignIssue: false },
    ]);
  });

  it("updates all selected-agent modes without duplicate requests or losing other text", () => {
    const body =
      "Please @Codex:execute this; ask @victor /review separately.\nLater @codex execute the follow-up.";
    const next = prepareAgentRequestDraft(body, "@CODEX", "RESEARCH", "@codex /research ");
    expect(next.body).toBe(
      "Please @Codex:/research this; ask @victor /review separately.\nLater @codex /research the follow-up.",
    );
    expect(resolveComposerAgentRequests(next.body, { [next.profileKey]: next.override })).toEqual([
      { profileKey: "codex", mode: "RESEARCH", assignIssue: false },
      { profileKey: "victor", mode: "REVIEW", assignIssue: false },
    ]);
  });

  it("adds explicit mode to an existing bare mention without appending a second mention", () => {
    expect(
      prepareAgentRequestDraft("@codex can you investigate?", "codex", "REVIEW", "@codex /review ")
        .body,
    ).toBe("@codex /review can you investigate?");
  });

  it("preserves other agent overrides and ordinary draft content", () => {
    const next = prepareAgentRequestDraft(
      "Keep these notes.\n@victor /execute the separate task.",
      "codex",
      "DISCUSS",
      "@codex /discuss ",
    );
    expect(next.body).toBe(
      "Keep these notes.\n@victor /execute the separate task.\n\n@codex /discuss ",
    );
    const requests = resolveComposerAgentRequests(next.body, {
      victor: { mode: "EXECUTE", assignIssue: true },
      [next.profileKey]: next.override,
    });
    expect(requests).toEqual([
      { profileKey: "victor", mode: "EXECUTE", assignIssue: true },
      { profileKey: "codex", mode: "DISCUSS", assignIssue: false },
    ]);
  });

  it("does not retain stale assignment flags when the mode is not Execute", () => {
    expect(
      resolveComposerAgentRequests("@codex /discuss", {
        codex: { mode: "DISCUSS", assignIssue: true },
      }),
    ).toEqual([{ profileKey: "codex", mode: "DISCUSS", assignIssue: false }]);
  });

  it("requires separate explicit assignment even when Ask mode is Execute", () => {
    const next = prepareAgentRequestDraft("", "codex", "EXECUTE", "@codex /execute ");
    expect(next.override).toEqual({ mode: "EXECUTE", assignIssue: false });
  });
});
