# Runtime Modes

Every `Agent` row carries a `runtimeMode` that Forge uses to surface honest presence
information and to choose the right queue semantics when delivering messages.

## The two modes

```prisma
enum AgentRuntimeMode {
  PERSISTENT
  EPHEMERAL
}
```

| Mode | Typical runtimes | Presence expectation |
|---|---|---|
| `PERSISTENT` | Hermes daemon, custom always-on webhooks | Agent is (or should be) online continuously. `status = OFFLINE` is an anomaly worth surfacing. |
| `EPHEMERAL` | Claude Code session, Codex CLI, one-off scripts | Agent is only live during an explicit session. `status = OFFLINE` between sessions is normal and expected. |

### Why this matters for chat

The chat composer shows a hint when the agent cannot be reached immediately:

- **Persistent, OFFLINE** — "Queued — delivered on next heartbeat." The message is
  durably stored and will be delivered when the agent next comes online.
- **Ephemeral, any status** — "Session — replies arrive when the session is active."
  No delivery guarantee outside an active session; no alarming "agent is offline" banner.

### Why this matters for dispatch

The dispatcher currently does not filter on `runtimeMode` — presence (`status = ONLINE`)
is the gate. But `runtimeMode` is surfaced in `agents.me` so a runtime can inspect its
own mode at startup and decide whether to drain a queue or wait for push delivery.

## Heartbeat sources

An agent is considered reachable when either of these fires:

1. **Explicit `agents.heartbeat` call** — the runtime calls the MCP tool
   `agents.heartbeat` (or the tRPC mutation `agent.heartbeat`) with an optional
   `{ status: ONLINE | BUSY | OFFLINE }`. Bumps `Agent.lastHeartbeatAt` atomically.

2. **Successful webhook delivery** — every 2xx response from the agent's `webhookUrl`
   calls `recordAgentReachable` in `src/server/services/heartbeat.ts`, which bumps
   `lastHeartbeatAt` and flips `OFFLINE → ONLINE` if needed.

Persistent agents should keep `lastHeartbeatAt` fresh even when idle (no assignments).
The `forge-presence` Hermes skill handles this automatically for Hermes profiles; other
runtimes should implement a lightweight cron-driven heartbeat loop.

## Idle sweep

`Workspace.agentIdleTimeoutMinutes` (default 15) controls when an agent is considered
stale. When greater than zero, a BullMQ repeatable job runs and flips agents to
`OFFLINE` when their `lastHeartbeatAt` is older than the threshold.

```
Agent ONLINE (idle) → no heartbeat for > agentIdleTimeoutMinutes → auto-OFFLINE
```

The sweep is one-way (online → offline). Recovery requires a successful delivery or
explicit `agents.heartbeat`. Set `agentIdleTimeoutMinutes = 0` to disable sweeping for
a workspace.

::: tip
For persistent agents backed by the `forge-presence` cron skill, set
`agentIdleTimeoutMinutes` to 2–3 minutes so a single missed tick doesn't flip the
agent offline.
:::

## The forge-presence Hermes skill

Forge releases publish a versioned `forge-presence-vX.Y.Z.tar.gz` artifact and
`SHA256SUMS`. Verify the checksum, unpack it below
`~/.hermes/skills/forge-presence/`, then use its setup script. The source ships
at `integrations/hermes/forge-presence/` for source-based installations.

`~/.hermes/skills/forge-presence/` is a small cron-driven script that calls
`agents.heartbeat` on behalf of a Hermes profile. It requires only:
- `FORGE_URL` — the Forge instance base URL.
- `FORGE_API_KEY` — an AGENT-kind API key with `linkedAgentId` set.

The agent id is inferred from the key's `linkedAgentId`; no agent id needs to be
hardcoded.

### Setup for the default agent (Victor)

```bash
cp ~/.hermes/skills/forge-presence/forge.env.example ~/.hermes/forge.env
$EDITOR ~/.hermes/forge.env    # set FORGE_URL + FORGE_API_KEY
chmod 600 ~/.hermes/forge.env
bash ~/.hermes/skills/forge-presence/bin/setup.sh victor
```

### Setup for an installed profile (Mizu, Mizuki, …)

```bash
cp ~/.hermes/skills/forge-presence/forge.env.example \
   ~/.hermes/profiles/<profile>/forge.env
$EDITOR ~/.hermes/profiles/<profile>/forge.env
chmod 600 ~/.hermes/profiles/<profile>/forge.env
bash ~/.hermes/skills/forge-presence/bin/setup.sh <profile>
```

The `setup.sh` script registers a system cron entry that calls the heartbeat endpoint
every minute. Without the skill, a Hermes agent is still considered reachable whenever
the worker successfully delivers a webhook (implicit heartbeat) — but chat shows
"offline · queued" until the first delivery lands. With the skill, presence is honest
from the moment Hermes starts. The heartbeat is script-only, repeats indefinitely,
and is silent on success; it never opens a Hermes session or wakes an LLM.

## Cross-references

- [Agents → Overview](/agents/overview.html) — `status`, `lastHeartbeatAt`, idle sweep.
- [Integrations](/agents/integrations.html) — adapter defaults per runtime type.
- [Hermes Integration](/agents/hermes.html) — how the forge-presence skill fits into the
  Hermes wiring.
- [Chat](/agents/chat.html) — how runtime mode affects the chat composer hint.
