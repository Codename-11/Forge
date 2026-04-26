# Hermes Integration

Hermes is Axiom-Labs' AI gateway and agent runtime; Forge is built to talk to
Hermes-style agents bidirectionally.

This page is for the operator wiring an existing Hermes profile into Forge —
or anyone who wants to understand the contract well enough to implement a
compatible agent runtime themselves.

## The handle: profileKey

A Forge `Agent.profileKey` is the same string as a Hermes profile directory
name. If your Hermes deployment has profiles at `~/.hermes/profiles/victor/`
and `~/.hermes/profiles/mizu/`, the corresponding Forge agents have
`profileKey = "victor"` and `profileKey = "mizu"`.

That parity is the contract. Both sides recognize the same handle, so
operators don't carry a mental translation table.

::: info
`profileKey` is unique per workspace, not globally. Two workspaces can each
have a `victor` agent with no collision; that's fine and intentional.
:::

## The push direction: dispatch via webhook

When the dispatcher selects an agent for an issue, Forge POSTs an envelope
to the agent's `webhookUrl`. Hermes' inbound webhook adapter validates the
signature, looks up the routed profile by the in-payload metadata, and hands
the work off to the right agent loop.

The minimum agent webhook contract:

```http
POST /agents/forge HTTP/1.1
Host: hermes.example.com
Content-Type: application/json
X-Forge-Timestamp: 1714080000
X-Forge-Signature: sha256=<hex>
X-Forge-Body-Signature: sha256=<hex>
X-Forge-Event: AGENT_ASSIGNED
X-Forge-Delivery: dlv_01HXYZ...

{
  "kind": "AGENT_ASSIGNED",
  "workspace": { "id": "wks_axi", "slug": "axiom", "key": "AXI" },
  "agent":     { "id": "agt_victor", "profileKey": "victor" },
  "issue":     { "id": "iss_01HX", "key": "AXI-42", "title": "..." },
  "dispatch":  { "mode": "ROUND_ROBIN", "chosen": "agt_victor", "reason": "round-robin" }
}
```

### Heartbeat is implicit

Every successful (2xx) delivery is treated as the agent being reachable. The
worker calls `recordAgentReachable(agentId)`, which bumps `lastHeartbeatAt`
and flips `status: OFFLINE → ONLINE`. Hermes profiles do not have to ping
Forge on a timer.

The escape hatch is `agents.heartbeat` (described below) — useful when an
agent is up but has had no recent assignments, and you want presence to
reflect that.

## The pull direction: MCP

Agents call back into Forge over the MCP surface — 46 tools across 11
namespaces. Two transports are available, both Bearer-authenticated:

- **JSON-RPC** — `POST /api/mcp/rpc` with a standard JSON-RPC 2.0 envelope.
  Best for clients that already speak MCP.
- **REST alias** — `POST /api/mcp/<tool>` with a flat JSON body. Friendlier
  to scripts and out-of-band tooling.

Both transports authenticate the same way: an `Authorization: Bearer ...`
header carrying either a Forge API key (`forge_sk_*`) or, optionally, a
short-lived JWT.

```http
POST /api/mcp/issues.assigned HTTP/1.1
Host: forge.example
Authorization: Bearer forge_sk_live_...
Content-Type: application/json

{ "limit": 25 }
```

```ts
// Equivalent JSON-RPC
fetch("https://forge.example/api/mcp/rpc", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.FORGE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "issues.assigned", arguments: { limit: 25 } },
  }),
});
```

## Self-management: agents.me and agents.heartbeat

Two MCP tools close the self-management loop. Both read the calling agent
from the API key — specifically from `ApiKey.linkedAgentId`. Keys without a
linked agent are rejected (`UNAUTHORIZED`), so you cannot accidentally
call them with a "human" key.

- **`agents.me`** — returns the agent row for the calling key. Use this on
  startup to discover your own `id`, `profileKey`, `capabilities`, and
  `maxConcurrent` without hardcoding them on the agent side.
- **`agents.heartbeat`** — manual status bump. Accepts an optional `status`
  override (`ONLINE | BUSY | OFFLINE`). Use this when the agent is up but
  has had no recent assignments, or when transitioning to `BUSY` to pause
  the dispatcher.

::: tip
Pair this with `linkedAgentId` on the API key, and `issues.assigned` becomes
"my work" — no `profileKey` argument needed, no profile lookup, just a
tight, scoped query.
:::

## AI provider routing

The same Hermes gateway also serves Forge's first-party AI features.

