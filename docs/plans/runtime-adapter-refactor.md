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
- **No cross-platform chat fallback.** `chat-stream.ts:providerIdFor` no
  longer falls a CLAUDE/CODEX/CUSTOM agent back to Hermes when its own
  endpoint isn't configured. Each provider resolves to its own platform; an
  unconfigured one yields a clear "no chat model configured" error rather
  than silently answering via Hermes (which is misleading — right persona,
  wrong platform). To have Hermes serve an agent, set its provider to HERMES
  or attach it to the Hermes runtime.
- **`Agent.webhookUrl` / `webhookSecret` are retained as an explicit
  per-agent override — NOT dropped.** Resolution: the managed Runtime owns
  the *runs* loop endpoint (Phase 3); per-agent webhook is the BYO /
  custom-webhook push path and override. Dropping the columns would remove
  the custom-webhook-agent feature, so it is intentionally not done. There is
  no split-brain: runs dispatch is runtime-authoritative, webhook delivery is
  per-agent-by-design (RUNS-engine agents have webhook suppressed anyway).
  Schema comments updated to reflect "override," not "slated for removal."

**Status: complete.** The provider-agnostic managed-runtime model, unified
runs dispatch, canonical registry, runtime/agent management UI, and the
chat-platform fix are all shipped. A future webhook-transport *managed*
runtime (custom-http) could make the worker's shim resolution prefer
`Runtime.endpoint` over the per-agent override — a clean extension point, not
outstanding work.

## Provider taxonomy & transport tiers (2026-05-23 addendum)

Refining the model after the "Codex agent answered via Hermes" report. Two
orthogonal clarifications, both now encoded in `src/server/runtimes/adapters.ts`.

### Two kinds of provider

- **Agent / runtime providers** — the agent itself is the provider (Hermes
  profiles, Codex, Claude Code, OpenCode, custom bots). Forge holds **no model
  API key**; it reaches the runtime and the runtime runs the model.
- **Chat-only providers** — raw OpenAI-compatible model access via API key /
  base URL (plain OpenAI/Anthropic/custom gateway). Forge owns the loop; the
  model is a stateless completion backend. **Deferred as its own first-class
  surface** — `streamChatReply` still supports it via env `ai-providers`, but
  no registry adapter ships with this mode and there's no UI to register a key
  as a provider. (User direction: "chat only providers would be their own
  concept — defer that in TODO.")

### `chatMode` capability

New `RuntimeAdapter.chatMode: "runs" | "completions" | "acp" | "none"` — *how*
(or whether) an adapter serves an interactive chat turn. Pull/act CLI
connections (Codex CLI, Claude Code, Claude Desktop, custom-http webhook) are
`"none"`: they read context + act over MCP/webhook but do **not** answer chat
from an API key they don't have. `hermes` and `local-daemon` are `"runs"`.
`adapterServesChat()` lets the UI steer the operator toward a chat-capable
runtime instead of presenting a composer that can only error.

### Transport tiers

`RuntimeTransport` extended with `"acp"` and `"app-server"` to express the
full ladder, basic → rich:

- `webhook` / `mcp` / `local-daemon` — **basic**: push/pull, fire-and-react.
- `acp` *(planned)* — **mid**: Agent Client Protocol session; portable
  multi-vendor CLI control (Claude Code, Codex, OpenCode) without per-vendor
  wiring.
- `app-server` *(planned)* — **rich, vendor-specific**: a vendor's own
  long-lived agent server, e.g. Codex's `app server` — the OpenAI analogue to
  the Hermes gateway.
- `runs-api` — **richest**: managed runtime owning the full loop (Hermes).

We support **both** ACP and vendor app servers by design (operator keeps the
flexibility). `acp` + `codex-app-server` are declared in `PLANNED_ADAPTERS`
(documentation-only; no connector, not in `RUNTIME_ADAPTERS`, so they don't
shift `defaultAdapterForProvider`). Promote into the live array when a
`DispatchConnector` lands. User-docs: `docs/agents/providers-and-transports.md`.

### Deferred TODO (post-this-addendum)

1. Chat-only providers as a first-class registered surface (`completions`).
2. ACP `DispatchConnector`; promote the `acp` adapter.
3. Codex app-server `DispatchConnector`; promote `codex-app-server`.
4. Chat composer steering for `chatMode: "none"` agents (point at attaching a
   chat-capable runtime rather than an input that can only error).

## Compatibility / rollback

Each phase is independently shippable and reversible. Phase 1 changes no
behavior (resolver falls back to today's values). The risky data move is
isolated to Phase 3 and is non-destructive (re-point, don't delete). Prod
build runs `prisma migrate deploy` on boot; migrations are additive until
Phase 4.
