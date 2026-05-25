/**
 * Shared display logic for an agent's resolved **chat transport** — the
 * single source of truth for how the chat header, Mission Control agents tab,
 * chat status rail, agent wizard, and fleet checklist render the transport
 * chip. Mirrors `ChatTransportMode` from `src/server/services/chat-readiness.ts`
 * (kept as a standalone string-literal here so client code doesn't pull the
 * `server-only` module).
 */
export type TransportMode = "runs" | "completions" | "dispatch" | "none";

/** Tailwind classes for the chip, by mode. Uses warm-earthy / semantic tokens. */
export function transportTone(mode: TransportMode): string {
  switch (mode) {
    case "runs":
      return "border-ember/30 bg-ember/10 text-ember";
    case "dispatch":
      return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "completions":
      return "border-border bg-subtle/40 text-muted-foreground";
    case "none":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

/** Tooltip explaining what the transport means for this agent. */
export function transportTitle(mode: TransportMode, label: string): string {
  switch (mode) {
    case "runs":
      return `Runs engine — ${label} owns the loop; the agent answers as itself (its own memory + tools). Replies still stream.`;
    case "dispatch":
      return `Served by the agent's ${label} — replies are delivered by its runtime/daemon (not a Forge-side model). Ensure it's running.`;
    case "completions":
      return `Streaming engine — Forge runs a stateless loop against ${label}.`;
    case "none":
      return "No chat model or runtime can serve a turn for this agent yet.";
  }
}

/**
 * Connection tier for a runtime transport (see providers-and-transports.md):
 *  1 — first-class managed runtime (owns the loop), 2 — session CLI,
 *  3 — basic webhook/http.
 */
export function tierForTransport(transport: string): { n: 1 | 2 | 3; label: string } {
  switch (transport) {
    case "runs-api":
    case "app-server":
      return { n: 1, label: "First-class" };
    case "acp":
    case "mcp":
    case "local-daemon":
      return { n: 2, label: "Session" };
    default:
      return { n: 3, label: "Basic" };
  }
}

/**
 * How an agent's *availability* should be read — distinct from chat transport.
 * Heartbeat-tracked agents (Hermes daemon) have a meaningful online/offline;
 * a managed app-server / completions / dispatch agent is reached **on demand**
 * (it connects when you send, so a heartbeat "offline" badge is misleading);
 * session agents are ephemeral. Drives presence display in chat + the detail
 * page so e.g. Codex app server reads "on-demand · via Codex app server"
 * instead of a permanent "offline".
 */
export type AvailabilityModel = "heartbeat" | "on-demand" | "session";

export function agentAvailabilityModel(input: {
  runtimeMode?: string | null;
  lastHeartbeatAt?: Date | string | null;
  transportMode: TransportMode;
  /** True when the agent's runtime genuinely heartbeats (Hermes gateway). */
  runtimeHeartbeats?: boolean;
}): AvailabilityModel {
  if (input.runtimeMode === "EPHEMERAL") return "session";
  // Genuinely heartbeat-tracked (Hermes) or has ever reported a heartbeat →
  // online/offline is meaningful.
  if (input.runtimeHeartbeats || input.lastHeartbeatAt) return "heartbeat";
  // A chat-capable agent that never heartbeats is reached on demand.
  if (input.transportMode !== "none") return "on-demand";
  // No chat path + no heartbeat — fall back to the heartbeat display.
  return "heartbeat";
}

/**
 * Cheap, client-safe availability derivation from an agent's **base columns**
 * (no transport resolve needed) — for the many presence surfaces (rosters,
 * pickers, mentions, sidebars) that shouldn't pay for a full readiness query
 * per agent. Mirrors `agentAvailabilityModel` but infers "has a chat path"
 * from runtime/webhook presence instead of a resolved transport:
 *   - EPHEMERAL → session
 *   - Hermes or has-ever-heartbeat → heartbeat (online/offline is meaningful)
 *   - has a runtime or webhook (non-Hermes) → on-demand (reached when sent)
 *   - otherwise → heartbeat (unconfigured; show its raw status)
 */
export function presenceAvailability(input: {
  provider?: string | null;
  runtimeMode?: string | null;
  lastHeartbeatAt?: Date | string | null;
  webhookUrl?: string | null;
  runtimeId?: string | null;
  // Accepted-but-ignored identity fields so any agent-like object (even a
  // minimal `{ status }` picker row) is assignable here without a TS2559
  // "no properties in common" error — the function only reads the fields above.
  id?: string;
  status?: string | null;
}): AvailabilityModel {
  if (input.runtimeMode === "EPHEMERAL") return "session";
  if (input.provider === "HERMES" || input.lastHeartbeatAt) return "heartbeat";
  if (input.runtimeId || input.webhookUrl) return "on-demand";
  return "heartbeat";
}

/** One-word qualifier for compact surfaces (roster rows, etc.). */
export function transportModeWord(mode: TransportMode): string {
  switch (mode) {
    case "runs":
      return "runs";
    case "completions":
      return "streaming";
    case "dispatch":
      return "dispatch";
    case "none":
      return "no chat";
  }
}
