import "server-only";

/**
 * Server-side mirror of the UI "stalled run" threshold. Re-exports the
 * value from `src/lib/agent-stale.ts` so both client and server stay
 * agreed on the number — but isolates the import so server code doesn't
 * pull a `"use client"` boundary unnecessarily.
 *
 * Use this for any tRPC proc that filters runs as "stalled in the UI
 * sense" (agent detail page, dashboard agent-activity tile, kick
 * eligibility). The auto-close watchdog uses
 * `Workspace.agentRunStaleMinutes` instead — that's a different knob,
 * intentionally per-workspace and tunable.
 */
export { STALE_RUN_MS } from "@/lib/agent-stale";
