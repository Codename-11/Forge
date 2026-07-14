import "server-only";

/**
 * Agent wake policy.
 *
 * Activity events are intentionally broader than agent work. Status, label,
 * project, coach, and lifecycle events still belong in the audit timeline and
 * notification system, but they must not become an implicit LLM prompt. Keep
 * the small set of actionable wake decisions here so recordChange(), the RUNS
 * dispatcher, and tests share one contract.
 */

const PRIORITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  URGENT: 4,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True only when priority moves upward into HIGH or URGENT. */
export function isActionablePriorityEscalation(payload: unknown): boolean {
  const record = asRecord(payload);
  const from = typeof record?.from === "string" ? record.from : null;
  const to = typeof record?.to === "string" ? record.to : null;
  if (!from || !to || (to !== "HIGH" && to !== "URGENT")) return false;
  return (PRIORITY_RANK[to] ?? -1) > (PRIORITY_RANK[from] ?? -1);
}

/** Normalize structured and legacy mention payloads to agent ids. */
export function mentionedAgentIdsFromWakePayload(payload: unknown): Set<string> {
  const out = new Set<string>();
  const record = asRecord(payload);

  const requests = record?.agentRequests;
  if (Array.isArray(requests)) {
    for (const item of requests) {
      const agentId = asRecord(item)?.agentId;
      if (typeof agentId === "string" && agentId.length > 0) out.add(agentId);
    }
  }

  const mentions = record?.mentions;
  if (Array.isArray(mentions)) {
    for (const item of mentions) {
      const agentId = asRecord(item)?.agentId;
      if (typeof agentId === "string" && agentId.length > 0) out.add(agentId);
    }
    return out;
  }

  const mentionRecord = asRecord(mentions);
  const agentIds = mentionRecord?.agentIds;
  if (Array.isArray(agentIds)) {
    for (const agentId of agentIds) {
      if (typeof agentId === "string" && agentId.length > 0) out.add(agentId);
    }
  }
  const agents = mentionRecord?.agents;
  if (Array.isArray(agents)) {
    for (const item of agents) {
      const agentId = asRecord(item)?.agentId;
      if (typeof agentId === "string" && agentId.length > 0) out.add(agentId);
    }
  }
  return out;
}

/**
 * Whether a BODY comment is new work for the assigned agent.
 *
 * - Human comments are actionable without requiring an @mention.
 * - Agent-to-agent comments require an explicit @mention.
 * - An agent can never wake itself.
 * - Actor-less automation and rolling/system comments are informational.
 */
export function isActionableAssignedComment(params: {
  actorId: string | null;
  actorAgentId: string | null;
  targetAgentId: string;
  payload: unknown;
}): boolean {
  const payload = asRecord(params.payload);
  if (payload?.kind === "STATUS" || payload?.kind === "SYSTEM") return false;
  if (params.actorAgentId === params.targetAgentId) return false;

  const mentioned = mentionedAgentIdsFromWakePayload(params.payload);
  if (params.actorAgentId) return mentioned.has(params.targetAgentId);
  if (params.actorId) return true;
  return false;
}

/** Explicit mentions use the same self-wake and actor provenance guard. */
export function isActionableExplicitMention(params: {
  actorId: string | null;
  actorAgentId: string | null;
  targetAgentId: string;
  payload: unknown;
}): boolean {
  if (!params.actorId && !params.actorAgentId) return false;
  if (params.actorAgentId === params.targetAgentId) return false;
  return mentionedAgentIdsFromWakePayload(params.payload).has(params.targetAgentId);
}