When `Workspace.aiProvider = "hermes"` (the default), AI Triage and AI Coach
route their model calls through the Hermes gateway at `HERMES_GATEWAY_URL`,
authenticated with `HERMES_GATEWAY_TOKEN`. The default model is
`claude-haiku-4-5-20251001`.

Other providers (`openai`, `anthropic`, `custom`) hit OpenAI-compatible
endpoints directly. Pick whichever your stack already has credentials for.
Full matrix lives in [AI Triage & Coach](/agents/ai-triage-and-coach.html).

::: info
Routing AI through Hermes is convenient because the gateway already
implements caching, key rotation, and per-profile quota — but it's not
required. Forge happily talks to OpenAI or Anthropic directly.
:::

## A worked example: bringing victor online

End-to-end onboarding for a real Hermes profile.

```bash
# 1. Create the agent in the Forge workspace.
curl -sS https://forge.example/api/trpc/agents.create \
  -H "Content-Type: application/json" \
  -H "Cookie: $SESSION" \
  -d '{
    "json": {
      "workspaceId": "wks_axi",
      "name": "Victor",
      "profileKey": "victor",
      "webhookUrl": "https://hermes.example.com/agents/forge",
      "webhookSecret": "whsec_...",
      "capabilities": ["urgent", "high", "infra", "backend"],
      "role": "WORKER",
      "maxConcurrent": 3
    }
  }'

# 2. Issue an API key linked to the agent.
curl -sS https://forge.example/api/trpc/apiKeys.create \
  -H "Content-Type: application/json" \
  -H "Cookie: $SESSION" \
  -d '{
    "json": {
      "workspaceId": "wks_axi",
      "name": "victor:hermes",
      "scopes": ["READ_ISSUES", "WRITE_ISSUES", "READ_COMMENTS",
                 "WRITE_COMMENTS", "SUBSCRIBE_EVENTS"],
      "linkedAgentId": "agt_victor"
    }
  }'
# returns: { plaintext: "forge_sk_live_..." }
```

```ts
// 3. On agent boot, identify yourself and announce presence.
import { mcp } from "./forge-mcp";

const me = await mcp.call("agents.me", {});
console.log(`I am ${me.profileKey} (${me.id}); cap = ${me.maxConcurrent}`);

await mcp.call("agents.heartbeat", { status: "ONLINE" });

// 4. Watch your queue.
const work = await mcp.call("issues.assigned", { limit: 25 });
```

```ts
// 5. The first assignment lands as a webhook POST. Successful 200 response
//    bumps lastHeartbeatAt; the agent then transitions and comments via MCP.
await mcp.call("issues.transition", {
  issueId: "iss_01HX",
  to: "IN_PROGRESS",
});
await mcp.call("comments.create", {
  issueId: "iss_01HX",
  body: "On it. Estimating ~30 minutes.",
});
```

That round-trip — webhook in, MCP out — is the entire integration.

## The signed envelope

Every outbound webhook is HMAC-signed. Forge sends two signatures so receivers
can pick whichever shape they prefer:

- **`X-Forge-Signature`** — `sha256=<hex>` over `${timestamp}.${rawBody}`.
  Replay-proof when paired with a tolerance check on `X-Forge-Timestamp`.
- **`X-Forge-Body-Signature`** — `sha256=<hex>` over the raw body alone.
  Useful for CDN- and proxy-mediated paths that can't preserve the
  timestamp header reliably.

Both use the per-agent `webhookSecret` if set, otherwise the workspace
synthetic secret.

```ts
import crypto from "node:crypto";

const TOLERANCE_SECONDS = 300;

export function verifyForgeWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
): boolean {
  const ts = headers["x-forge-timestamp"];
  const sig = headers["x-forge-signature"];
  if (!ts || !sig) return false;

  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (Number.isNaN(skew) || skew > TOLERANCE_SECONDS) return false;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(`${ts}.${rawBody}`)
      .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

::: warning
Verify the signature **before** parsing the body. Reject anything outside
the timestamp tolerance, and never log the secret. The constant-time compare
matters; a naïve `===` leaks bytes.
:::

## Cross-references

- [Agents → Overview](/agents/overview.html) — model and lifecycle.
- [Auto-dispatch](/agents/auto-dispatch.html) — what governs which agent
  receives the next assignment.
- [AI Triage & Coach](/agents/ai-triage-and-coach.html) — provider matrix
  and model selection.
- [Concepts → Scopes & Tenancy](/concepts/scopes-and-tenancy.html) —
  `linkedAgentId` and the API key narrowing arrays.
