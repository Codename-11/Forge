# Runtime Adapters — provider-agnostic managed-runtime refactor

> Status: **proposed / in progress** · Author: refactor working session 2026-05-23
> Supersedes the provider-keyed `src/server/integrations/adapters.ts` manifest
> and the "Runtime as display-only registry" model.

## Problem

The agent/runtime model conflates three orthogonal concerns and special-cases
Hermes:

1. **Provider** (`AgentProvider`: HERMES | CLAUDE | CODEX | CUSTOM) — who the agent is.
2. **Runtime.kind** (`LOCAL_DAEMON | REMOTE_HTTP | CLOUD`) — where it runs.
3. **Connection + loop ownership** — `presence`, mcp/webhook, `RunEngine`
   (COMPLETIONS = Forge owns the loop, RUNS = the platform owns it).

Symptoms:

- **Endpoint resolution is split and inconsistent.** Webhook dispatch reads
  per-agent `Agent.webhookUrl` (`audit.ts`); the RUNS connector reads a
  **global env** `HERMES_GATEWAY_URL` (`dispatch/hermes-runs.ts:gatewayBase()`),
  hardcoded to one Hermes gateway. `Runtime.endpoint` / `Runtime.secret` exist
  but are populated for display only — nothing dispatches through them.
- **One daemon shows as N runtimes.** Victor and Mizu are two profiles on one
  Hermes daemon, yet each has its own backfilled `"(legacy webhook)"`
  REMOTE_HTTP runtime (migration 0018). The per-agent webhook is the flattening.
- **No UI to manage a managed runtime.** Runtimes page only Rename/Archive;
  no create, no endpoint/secret/adapter edit; the agent editor can't set
  `runtimeId`. Onboarding (`/settings/integrations`) is a static
  provider-keyed manifest that treats Hermes as "REMOTE_HTTP webhook," hiding
  that it owns the loop, streams chat, does approvals, and has presence.

Hermes is the only integration that lights up the rich end of all three axes
(`presence: daemon`, `RUNS`, draft streaming, approvals, multi-profile). But
none of that is provider-specific in principle — a future managed platform
(another agent host, a cloud worker pool) would want the same shape. MCP and
webhook are **transport primitives**; "Hermes" is a **managed runtime adapter**
that happens to use them.

## Decision

Introduce a **provider-agnostic `RuntimeAdapter`** abstraction. A `Runtime`
row *instances* an adapter with a concrete endpoint + secret + config; agents
*attach* to a runtime. Dispatch resolves the connector, endpoint, and secret
from the agent's runtime (with legacy fallback during transition). Two tiers
are made explicit by adapter capability flags, not by provider name:

- **Managed runtimes** (`managed: true`, often `multiAgent: true`) — host one
  or more agent profiles, own the endpoint/secret, have runtime-level presence.
  Hermes gateway and the `forge` local daemon are the first two; the model is
  open to more.
- **Connections** (`managed: false`) — thin/BYO agents (Claude Code session,
  Codex, custom webhook) that plug in per-agent via a key and optional webhook.

### The `RuntimeAdapter` descriptor (code, not DB)

`src/server/runtimes/adapters.ts` (new; absorbs `integrations/adapters.ts`):

```ts
type RuntimeTransport = "runs-api" | "webhook" | "mcp" | "local-daemon";
type PresenceModel    = "runtime-heartbeat" | "session" | "delivery-derived";

interface RuntimeAdapter {
  key: string;                 // stable, provider-agnostic id (the Runtime.adapterKey)
  title: string; tagline: string; iconKey: string;
  managed: boolean;            // owns endpoint/secret + hosts agents vs thin per-agent connection
  multiAgent: boolean;         // one runtime hosts N agent profiles
  transport: RuntimeTransport; // how Forge sends work
  providers: AgentProvider[];  // which providers this adapter is valid for (compat + editor filtering)
  defaultRunEngine: RunEngine;
  defaultRuntimeMode: AgentRuntimeMode;
  defaultKeyKind: "AGENT" | "PERSONAL" | "SESSION";
  capabilities: { streaming: boolean; approvals: boolean; presence: PresenceModel };
  /** Build a runs connector from a concrete runtime (endpoint+secret). Only for transport "runs-api". */
  makeConnector?: (rt: { endpoint: string | null; secret: string | null }) => DispatchConnector | null;
  autoProvisionable: boolean;
  setupMarkdown: string; mcpSnippet?: string;
}
```

