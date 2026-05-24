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
