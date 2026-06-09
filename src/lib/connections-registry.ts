/**
 * Connections registry — the static catalog of inbound + outbound
 * external I/O channels surfaced under Settings → Connections.
 *
 * This is *descriptive metadata only*. With one exception, none of these
 * channels has a live backend yet — the cards describe the contract and
 * read as "available" until their upstream wiring ships. The lone real
 * one is email-to-issue (`email-issue`), which is rendered with its own
 * live controls on the index and is intentionally absent from these
 * arrays (it is not a generic placeholder card).
 *
 * Shared between the index page (`connections/page.tsx`) and the detail
 * route (`connections/[key]/page.tsx`); `findConnection` resolves a key
 * across both directions plus the synthetic email-issue entry.
 */
import {
  GitBranch,
  MessageSquare,
  Inbox as InboxIcon,
  AlertTriangle,
  PlugZap,
  Mail,
} from "lucide-react";

export type ConnectionRow = {
  key: string;
  title: string;
  blurb: string;
  icon: typeof GitBranch;
  transport: string;
  status: "connected" | "available" | "needs auth";
  scope?: string | null;
  beta?: boolean;
};

export const INBOUND: ConnectionRow[] = [
  {
    key: "github",
    title: "GitHub",
    blurb: "Import and link issues and PRs through a GitHub App.",
    icon: GitBranch,
    transport: "GitHub App",
    status: "connected",
    scope: null,
  },
  {
    key: "slack-cmd",
    title: "Slack commands",
    blurb: "Slash-commands and mentions from a Slack workspace.",
    icon: MessageSquare,
    transport: "OAuth",
    status: "available",
    scope: null,
  },
  {
    key: "linear-import",
    title: "Linear import",
    blurb: "One-shot import from a Linear workspace.",
    icon: InboxIcon,
    transport: "API key",
    status: "available",
    scope: null,
  },
];

export const OUTBOUND: ConnectionRow[] = [
  {
    key: "slack-notif",
    title: "Slack notifications",
    blurb: "Mirror inbox to a channel. One-way write.",
    icon: MessageSquare,
    transport: "OAuth",
    status: "available",
    scope: null,
  },
  {
    key: "discord",
    title: "Discord webhook",
    blurb: "Post issue events to a Discord channel.",
    icon: MessageSquare,
    transport: "Webhook URL",
    status: "available",
    scope: null,
  },
  {
    key: "pagerduty",
    title: "PagerDuty",
    blurb: "Route URGENT issues to a PagerDuty service.",
    icon: AlertTriangle,
    transport: "Service key",
    status: "available",
    scope: null,
  },
  {
    key: "custom-webhook",
    title: "Custom webhook",
    blurb: "Any HTTPS endpoint. Signed payloads, retries built-in.",
    icon: PlugZap,
    transport: "Webhook URL",
    status: "available",
    scope: null,
  },
];

/**
 * Email-to-issue — the one inbound channel with a live backend
 * (`/api/ingest/email`). It is rendered with bespoke controls on the
 * index (the `EmailIngestCard`) rather than as a generic card, so it is
 * intentionally NOT part of `INBOUND`. It is included here only so the
 * detail route can resolve `email-issue` and deep-link operators back to
 * its real controls.
 */
export const EMAIL_ISSUE: ConnectionRow = {
  key: "email-issue",
  title: "Email-to-issue",
  blurb: "POST signed JSON to /api/ingest/email and Forge creates an issue.",
  icon: Mail,
  transport: "Signed webhook",
  status: "connected",
  beta: true,
};

export type ConnectionDirection = "in" | "out";

/**
 * Resolve a connection by key across inbound, outbound, and the
 * synthetic email-issue entry. Returns the row plus its direction so
 * callers can render the data-flow arrow without re-deriving it.
 */
export function findConnection(
  key: string,
): { connection: ConnectionRow; direction: ConnectionDirection } | null {
  if (key === EMAIL_ISSUE.key) {
    return { connection: EMAIL_ISSUE, direction: "in" };
  }
  const inbound = INBOUND.find((c) => c.key === key);
  if (inbound) return { connection: inbound, direction: "in" };
  const outbound = OUTBOUND.find((c) => c.key === key);
  if (outbound) return { connection: outbound, direction: "out" };
  return null;
}
