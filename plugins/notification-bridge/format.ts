/**
 * Pure formatters for notification-bridge. No I/O, no DB — safe to unit
 * test without hitting real webhooks. The handler feeds us an
 * ActivityEvent-shaped object and the workspace it belongs to, and we
 * return Slack + Discord payloads ready to POST.
 *
 * Shape of Slack payload:   `{ text, blocks: [...] }` — Slack's standard
 *                           incoming-webhook schema.
 * Shape of Discord payload: `{ embeds: [...] }` — Discord's channel
 *                           webhook schema. `content` is omitted so the
 *                           embed carries everything.
 */

export type EventKind =
  | "ISSUE_CREATED"
  | "ISSUE_UPDATED"
  | "ISSUE_DELETED"
  | "ISSUE_STATUS_CHANGED"
  | "ISSUE_ASSIGNED"
  | "ISSUE_PRIORITY_CHANGED"
  | "ISSUE_QUEUED"
  | "COMMENT_CREATED"
  | "COMMENT_UPDATED"
  | "PROJECT_CREATED"
  | "PROJECT_UPDATED"
  | "SKILL_INVOKED"
  | "PLUGIN_ERROR"
  | "AGENT_CREATED"
  | "AGENT_UPDATED"
  | "AGENT_DELETED"
  | "AGENT_ASSIGNED";

/**
 * Kinds we refuse to forward even if a caller puts them in their
 * config. Keeps internal/agent-loop chatter out of human channels.
 */
export const BLOCKED_EVENT_KINDS: ReadonlySet<string> = new Set<string>([
  "PLUGIN_ERROR",
  "SKILL_INVOKED",
  "ISSUE_QUEUED",
  "AGENT_CREATED",
  "AGENT_UPDATED",
  "AGENT_DELETED",
]);

export type ActivityEventLike = {
  id?: string;
  kind: EventKind | string;
  subjectType: string;
  subjectId: string;
  payload?: Record<string, unknown> | null;
  actorId?: string | null;
  createdAt?: string | Date;
};

export type WorkspaceLike = {
  id?: string;
  slug: string;
  key: string;
  name?: string;
};

export type MentionLike = { agentId: string; profileKey?: string };

export type SlackPayload = {
  text: string;
  blocks: Array<Record<string, unknown>>;
};

export type DiscordPayload = {
  embeds: Array<Record<string, unknown>>;
};

export type FormattedPayloads = {
  slack: SlackPayload;
  discord: DiscordPayload;
};

/**
 * Forge UI link for the event's subject. Issue events deep-link to the
 * issue surface; everything else falls back to the workspace home so
 * we never emit a broken URL.
 */
export function buildForgeUrl(event: ActivityEventLike, ws: WorkspaceLike): string {
  const base = `https://forge.axiom-labs.dev/w/${ws.slug}`;
  if (event.subjectType === "issue" && event.subjectId) {
    return `${base}/issues/${event.subjectId}`;
  }
  return base;
}

/**
 * `AXI-42`-style identifier when the payload carries the issue number.
 * Falls back to just the workspace key when the event isn't about an
 * issue or the number isn't in the payload.
 */
export function buildIssueIdentifier(
  event: ActivityEventLike,
  ws: WorkspaceLike,
): string | null {
  if (event.subjectType !== "issue") return null;
  const payload = event.payload ?? {};
  const rawNumber =
    (payload as { number?: unknown }).number ??
    (payload as { issueNumber?: unknown }).issueNumber;
  if (typeof rawNumber === "number" && Number.isFinite(rawNumber)) {
    return `${ws.key}-${rawNumber}`;
  }
  if (typeof rawNumber === "string" && /^\d+$/.test(rawNumber)) {
    return `${ws.key}-${rawNumber}`;
  }
  return null;
}

/**
 * Short human sentence describing the event. Kept terse on purpose —
 * Slack and Discord both crop long fields.
 */
