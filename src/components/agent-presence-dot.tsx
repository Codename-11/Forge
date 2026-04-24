import type { AgentStatus } from "@prisma/client";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Agent presence indicator.
 *
 * Renders a warm-earthy status dot sized for inline assignee chips (sm),
 * card meta (md). Colors come from the design tokens in `globals.css` —
 * ONLINE → `--success`, BUSY → `--warning` (ember-amber family),
 * OFFLINE → `--muted-foreground`. Never hardcode colors; if the palette
 * shifts, these shift with it.
 *
 * `pulse` adds a subtle `animate-ping` halo for ONLINE agents — useful on
 * the settings page where presence is the subject of the row, noisy on
 * every assignee chip in a long list. Default off.
 *
 * A `title` attribute surfaces the capitalized status plus the
 * heartbeat-relative-time on hover for accessibility + discoverability.
 */
export type AgentPresenceDotProps = {
  status: AgentStatus;
  size?: "sm" | "md";
  pulse?: boolean;
  /** Last heartbeat. If supplied, included in the hover title. */
  lastHeartbeatAt?: Date | string | null;
  className?: string;
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  ONLINE: "bg-success",
  BUSY: "bg-warning",
  OFFLINE: "bg-muted-foreground/70",
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  ONLINE: "Online",
  BUSY: "Busy",
  OFFLINE: "Offline",
};

export function AgentPresenceDot({
  status,
  size = "sm",
  pulse = false,
  lastHeartbeatAt,
  className,
}: AgentPresenceDotProps) {
  const dim = size === "md" ? "h-2 w-2" : "h-1.5 w-1.5";
  const color = STATUS_COLOR[status] ?? STATUS_COLOR.OFFLINE;
  const label = STATUS_LABEL[status] ?? STATUS_LABEL.OFFLINE;
  const title = lastHeartbeatAt
    ? `${label} · heartbeat ${relativeTime(lastHeartbeatAt)}`
    : label;
  const showPulse = pulse && status === "ONLINE";

  return (
    <span
      aria-hidden
      title={title}
      className={cn("relative inline-flex shrink-0", dim, className)}
    >
      {showPulse && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping",
            color,
          )}
        />
      )}
      <span className={cn("relative inline-block rounded-full", dim, color)} />
    </span>
  );
}
