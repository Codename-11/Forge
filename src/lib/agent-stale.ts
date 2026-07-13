/**
 * Single source of truth for the operator-attention "quiet run" threshold.
 * An ACTIVE AgentRun older than this may need an update, but it is not
 * canonically STALLED. `AgentRun.status === STALLED` is the only stalled state.
 *
 * The server-side watchdog that *closes* stalled runs lives in
 * `src/server/services/agent-run-stale.ts` and uses
 * `Workspace.agentRunStaleMinutes` — that's a per-workspace knob for
 * automatic state transitions. This constant is purely for "show this active
 * row as quiet / needing attention." Keeping the two separate is intentional:
 * an operator can nudge a quiet run before the watchdog canonically stalls it.
 */
export const QUIET_RUN_MS = 5 * 60_000;

/** @deprecated Prefer QUIET_RUN_MS; retained while callers migrate their copy. */
export const STALE_RUN_MS = QUIET_RUN_MS;

export type RunFreshness = "LIVE" | "QUIET" | "STALLED";

/**
 * Keep UI attention freshness separate from the persisted terminal status.
 * WAITING and terminal non-STALLED runs are not reclassified by elapsed time.
 */
export function deriveRunFreshness(input: {
  status: string;
  lastEventAt: Date | string;
  now?: Date | number;
  quietMs?: number;
}): RunFreshness {
  if (input.status === "STALLED") return "STALLED";
  if (input.status !== "ACTIVE") return "LIVE";

  const now = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
  const lastEventAt =
    input.lastEventAt instanceof Date
      ? input.lastEventAt.getTime()
      : new Date(input.lastEventAt).getTime();
  return now - lastEventAt >= (input.quietMs ?? QUIET_RUN_MS) ? "QUIET" : "LIVE";
}