export function summarize(event: ActivityEventLike, identifier: string | null): string {
  const id = identifier ?? "issue";
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.kind) {
    case "ISSUE_CREATED": {
      const title = typeof payload.title === "string" ? payload.title : "";
      return title ? `${id} created: ${title}` : `${id} created`;
    }
    case "ISSUE_STATUS_CHANGED": {
      const from = payload.from ?? payload.fromStatus ?? null;
      const to = payload.to ?? payload.toStatus ?? null;
      if (from && to) return `${id} status: ${String(from)} → ${String(to)}`;
      return `${id} status changed`;
    }
    case "ISSUE_PRIORITY_CHANGED": {
      const from = payload.from ?? null;
      const to = payload.to ?? null;
      if (from && to) return `${id} priority: ${String(from)} → ${String(to)}`;
      if (to) return `${id} priority → ${String(to)}`;
      return `${id} priority changed`;
    }
    case "AGENT_ASSIGNED": {
      const agentId =
        (payload.agentId as string | null | undefined) ??
        (payload.assignedAgentId as string | null | undefined) ??
        null;
      if (agentId === null) return `${id} agent unassigned`;
      const prof =
        (payload.profileKey as string | undefined) ??
        (payload.agentProfileKey as string | undefined);
      return prof ? `${id} assigned to @${prof}` : `${id} agent assigned`;
    }
    case "COMMENT_CREATED": {
      const preview = typeof payload.preview === "string" ? payload.preview : "";
      const mentions = extractMentionKeys(payload);
      const mentionSuffix = mentions.length ? ` (@${mentions.join(", @")})` : "";
      return preview
        ? `New comment on ${id}${mentionSuffix}: ${preview}`
        : `New comment on ${id}${mentionSuffix}`;
    }
    default:
      return `${event.kind} on ${id}`;
  }
}

function extractMentionKeys(payload: Record<string, unknown>): string[] {
  const raw = payload.mentions;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    if (m && typeof m === "object") {
      const pk = (m as MentionLike).profileKey;
      if (typeof pk === "string" && pk.length) out.push(pk);
    }
  }
  return out;
}

export function hasMentions(event: ActivityEventLike): boolean {
  const raw = (event.payload ?? {}) as { mentions?: unknown };
  return Array.isArray(raw.mentions) && raw.mentions.length > 0;
}

/**
 * Formatter — pure, no I/O. Returns Slack + Discord payloads; the
 * handler chooses which ones to actually POST based on config.
 */
export function formatEvent(
  event: ActivityEventLike,
  workspace: WorkspaceLike,
): FormattedPayloads {
  const identifier = buildIssueIdentifier(event, workspace);
  const summary = summarize(event, identifier);
  const url = buildForgeUrl(event, workspace);
  const wsLabel = workspace.name ?? workspace.slug;

  const slack: SlackPayload = {
    text: summary,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeSlack(summary)}*` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${url}|Open in Forge> · \`${event.kind}\` · ${escapeSlack(wsLabel)}`,
          },
        ],
      },
    ],
  };

  const discord: DiscordPayload = {
    embeds: [
      {
        title: identifier ? `${identifier} · ${String(event.kind)}` : String(event.kind),
        description: summary,
        url,
        color: colorFor(String(event.kind)),
        footer: { text: wsLabel },
        timestamp: toIsoString(event.createdAt),
      },
    ],
  };

  return { slack, discord };
}

/** Slack mrkdwn needs `<>&` escaped to avoid accidental formatting. */
function escapeSlack(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Embed color hints — Discord uses a decimal int. Warm-earthy tokens. */
function colorFor(kind: string): number {
  switch (kind) {
    case "ISSUE_CREATED":
      return 0xb58a5a; // warm ochre
    case "ISSUE_STATUS_CHANGED":
      return 0x7a8f6a; // muted sage
    case "ISSUE_PRIORITY_CHANGED":
      return 0xc06e3f; // burnt sienna
    case "AGENT_ASSIGNED":
      return 0x6b7a9a; // cool graphite
    case "COMMENT_CREATED":
      return 0x8a7b6a; // warm stone
    default:
      return 0x55524c; // paper-on-graphite neutral
  }
}

function toIsoString(v: string | Date | undefined): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  return v;
}
