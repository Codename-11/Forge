# AI Triage & Coach

The only first-party AI features. Triage runs on issue create; Coach posts
when work goes off-track.

Forge's product surface is intentionally lean about AI: two opinionated
features that ride on top of the same provider configuration. Everything
else (richer summarization, prioritization assistants, and so on) is
expected to live in plugins.

## Master toggle and provider config

`Workspace.aiEnabled` is the on/off switch for both features. When false,
neither runs and no model calls are made.

When enabled, two columns control routing:

- `Workspace.aiProvider` — one of `hermes` (default), `openai`,
  `anthropic`, or `custom`.
- `Workspace.aiModel` — overrides the provider default. Leave null to use
  the default model for the selected provider.

### Provider matrix

| Provider    | Default model               | Env vars                                     |
| ----------- | --------------------------- | -------------------------------------------- |
| `hermes`    | `claude-haiku-4-5-20251001` | `HERMES_GATEWAY_URL`, `HERMES_GATEWAY_TOKEN` |
| `openai`    | `gpt-4o-mini`               | `OPENAI_API_KEY`, `OPENAI_BASE_URL`          |
| `anthropic` | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY`                          |
| `custom`    | `gpt-4o-mini`               | `FORGE_AI_BASE_URL`, `FORGE_AI_API_KEY`      |

OpenAI, Anthropic, and custom providers can also use an enabled encrypted
`ProviderCredential` stored for the workspace. Stored credentials take
precedence over environment variables and are shared by Triage, Coach,
description assist, and plan generation.

`custom` exists for OpenAI-compatible endpoints that aren't OpenAI
themselves — Together, Groq, vLLM behind a proxy, a local LLM gateway, etc.
Both Triage and Coach use the same provider; you cannot mix providers per
feature.

::: tip
The default — `hermes` with `claude-haiku-4-5-20251001` — is what Axiom-Labs
runs internally. It's tuned for the prompts in this document and tends to
be the cheapest path to reasonable behavior. Switch only if you have a
specific reason.
:::

## AI Triage

Suggests priority, labels, and an assignee on issue create.

### Knob

| Column                       | Purpose                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `Workspace.aiTriageOnCreate` | Default `true`. When `aiEnabled` is also true, every new issue triggers a triage call. |

### How it runs

Triage runs as a background task on issue create — the create transaction
commits first; the triage call happens afterwards and writes back its
suggestion in a separate transaction. The issue is fully usable while
triage is in flight.

The call loads four pieces of context:

- The issue itself (title and description).
- The workspace's full label list (id, name, color).
- All non-archived `WORKER`-role agents (id, name, profileKey,
  capabilities, role).
- A small recent-issues sample (titles only) for tone calibration.

Direct OpenAI-compatible providers receive a structured tool-use call against
a single tool named `submit_triage`:

```ts
const tool = {
  name: "submit_triage",
  description: "Submit a triage decision for the new issue.",
  input_schema: {
    type: "object",
    properties: {
      priority: { enum: ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] },
      label_ids: { type: "array", items: { type: "string" } },
      agent_id: { type: "string", nullable: true },
      reasoning: { type: "string" },
    },
    required: ["priority", "label_ids", "reasoning"],
  },
};
```

Hermes receives the same schema as a plain-JSON response contract. Forge does
not register `submit_triage` with Hermes because the gateway owns its own
server-side tool registry; sending a request-scoped function there would turn
the schema into an executable agent tool and fail as unknown.

The response is validated, mapped against the workspace's actual labels and
agents, and persisted onto the issue. Exact ids are preferred. Unique label
names, agent profile keys, and agent names are accepted as a compatibility
fallback; ambiguous names are ignored. Name-based assignment is only parsed
from an explicit agent/assignee clause, never from free-form reasoning.

| Column                  | Set to                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- |
| `aiTriageStatus`        | `READY` on success; `ERROR` on failure. Starts at `PENDING` while in flight. |
| `aiSuggestedPriority`   | The model's `priority` choice.                                               |
| `aiSuggestedLabelIds[]` | The model's `label_ids`, filtered to ids that exist in the workspace.        |
| `aiSuggestedAgentId`    | The model's `agent_id`, or null.                                             |
| `aiTriageReasoning`     | The model's free-text rationale.                                             |
| `aiTriagedAt`           | Timestamp of completion.                                                     |
| `aiTriageDecidedAt`     | Set when a human applies or dismisses the suggestion.                        |

### Idempotency

The runner atomically claims an issue by changing a null status to `PENDING`.
Concurrent create hooks or rerun requests therefore produce at most one model
call. The public rerun mutation clears a completed/failed/decided state before
starting a new claim and rejects a duplicate request while one is pending.

### What the user sees

The issue header surfaces a "Triage suggestion" affordance with the
proposed priority, labels, and agent, plus the reasoning. Two buttons:

- **Apply** — writes the suggested values onto the issue's actual
  `priority`, `labels[]`, and `assignedAgentId`. Sets `aiTriageStatus =
