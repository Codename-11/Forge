# Action Requests

An **ActionRequest** is a precise, resolvable ask. Where a comment is
prose and a notification is "something happened," an ActionRequest
models "the operator needs to make a decision before work continues."
It has a lifecycle (`OPEN` → `RESOLVED` / `DISMISSED` / `REJECTED` /
`SNOOZED`), an assignee (a user or agent), an optional bound action
that runs on Accept, and — since migration 0050 — an optional list of
poll options for multi-vote decisions.

## When to use one

- An agent needs a decision before continuing ("Should I transition
  this to Done, or is there more work?").
- An agent surfaces a recommendation it can execute itself ("Move to
  In Progress" — Accept dispatches the transition).
- An agent presents multiple viable paths and wants the team to
  weigh in before committing.

For "FYI" messaging, use a comment. For "needs attention but no
specific ask," use the notification inbox. ActionRequest is the
"please decide" surface.

## Kinds

`ActionRequest.kind` discriminates what Accept dispatches:

| Kind                  | Accept dispatches                                       |
|-----------------------|---------------------------------------------------------|
| `FREE_FORM` (default) | Nothing — pure prose with no executable hook.           |
| `TRANSITION`          | `issues.transition({ statusId })` on `issueId`.         |
| `SET_LABELS`          | `issues.setLabels({ add, remove })`.                    |
| `ASSIGN`              | `issues.assign(userIds)`.                               |
| `ASSIGN_AGENT`        | `issues.assignAgent(agentId)`.                          |
| `ARCHIVE`             | Soft-delete the issue.                                  |
| `CLOSE_AS_DUPLICATE`  | Add a `DUPLICATES` relation + optionally re-status.     |

Decline never dispatches, regardless of kind. The action-request
service validates every referenced id against the calling workspace
before persistence — agents can't sneak in a cross-tenant `statusId`.

## Polls (multi-vote)

Pass `options[]` to `actionRequests.create` (or to the inline
`comments.create` `actionRequest` bundle) and the request renders as
a multi-vote poll instead of a single-acceptor card. Each option
carries:

```ts
{ key: string; label: string; description?: string }
```

`key` is the stable id used by every vote row. Operators (or agents
with session-bound keys) call `actionRequests.vote({ id, optionKey })`
to cast a vote; calling again with a different `optionKey` overwrites
the previous pick. Each user gets exactly one vote per request,
enforced by the `(actionRequestId, userId)` unique index.

The renderer can show live counts (`actionRequests.results`) as votes
come in. When the requester decides the discussion is done, they
call `actionRequests.closeVoting`, which:

1. Sets `votingClosedAt` so further `vote` calls are rejected.
2. Re-tallies inside a transaction and returns the winning
   `optionKey`. Ties are broken by earliest first-vote timestamp; on
   equal counts AND no votes at all, the option that appears first
   in `options[]` wins.

Closing voting does **not** resolve the request. The typical flow is
"close → comment 'going with X' → resolve" so the action timeline
shows both the decision and the follow-up.

Only the original requester may close voting:

- For human-requested polls, `actorId === requestedByUserId`.
- For agent-requested polls, `actorAgentId === requestedByAgentId`
  (resolved from the calling key's `linkedAgentId`).

## Inline ActionRequest via `comments.create`

The most common pattern is "post explanatory comment + recommendation
in one round-trip." `comments.create` accepts an optional
`actionRequest` bundle that's created in the same flow with
`sourceType="comment"` + `sourceId=<commentId>` so
`actionRequest.forComment` resolves it back for the issue detail
timeline.

```json
{
  "issueId": "iss_...",
  "body": "I see three viable paths. Vote below.",
  "actionRequest": {
    "title": "Pick an approach",
    "kind": "FREE_FORM",
    "options": [
      { "key": "retry",    "label": "Add retry-on-failure" },
      { "key": "isolate",  "label": "Isolate the test in its own worker" },
      { "key": "rewrite",  "label": "Rewrite against a deterministic fixture" }
    ]
  }
}
```

## Permissions

- **Create**: anyone with `WRITE_ISSUES` (or `comments.create`).
- **Vote / results**: any workspace member with `WRITE_ISSUES` /
  `READ_ISSUES`.
- **closeVoting**: only the requester (human or agent).
- **Accept / Decline**: the assigned user, a watcher on the issue,
  or a workspace `OWNER` / `ADMIN`. Anyone else gets `403`.

## See also

- [/reference/mcp.html#actionrequests](/reference/mcp.html#actionrequests)
  — full MCP tool surface with examples.
- [/reference/events.html](/reference/events.html) — every vote and
  close-voting call emits an `ISSUE_UPDATED` ActivityEvent with the
  `subjectType: "action-request"` discriminator so subscribers can
  follow along.
