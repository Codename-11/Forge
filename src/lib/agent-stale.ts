/**
 * Single source of truth for the "stalled run" threshold. An AgentRun is
 * considered stalled (in the UI sense) when its `lastEventAt` is older
 * than this. The Mission Control overlay, the agent detail Stalled
 * bucket, and the dashboard Agent Activity tile all import this value
 * so they can never disagree.
 *
 * The server-side watchdog that *closes* stalled runs lives in
 * `src/server/services/agent-run-stale.ts` and uses
 * `Workspace.agentRunStaleMinutes` — that's a per-workspace knob for
 * automatic state transitions. This constant is purely for "show this
 * row as needing attention." Keeping the two separate is intentional:
 * an operator can see a run as stalled and kick it well before the
 * watchdog would auto-close it.
 */
export const STALE_RUN_MS = 5 * 60_000;