APPLIED` and `aiTriageDecidedAt`. Label changes are audited, and agent
  changes run the standard manual-assignment lifecycle (dispatch reason,
  engagement mode, run cleanup, template application, and watcher wake target).
- **Dismiss** — leaves the issue alone. Sets `aiTriageStatus = DISMISSED`
  and `aiTriageDecidedAt`.

The `aiTriageStatus` enum: `PENDING`, `READY`, `APPLIED`, `DISMISSED`,
`ERROR`, or null (never triaged).

## AI Coach

Posts a diagnostic comment when work goes off-track.

### Knob

| Column                     | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `Workspace.aiCoachEnabled` | Default `true`. Requires a `COACH`-role agent to exist in the workspace. |

### How it runs

Coach subscribes to three event kinds emitted by the
[watchdogs](/agents/slas-and-watchdogs.html):

- `ISSUE_STALLED` — no activity in the SLA window.
- `AGENT_NOACK` — agent never acked an assignment.
- `ISSUE_SLA_BREACH` — issue exceeded its per-issue SLA.

For each event, Coach assembles a small context bundle (issue, recent
events, the agent's recent comments, the watchdog event payload) and
issues a plain-text completion. The result is posted as a comment on the
issue, authored by the COACH agent — `Comment.authoringAgentId` points at
the COACH agent's id.

```ts
// Resolved at fire time:
const coach = await prisma.agent.findFirst({
  where: { workspaceId, role: "COACH", archivedAt: null },
  orderBy: { createdAt: "asc" },
});
```

If multiple COACH agents exist, Coach uses the oldest one. There's no
round-robin among coaches — coaching is an attribution decision, not a
load-balancing one.

### Failure handling

Coach is decorative. If the model call fails — provider down, rate limit,
malformed response — the failure is swallowed and the underlying watchdog
event still flows. You'll see the `ISSUE_STALLED` etc. event in the
ActivityEvent stream regardless, just without the accompanying comment.

This is intentional: Coach should never be a hard dependency on the
event-emission path.

::: warning
If `aiCoachEnabled` is true but no COACH-role agent exists in the
workspace, Coach silently no-ops. There's a settings-page warning when
you're in this state, but no runtime errors.
:::

## Operating tips

- **Enable Triage when your team is forming label and priority habits.**
  The model encodes the average shape of past issues; if there's no past
  to learn from, suggestions are noisy. Wait until you have ~50 issues
  with priorities and labels set, then turn it on.
- **A/B providers by editing Workspace.** Both features read provider
  config at call time — there's no app restart, no cache. Flip
  `aiProvider` to `openai` for a day, watch the Triage suggestions, flip
  back. Apples-to-apples comparison without a deploy.
- **Watch Coach comments for the first week.** The model is best at
  pattern-matching ("this looks like a deploy issue") and worst at giving
  novel advice. If Coach is repetitive or off-base, dial it back by
  raising your watchdog windows so it fires less often, or turn it off
  entirely with `aiCoachEnabled = false`.
- **Triage status is a useful filter.** `aiTriageStatus = READY` means
  "AI thinks this should be triaged but nobody has decided yet." A small
  saved view on that filter is a good morning ritual.
- **Don't auto-apply Triage.** Forge deliberately requires a human (or
  agent) to apply suggestions. The status enum is the audit trail of
  whether the suggestion was used.

## Cross-references

- [SLAs & Watchdogs](/agents/slas-and-watchdogs.html) — the events Coach
  subscribes to.
- [Hermes Integration](/agents/hermes.html) — how Hermes-routed AI calls
  authenticate against the gateway.
- [Agents → Overview](/agents/overview.html) — the COACH role.
- [Reference → Events](/reference/events.html) — the EventKind enum.
