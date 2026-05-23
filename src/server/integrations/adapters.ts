import "server-only";
import type { AgentProvider, AgentRuntimeMode, RunEngine } from "@prisma/client";

/**
 * @deprecated Superseded by the provider-agnostic RuntimeAdapter registry
 * (`src/server/runtimes/adapters.ts`), which is the canonical source for
 * adapter capabilities and run-engine defaults. This provider-keyed manifest
 * survives only to feed the legacy `/settings/integrations` onboarding page
 * (its per-provider `setupMarkdown`/`mcpSnippet`) until that page is migrated
 * to render from the registry. Do not add new consumers — read the registry.
 * See `docs/plans/runtime-adapter-refactor.md` (Phase 4).
 */
export interface IntegrationAdapter {
  /** Stable id matching the existing AgentProvider enum. */
  kind: AgentProvider;
  /** Human-friendly title. */
  title: string;
  /** One-liner shown on cards. */
  tagline: string;
  /** Default runtime mode for agents created via this adapter. */
  defaultRuntimeMode: AgentRuntimeMode;
  /**
   * Default chat engine for agents on this integration when the agent
   * doesn't set its own `runEngine`. COMPLETIONS = Forge owns the loop;
   * RUNS = delegate to the provider's structured agent-run API.
   */
  defaultRunEngine: RunEngine;
  /** Lucide icon name (string — UI maps it). */
  iconKey: string;
  /** Markdown describing setup. Rendered on the install page. */
  setupMarkdown: string;
  /** Optional MCP install snippet template. `${apiKey}` placeholder substituted client-side. */
  mcpSnippet?: string;
  /** Whether this adapter expects a long-running daemon vs an ad-hoc CLI. */
  presence: "daemon" | "session" | "remote-webhook";
  /** Recommended ApiKeyKind for keys created by this adapter. */
  defaultKeyKind: "AGENT" | "PERSONAL" | "SESSION";
  /** Whether this adapter supports auto-provisioning via the install flow. */
  autoProvisionable: boolean;
}

