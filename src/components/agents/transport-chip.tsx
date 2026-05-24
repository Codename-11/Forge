import { cn } from "@/lib/utils";
import {
  transportTone,
  transportTitle,
  type TransportMode,
} from "@/lib/transport-display";

/**
 * Chip showing how an agent's chat is actually served — the resolved engine +
 * runtime/transport (e.g. "Hermes" runs, "Codex app server" runs, "ACP session"
 * dispatch, "Streaming · OpenAI"). Shared by the chat header, Mission Control
 * agents tab, chat status rail, the agent wizard, and the fleet checklist so
 * the transport identity reads identically everywhere.
 *
 * Renders nothing for `mode: "none"` by default (the steering banner handles
 * that case); pass `showNone` to render the amber "no chat" chip explicitly.
 */
export function TransportChip({
  mode,
  label,
  showNone = false,
  className,
}: {
  mode: TransportMode;
  label: string;
  showNone?: boolean;
  className?: string;
}) {
  if (mode === "none" && !showNone) return null;
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0 text-[0.5625rem] uppercase tracking-wider",
        transportTone(mode),
        className,
      )}
      title={transportTitle(mode, label)}
    >
      {mode === "none" ? "no chat" : label}
    </span>
  );
}
