export type IssueTimelineFilter = "discussion" | "updates" | "all";

export type TimelineCommentSource = {
  id: string;
  createdAt: Date | string;
  kind?: "BODY" | "STATUS" | "SYSTEM";
  run?: { status: string } | null;
};

export type TimelineEventSource = {
  id: string;
  kind: string;
  createdAt: Date | string;
  payload?: unknown;
  actor?: { id: string } | null;
  actorAgent?: { id: string } | null;
};

export type IssueTimelineEntry<C, E> =
  | { type: "comment"; id: string; comment: C }
  | { type: "event"; id: string; event: E }
  | { type: "changes"; id: string; events: E[] };

const ROUTINE_EVENTS = new Set([
  "ISSUE_UPDATED",
  "ISSUE_ASSIGNED",
  "ISSUE_PRIORITY_CHANGED",
  "ISSUE_QUEUED",
  "ISSUE_SNOOZED",
  "ISSUE_UNSNOOZED",
]);

const OUTCOME_EVENTS = new Set([
  "ISSUE_STATUS_CHANGED",
  "ISSUE_STALLED",
  "ISSUE_SLA_BREACH",
  "AGENT_NOACK",
  "AGENT_RUN_COMPLETED",
  "AGENT_RUN_BLOCKED",
  "AGENT_RUN_STALLED",
  "AGENT_RUN_CLEARED",
  "AGENT_RUN_BUDGET_BREACHED",
  "PLUGIN_ERROR",
]);

export function activityCommentId(event: Pick<TimelineEventSource, "kind" | "payload">) {
  if (event.kind !== "COMMENT_CREATED" && event.kind !== "COMMENT_UPDATED") return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const id = record.commentId ?? record.sourceCommentId;
  return typeof id === "string" && id ? id : null;
}

export function isRoutineIssueEvent(kind: string) {
  return ROUTINE_EVENTS.has(kind);
}

function time(value: Date | string) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function actorKey(event: TimelineEventSource) {
  if (event.actorAgent) return `agent:${event.actorAgent.id}`;
  if (event.actor) return `user:${event.actor.id}`;
  // System events can have different connectors; avoid inventing a shared actor.
  return `event:${event.id}`;
}

/** Merge the loaded windows, retaining full comment cards and audit ordering. */
export function buildIssueTimeline<C extends TimelineCommentSource, E extends TimelineEventSource>(
  comments: readonly C[],
  events: readonly E[],
  filter: IssueTimelineFilter,
  linkedCommentId?: string | null,
): Array<IssueTimelineEntry<C, E>> {
  const loadedCommentIds = new Set(comments.map((comment) => comment.id));
  const entries: Array<IssueTimelineEntry<C, E> & { at: number }> = [];
  for (const comment of comments) {
    const linked = comment.id === linkedCommentId;
    const live =
      comment.kind === "STATUS" &&
      (comment.run?.status === "ACTIVE" || comment.run?.status === "WAITING");
    if (live && !linked) continue;
    const body = !comment.kind || comment.kind === "BODY";
    if (
      !linked &&
      ((filter === "updates" && body) || (filter === "discussion" && comment.kind === "SYSTEM"))
    )
      continue;
    entries.push({
      type: "comment",
      id: `comment-${comment.id}`,
      comment,
      at: time(comment.createdAt),
    });
  }
  for (const event of events) {
    const commentId = activityCommentId(event);
    // Never render a second summary of a full comment already loaded, even
    // when that comment belongs to a different filter or the live workstream.
    if (commentId && loadedCommentIds.has(commentId)) continue;
    if (filter === "discussion" && !OUTCOME_EVENTS.has(event.kind)) continue;
    entries.push({ type: "event", id: `activity-${event.id}`, event, at: time(event.createdAt) });
  }
  entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const result: Array<IssueTimelineEntry<C, E>> = [];
  for (const entry of entries) {
    if (entry.type !== "event" || !isRoutineIssueEvent(entry.event.kind)) {
      result.push(entry);
      continue;
    }
    const previous = result.at(-1);
    const previousEvent = previous?.type === "changes" ? previous.events.at(-1) : undefined;
    if (
      previous?.type === "changes" &&
      previousEvent &&
      actorKey(previousEvent) === actorKey(entry.event) &&
      time(entry.event.createdAt) - time(previous.events[0].createdAt) <= 30 * 60_000
    ) {
      previous.events.push(entry.event);
    } else {
      result.push({ type: "changes", id: entry.id, events: [entry.event] });
    }
  }
  return result;
}
