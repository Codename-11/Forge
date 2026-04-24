# notification-bridge

First-party Forge plugin that forwards workspace activity events to
Slack and Discord channel webhooks.

## What it does

On every `ActivityEvent` delivered to the plugin, the handler checks
per-workspace config and, for each configured channel whose `eventKinds`
list includes the event's kind, POSTs a formatted payload.

- Slack uses the standard incoming-webhook `{ text, blocks: [...] }`.
- Discord uses the channel webhook `{ embeds: [...] }` shape.

Both payloads include:

- The issue identifier (e.g. `AXI-42`) when the event subject is an
  issue and the payload carries the number.
- A short action summary (created / status change / priority change /
  agent assigned / new comment).
- A link back to Forge: `https://forge.axiom-labs.dev/w/{slug}/issues/{issueId}`.

Certain internal / high-volume kinds are **blocked even if configured**:
`PLUGIN_ERROR`, `SKILL_INVOKED`, `ISSUE_QUEUED`, `AGENT_CREATED`,
`AGENT_UPDATED`, `AGENT_DELETED`.

## Install

1. Register the plugin in Forge (admin UI or the `plugin.register`
   mutation) using the manifest at `plugins/notification-bridge/manifest.json`.
2. Approve it — the local handler is already wired in
   `src/server/services/local-plugins.ts`, so there is no separate
   deploy step.

## Configure

Config lives in the Plugin's `manifest.config` JSON blob per workspace
(or pass it explicitly on every skill invocation). Shape:

```ts
{
  slack?: {
    webhookUrl: string,   // Slack incoming-webhook URL
    eventKinds: EventKind[]
  },
  discord?: {
    webhookUrl: string,   // Discord channel webhook URL
    eventKinds: EventKind[]
  },
  mentionsOnly?: boolean  // when true, only forward events whose
                          // payload.mentions[] is non-empty
}
```

Example — route every issue-level signal to Slack and mentions-only
comments to Discord:

```json
{
  "slack": {
    "webhookUrl": "https://hooks.slack.com/services/T.../B.../xxx",
    "eventKinds": [
      "ISSUE_CREATED",
      "ISSUE_STATUS_CHANGED",
      "ISSUE_PRIORITY_CHANGED",
      "AGENT_ASSIGNED"
    ]
  },
  "discord": {
    "webhookUrl": "https://discord.com/api/webhooks/1234/abcd",
    "eventKinds": ["COMMENT_CREATED"]
  },
  "mentionsOnly": true
}
```

## Supported event kinds

`ISSUE_CREATED`, `ISSUE_STATUS_CHANGED`, `ISSUE_PRIORITY_CHANGED`,
`AGENT_ASSIGNED`, `COMMENT_CREATED`.

Any other kind a user puts in config will simply never match because
the handler only forwards when `kind ∈ eventKinds`. The block-list
(above) takes precedence even if present in config.

## Testing

Unit tests for the pure formatter live at
`tests/unit/notification-bridge-format.test.ts`. They cover the four
core scenarios without any network I/O.
