import { describe, expect, it } from "vitest";
import {
  activityCommentId,
  buildIssueTimeline,
  type TimelineCommentSource,
  type TimelineEventSource,
} from "@/lib/issue-timeline";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 15, 12, minute));
const comment = (
  id: string,
  minute: number,
  kind: TimelineCommentSource["kind"] = "BODY",
): TimelineCommentSource => ({ id, kind, createdAt: at(minute) });
const event = (
  id: string,
  minute: number,
  kind = "ISSUE_UPDATED",
  payload?: unknown,
): TimelineEventSource => ({ id, kind, createdAt: at(minute), payload, actor: { id: "bailey" } });

describe("issue timeline", () => {
  it("defaults discussion to full comments and significant outcomes", () => {
    const result = buildIssueTimeline(
      [comment("reply", 2), comment("narration", 4, "SYSTEM")],
      [event("title", 1), event("done", 3, "AGENT_RUN_COMPLETED")],
      "discussion",
    );
    expect(result.map((entry) => entry.id)).toEqual(["comment-reply", "activity-done"]);
  });

  it("keeps final agent status output in discussion", () => {
    const result = buildIssueTimeline(
      [{ ...comment("status", 1, "STATUS"), run: { status: "COMPLETED" } }],
      [],
      "discussion",
    );
    expect(result.map((entry) => entry.id)).toEqual(["comment-status"]);
  });

  it("keeps live status in workstream unless specifically deep-linked", () => {
    const live = { ...comment("status", 1, "STATUS"), run: { status: "WAITING" } };
    expect(buildIssueTimeline([live], [], "all")).toEqual([]);
    expect(buildIssueTimeline([live], [], "all", "status")).toHaveLength(1);
  });

  it("updates contains system/status output but not body conversation", () => {
    const result = buildIssueTimeline(
      [comment("body", 0), comment("status", 1, "STATUS"), comment("system", 2, "SYSTEM")],
      [event("created", 3, "ISSUE_CREATED")],
      "updates",
    );
    expect(result.map((entry) => entry.id)).toEqual([
      "comment-status",
      "comment-system",
      "activity-created",
    ]);
  });

  it("merges audit and discussion chronologically without mutating inputs", () => {
    const comments = [comment("later", 5), comment("earlier", 1)];
    const events = [
      event("outcome", 4, "AGENT_RUN_COMPLETED"),
      event("status", 2, "ISSUE_STATUS_CHANGED"),
    ];
    expect(buildIssueTimeline(comments, events, "all").map((entry) => entry.id)).toEqual([
      "comment-earlier",
      "activity-status",
      "activity-outcome",
      "comment-later",
    ]);
    expect(comments[0].id).toBe("later");
    expect(events[0].id).toBe("outcome");
  });

  it("deduplicates only activity referring to loaded comment IDs", () => {
    const events = [
      event("create", 1, "COMMENT_CREATED", { commentId: "body" }),
      event("edit", 2, "COMMENT_UPDATED", { commentId: "body" }),
      event("older", 0, "COMMENT_CREATED", { commentId: "unloaded" }),
    ];
    expect(
      buildIssueTimeline([comment("body", 1)], events, "all").map((entry) => entry.id),
    ).toEqual(["activity-older", "comment-body"]);
  });

  it("does not substitute a duplicate comment summary when a filter hides its card", () => {
    expect(
      buildIssueTimeline(
        [comment("body", 1)],
        [event("create", 1, "COMMENT_CREATED", { commentId: "body" })],
        "updates",
      ),
    ).toEqual([]);
  });

  it("does not guess deduplication from preview text or timestamp", () => {
    expect(
      buildIssueTimeline(
        [comment("body", 1)],
        [event("create", 1, "COMMENT_CREATED", { preview: "same text" })],
        "all",
      ),
    ).toHaveLength(2);
    expect(
      activityCommentId(event("source", 1, "COMMENT_CREATED", { sourceCommentId: "body" })),
    ).toBe("body");
  });

  it("groups neighboring routine property changes while retaining each record", () => {
    const result = buildIssueTimeline(
      [],
      [event("title", 1), event("priority", 2, "ISSUE_PRIORITY_CHANGED")],
      "all",
    );
    expect(result).toHaveLength(1);
    expect(result[0].type === "changes" && result[0].events.map((row) => row.id)).toEqual([
      "title",
      "priority",
    ]);
  });

  it("does not group changes across an intervening conversation or outcome", () => {
    expect(
      buildIssueTimeline([comment("reply", 2)], [event("first", 1), event("last", 3)], "all").map(
        (entry) => entry.type,
      ),
    ).toEqual(["changes", "comment", "changes"]);
    expect(
      buildIssueTimeline(
        [],
        [event("first", 1), event("outcome", 2, "ISSUE_STATUS_CHANGED"), event("last", 3)],
        "all",
      ),
    ).toHaveLength(3);
  });

  it("does not group different actors, unknown system actors, or distant changes", () => {
    expect(
      buildIssueTimeline([], [event("a", 1), { ...event("b", 2), actor: { id: "other" } }], "all"),
    ).toHaveLength(2);
    expect(
      buildIssueTimeline(
        [],
        [
          { ...event("a", 1), actor: null },
          { ...event("b", 2), actor: null },
        ],
        "all",
      ),
    ).toHaveLength(2);
    expect(buildIssueTimeline([], [event("a", 1), event("b", 32)], "all")).toHaveLength(2);
  });

  it("identifies agent actors independently from their API-key owner", () => {
    expect(
      buildIssueTimeline(
        [],
        [
          { ...event("a", 1), actorAgent: { id: "codex" } },
          { ...event("b", 2), actorAgent: { id: "victor" } },
        ],
        "all",
      ),
    ).toHaveLength(2);
  });
});
