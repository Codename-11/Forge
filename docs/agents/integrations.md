# Integrations

Settings → Integrations (`/w/{slug}/settings/integrations`) lists the available adapter
manifests alongside any agents in your workspace that match each adapter type.

## The adapter manifest

Adapters are defined statically in `src/server/integrations/adapters.ts` — this is a
plain TypeScript file, not a Prisma table. New adapters require a code change rather than
a database migration.

```ts
interface IntegrationAdapter {
  kind: AgentProvider;          // matches the AgentProvider enum
  title: string;
  tagline: string;
  defaultRuntimeMode: AgentRuntimeMode;   // PERSISTENT | EPHEMERAL
  presence: "daemon" | "session" | "remote-webhook";
  defaultKeyKind: "AGENT" | "PERSONAL" | "SESSION";
  autoProvisionable: boolean;
  iconKey: string;              // Lucide icon name
  setupMarkdown: string;        // rendered on the install page
  mcpSnippet?: string;          // optional copy-paste config snippet
}
```

## Available adapters

| Adapter | Kind | Runtime mode | Presence | Default key kind |
|---|---|---|---|---|
| Hermes | `HERMES` | PERSISTENT | daemon | AGENT |
| Claude Code (session) | `CLAUDE` | EPHEMERAL | session | SESSION |
| Claude Desktop | `CLAUDE` | PERSISTENT | session | PERSONAL |
| Codex CLI | `CODEX` | EPHEMERAL | session | SESSION |
| Custom (webhook-driven) | `CUSTOM` | PERSISTENT | remote-webhook | AGENT |

> Two entries share `kind = CLAUDE` (Code vs Desktop). They are disambiguated by
> `presence`. The `integration.byKind` tRPC procedure accepts an optional `presence`
> argument for this reason.

### Hermes

A persistent daemon that hosts multiple agent profiles (Victor, Mizu, etc.). Reacts to
Forge webhooks in real time. Heartbeat comes from the `forge-presence` skill (cron-driven
MCP call) plus implicit heartbeat on each successful webhook delivery.

Steps:
1. Install Hermes and configure a profile.
2. Create an Agent row in Forge (Settings → Agents → New).
3. Set `Agent.webhookUrl` to Hermes' inbound endpoint.
4. Generate an AGENT-kind key here (kind is inferred when `linkedAgentId` is set).
5. Set the key as `FORGE_API_KEY` in Hermes' environment.

See [Hermes Integration](/agents/hermes.html) for the full wiring walkthrough.

### Claude Code (session)

A local Claude Code session — read-only project context, no persistent agent row
required. Uses a SESSION key that auto-expires (default 24h). Best for one-off queries
against workspace data.

```bash
claude mcp add forge --transport http \
  --url ${FORGE_URL}/api/mcp \
  --header "Authorization: Bearer ${apiKey}"
```

### Claude Desktop

Claude Desktop as a semi-persistent MCP client. Uses a PERSONAL key (no expiry). Add
Forge as an MCP server in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["-y", "@forge/mcp-stdio"],
      "env": {
        "FORGE_URL": "${FORGE_URL}",
        "FORGE_API_KEY": "${apiKey}"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

### Codex CLI

OpenAI Codex CLI — session-scoped key recommended:

```bash
export FORGE_API_KEY=${apiKey}
codex --mcp forge=${FORGE_URL}/api/mcp
```

### Custom (webhook-driven)

For any runtime that can receive POST webhooks and make MCP calls with a Bearer token.
Register the Agent manually with its public webhook URL, then generate an AGENT key.

## Installed-agent badges

The Integrations index page renders each adapter card with "installed agent" badges if
any non-archived agents in the workspace match that adapter's `kind`. The
`integration.list` tRPC procedure returns the adapter manifest merged with matching
agent rows.

## Key lifecycle per adapter

The install flow links directly to the Developer Access page for key creation:

- **AGENT keys** — linked to a specific agent via `linkedAgentId`. Permanent until
  revoked. Use for Hermes and custom daemons.
- **SESSION keys** — auto-expire via `expiresAt`. Use for ephemeral Claude Code or
  Codex CLI sessions.
- **PERSONAL keys** — no expiry, no agent link. Use for Claude Desktop or local scripts.

See [API Keys](/automation/api-keys.html) for the full `ApiKey.kind` reference.

## `applyToAgent`

The `integration.applyToAgent` mutation stamps an existing agent with a specific
adapter's `provider` + `defaultRuntimeMode`. Useful for tagging legacy agents that
pre-date the integrations page.

## Cross-references

- [API Keys](/automation/api-keys.html) — key kinds and lifecycle.
- [Runtime modes](/agents/runtime-modes.html) — PERSISTENT vs EPHEMERAL.
- [Hermes Integration](/agents/hermes.html) — Hermes-specific wiring.
- [tRPC Routers](/reference/trpc.html) — `integration.*` procedures.
