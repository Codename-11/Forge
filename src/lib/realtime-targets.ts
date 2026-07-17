import type { RealtimeEventShape } from "@/hooks/use-realtime";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Resolve exact cache keys carried by a realtime event. */
export function realtimeTargets(event: RealtimeEventShape): {
  issueId: string | null;
  cycleIds: string[];
} {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  const issueId =
    event.subjectType === "issue" ? stringValue(event.subjectId) : stringValue(payload.issueId);
  const cycleIds = [stringValue(payload.cycleId), stringValue(payload.previousCycleId)].filter(
    (id): id is string => Boolean(id),
  );
  return { issueId, cycleIds: [...new Set(cycleIds)] };
}
