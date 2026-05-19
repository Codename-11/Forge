import { describe, expect, it } from "vitest";
import { formatChatContextSummary } from "@/hooks/use-chat-context";

describe("formatChatContextSummary", () => {
  it("summarizes route, issue, entity and run counts without exposing URLs", () => {
    expect(
      formatChatContextSummary({
        route: "https://forge.axiom-labs.dev/w/axi/issues/123?token=secret",
        slug: "axi",
        issueId: "issue-1",
        selectedIds: ["a", "b"],
        visibleEntities: [{ kind: "issue", ids: ["i1", "i2", "i3"] }],
        pinnedRunIds: ["run-1"],
        liveRunIds: ["run-2", "run-3"],
      }),
    ).toEqual([
      "route:[redacted-url]",
      "issue:issue-1",
      "selected:2",
      "visible:3",
      "pinned-runs:1",
      "live-runs:2",
      "workspace:axi",
    ]);
  });
});