export const INTEGRATION_ADAPTERS: IntegrationAdapter[] = [
  {
    kind: "HERMES",
    title: "Hermes",
    tagline: "Persistent multi-profile agent runtime. Best for always-on agents.",
    defaultRuntimeMode: "PERSISTENT",
    // Hermes agents talk as themselves (own memory + tools) by default —
    // chat and dispatch both run through /v1/runs. Per-agent override
    // available; flip to COMPLETIONS for a stateless, Forge-owned loop.
    defaultRunEngine: "RUNS",
    iconKey: "Server",
    presence: "daemon",
    defaultKeyKind: "AGENT",
    autoProvisionable: false,
    setupMarkdown: `# Hermes

A persistent daemon that hosts multiple agent profiles (Victor, Mizu, etc.) and reacts to Forge webhooks in real time.

**Steps:**
1. Install Hermes locally and configure profiles.
2. Register an Agent in Forge, paste the agent's webhook URL into \`Agent.webhookUrl\`.
3. Generate a key here with kind=AGENT and \`linkedAgentId\` set.
4. Set the key as Hermes's \`FORGE_API_KEY\` environment variable.

Hermes pulls the workspace's MCP server with the linked agent context.

## Presence (forge-presence skill)

Forge knows an agent is online when the runtime calls the MCP tool \`agents.heartbeat\`. The \`forge-presence\` skill at \`~/.hermes/skills/forge-presence/\` is a small cron-driven HTTP poke that does this for you. It only needs the Forge URL and an AGENT-kind API key — the agent id is inferred from the key's \`linkedAgentId\`.

\`\`\`bash
# Installed profile (mizu, mizuki, …):
cp ~/.hermes/skills/forge-presence/forge.env.example \\
   ~/.hermes/profiles/<profile>/forge.env
$EDITOR ~/.hermes/profiles/<profile>/forge.env  # FORGE_URL + FORGE_API_KEY
chmod 600 ~/.hermes/profiles/<profile>/forge.env
bash ~/.hermes/skills/forge-presence/bin/setup.sh <profile>

# Default agent (victor — runs from ~/.hermes/config.yaml directly):
cp ~/.hermes/skills/forge-presence/forge.env.example ~/.hermes/forge.env
$EDITOR ~/.hermes/forge.env
chmod 600 ~/.hermes/forge.env
bash ~/.hermes/skills/forge-presence/bin/setup.sh victor
\`\`\`

The skill registers a system cron entry that pings every minute. Set \`Workspace.agentIdleTimeoutMinutes\` to 2–3 minutes so a single missed tick doesn't immediately flip the agent OFFLINE.

Without this skill the agent will be reachable for dispatched work (because successful webhook delivery also bumps heartbeat via \`recordAgentReachable\`), but chat will show "offline · queued" until the first delivery lands. With the skill, presence is honest from the moment Hermes starts.`,
  },
  {
    kind: "CLAUDE",
    title: "Claude Code (session)",
    tagline: "Local Claude Code session — read-only project context.",
    defaultRuntimeMode: "EPHEMERAL",
    defaultRunEngine: "COMPLETIONS",
    iconKey: "Terminal",
    presence: "session",
    defaultKeyKind: "SESSION",
    autoProvisionable: true,
    setupMarkdown: `# Claude Code

Run a local Claude Code session that can read your workspace's project context (issues, comments, status). Best as a SESSION key — it auto-expires.

**Install snippet:**
\`\`\`
claude mcp add forge --transport http \\
  --url \${FORGE_URL}/api/mcp \\
  --header "Authorization: Bearer \${apiKey}"
\`\`\`

The key expires in 24h by default. Generate a new one when this session ends.`,
    mcpSnippet: `claude mcp add forge --transport http --url \${FORGE_URL}/api/mcp --header "Authorization: Bearer \${apiKey}"`,
  },
  {
    kind: "CLAUDE",
    title: "Claude Desktop",
    tagline: "Persistent Claude Desktop with MCP — semi-persistent, key stays valid.",
    defaultRuntimeMode: "PERSISTENT",
    defaultRunEngine: "COMPLETIONS",
    iconKey: "MonitorPlay",
    presence: "session",
    defaultKeyKind: "PERSONAL",
    autoProvisionable: true,
    setupMarkdown: `# Claude Desktop

Add Forge as an MCP server in your \`claude_desktop_config.json\`. Use a PERSONAL key — it persists across sessions.

\`\`\`json
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["-y", "@forge/mcp-stdio"],
      "env": {
        "FORGE_URL": "\${FORGE_URL}",
        "FORGE_API_KEY": "\${apiKey}"
      }
    }
  }
}
\`\`\`

Restart Claude Desktop after editing the config.`,
  },
  {
    kind: "CODEX",
    title: "Codex CLI",
    tagline: "OpenAI Codex CLI — session-scoped key recommended.",
    defaultRuntimeMode: "EPHEMERAL",
    defaultRunEngine: "COMPLETIONS",
    iconKey: "Code2",
    presence: "session",
    defaultKeyKind: "SESSION",
    autoProvisionable: true,
    setupMarkdown: `# Codex CLI

Generate a SESSION key here, then export it for the Codex CLI session:
\`\`\`
export FORGE_API_KEY=\${apiKey}
codex --mcp forge=\${FORGE_URL}/api/mcp
\`\`\``,
  },
  {
    kind: "CUSTOM",
    title: "Custom (webhook-driven)",
    tagline: "Bring your own runtime — register an agent + webhook URL.",
    defaultRuntimeMode: "PERSISTENT",
    defaultRunEngine: "COMPLETIONS",
    iconKey: "Webhook",
    presence: "remote-webhook",
    defaultKeyKind: "AGENT",
    autoProvisionable: false,
    setupMarkdown: `# Custom integration

For any runtime that can:
1. Receive POST webhooks from Forge,
2. Make MCP/tRPC calls back with a Bearer token.

Register the Agent manually with its public webhook URL, then generate an AGENT key.`,
  },
];

/** Primary adapter for a provider kind (first match). */
export function getIntegrationAdapter(kind: AgentProvider): IntegrationAdapter | null {
  return INTEGRATION_ADAPTERS.find((a) => a.kind === kind) ?? null;
}

export function findAdapter(
  kind: AgentProvider,
  presence?: IntegrationAdapter["presence"],
): IntegrationAdapter | null {
  // Multiple adapters may share the same kind (e.g. CLAUDE has both Code and Desktop).
  // Disambiguate by presence when given.
  const matches = INTEGRATION_ADAPTERS.filter((a) => a.kind === kind);
  if (presence) return matches.find((a) => a.presence === presence) ?? null;
  return matches[0] ?? null;
}
