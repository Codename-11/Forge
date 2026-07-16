# Hermes Forge platform plugin

This directory is the distributable Hermes platform plugin for Forge. It is
the proactive Hermes-to-Forge delivery half of the integration. Interactive
turn execution uses Hermes' native Sessions API; issue and background work
continues to use `/v1/runs`.

Install `adapter.py` and `plugin.yaml` together under the Hermes profile's
platform plugin directory, then configure:

```dotenv
FORGE_BASE_URL=https://forge.example.com
FORGE_API_KEY=forge_sk_...
```

The API key must be linked to the Forge agent represented by this Hermes
profile. Never place the key in plugin configuration committed to source.

## Connector MCP contract

The adapter first calls `chat.connector.negotiate`:

```json
{
  "connector": "hermes-forge-platform",
  "versions": ["1.0"],
  "profileKey": "victor",
  "capabilities": {
    "orderedEvents": true,
    "idempotentDelivery": true,
    "draftStreaming": true,
    "proactiveDelivery": true,
    "statusEvents": true,
    "toolEvents": true,
    "attribution": true,
    "sessionMapping": "forge-owned",
    "eventKinds": ["message.started", "message.delta", "message.final"]
  }
}
```

Forge returns only explicitly supported behavior:

```json
{
  "selectedVersion": "1.0",
  "connectorId": "cnr_...",
  "capabilities": {
    "orderedEvents": true,
    "idempotentDelivery": true,
    "draftStreaming": true,
    "proactiveDelivery": true,
    "statusEvents": true,
    "toolEvents": true
  }
}
```

If the negotiation tool is absent, the adapter conservatively uses only the
legacy draft tools. Transport/authentication failures do not downgrade because
that could duplicate a delivery after an ambiguous response.

Negotiated events call `chat.connector.deliver` with `{ "envelope": ... }`:

```json
{
  "envelope": {
    "protocolVersion": "1.0",
    "connector": "hermes-forge-platform",
    "connectorId": "cnr_...",
    "eventId": "hermes_...",
    "sequence": 42,
    "direction": "hermes_to_forge",
    "kind": "message.final",
    "occurredAt": "2026-07-15T20:15:00Z",
    "threadId": "thread_...",
    "sessionId": "api_...",
    "replyToMessageId": "message_...",
    "attribution": {
      "actorType": "agent",
      "profileKey": "victor",
      "agentId": "agent_...",
      "displayName": "Victor",
      "hermesMessageId": "hermes-message-id"
    },
    "idempotency": {
      "key": "hermes_...",
      "scope": "connector-event"
    },
    "payload": {
      "streamId": "stream_...",
      "body": "Final response",
      "role": "agent"
    }
  }
}
```

Forge atomically deduplicates the envelope's scoped idempotency key, enforces a
monotonically increasing sequence within the mapped `(threadId, sessionId)` lane, persists the
event and resulting ChatMessage/state change together, and return the original
successful result for a duplicate retry. A safe result is:

```json
{ "accepted": true, "duplicate": false, "messageId": "message_..." }
```

Supported event kinds are `message.started`, `message.delta`, `message.final`,
`message.proactive`, `status.changed`, `tool.started`, `tool.completed`,
`tool.failed`, `approval.requested`, `approval.resolved`, and `delivery.error`.
Unknown kinds or unsupported protocol versions must be rejected, not silently
reinterpreted.

The existing `chat.startDraft`, `chat.appendDraftChunk`, `chat.finalizeDraft`,
and `chat.appendMessage` tools remain the compatibility fallback. They are not
blindly retried because their legacy contract has no idempotency key.

## Ordering and retries

Sequence numbers and the pending event outbox are stored in
`forge-platform-state.db` below `HERMES_HOME`. Negotiation and connector event
delivery are idempotent and use bounded exponential backoff. The same envelope
and `eventId` are reused across every retry, including after process restart.
Later events wait behind the missing sequence. A failed negotiated delivery
never falls through to a legacy append, because an ambiguous response could
otherwise produce a duplicate message.

Forge remains the lifecycle owner of the ChatThread-to-Hermes-session mapping.
Archiving a Forge thread does not authorize this plugin to delete a Hermes
session, and no connector event contains credentials.