Initial registry: `hermes` (managed, multiAgent, runs-api, streaming+approvals,
runtime-heartbeat), `local-daemon` (managed, multiAgent, local-daemon SSE,
delivery presence), `claude-code` / `codex` (connection, mcp, session),
`custom-http` (connection, webhook). Capabilities live in code; the `Runtime`
row only stores which adapter it is + its concrete endpoint/secret/config.

### Schema

- **`Runtime.adapterKey String?`** — which adapter this runtime instances.
  Nullable for back-compat; backfilled (see migration). Becomes the source of
  truth for "what manages this runtime," replacing inference from `kind`.
- Keep `kind` (compute location), `endpoint`, `secret`, `providersAvailable`.
- `Agent.runtimeId` already exists. `Agent.webhookUrl` / `webhookSecret` stay
  (legacy override) and are dropped only in Phase 4.

### Dispatch resolution (the unification)

A single resolver `resolveAgentDispatch(agent {runtime})` returns
`{ transport, endpoint, secret, connector }`:

- `endpoint = agent.runtime?.endpoint ?? agent.webhookUrl` (runtime-first).
- `secret   = agent.runtime?.secret ?? agent.webhookSecret`.
- `connector = adapter.makeConnector?.({endpoint, secret})` — provider-agnostic;
  the RUNS connector is built from the **runtime's** endpoint/secret instead of
  global env. `gatewayBase()` env becomes the *fallback default* only when no
  runtime endpoint is set.
- `audit.ts` webhook branches and `/api/chat/stream` both call this resolver
  instead of reading `agent.webhookUrl` / `gatewayBase()` directly.

## Migration plan (phased, non-destructive first)

**Phase 1 — foundation (non-breaking).**
- Add `Runtime.adapterKey`. Build the adapter registry. Add
  `resolveAgentDispatch`. Make dispatch runtime-first with agent/env fallback.
- Backfill `adapterKey` on existing runtimes: REMOTE_HTTP hosting HERMES →
  `hermes`; LOCAL_DAEMON → `local-daemon`; others by provider. **No data
  destroyed; existing webhooks keep working** (fallback path).

**Phase 2 — UI.** Runtime CRUD by adapter (create managed runtime, edit
endpoint/secret/name/providers); agent editor gains a runtime selector
(sets `runtimeId`); onboarding reworked around adapters with the two-tier
framing; Runtimes ↔ Agents cross-links; relabel `"(legacy webhook)"`.

**Phase 3 — consolidation migration.** Collapse the per-profile Hermes
runtimes into one managed `hermes` runtime (endpoint/secret moved onto it),
re-point Victor + Mizu's `runtimeId` at it, and treat per-agent `webhookUrl`
as an optional override. Idempotent; guarded; verifiable via `agents.list`.

**Phase 4 — make the registry canonical; deprecate the legacy manifest.**
- `resolveRunEngine` now reads the RuntimeAdapter registry, not the
  provider-keyed `integrations/adapters.ts` manifest (now `@deprecated`,
  kept only to feed the legacy `/settings/integrations` onboarding page
  until it renders from the registry).
- **Deferred (gated, not done):** dropping `Agent.webhookUrl` /
  `webhookSecret`. They're still the live source of truth for *webhook
  delivery* (`audit.ts`) — Hermes profiles each have a distinct inbound
  webhook — so dropping now breaks live dispatch. The drop is contingent on
  operators consolidating topology onto managed runtimes (one Hermes runtime
  per gateway, agents attached) via the Phase 2 UI, after which webhook
  delivery resolves from the runtime and the columns become removable. The
  schema comments already mark them "slated for removal." This is the
  correct sequencing, not an omission.

## Compatibility / rollback

Each phase is independently shippable and reversible. Phase 1 changes no
behavior (resolver falls back to today's values). The risky data move is
isolated to Phase 3 and is non-destructive (re-point, don't delete). Prod
build runs `prisma migrate deploy` on boot; migrations are additive until
Phase 4.
