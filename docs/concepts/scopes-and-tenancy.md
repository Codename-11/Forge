# Scopes & Tenancy

Every tenant-scoped row carries `workspaceId`; access is gated at the
procedure boundary.

This page covers how Forge keeps workspaces isolated, how API keys narrow
access below the workspace boundary, and the three internal helpers that
do the actual gatekeeping.

## The tenancy contract

Every tenant-scoped row has a `workspaceId` column, indexed and
non-nullable. The contract Forge enforces is:

- **Read** — `findMany` and `findUnique` queries always filter by the
  caller's active `workspaceId`. There is no cross-workspace read path.
- **Write** — every mutation includes `workspaceId` in the create payload
  and in the where-clause for updates and deletes. The procedure layer
  validates that the caller has access to the workspace before letting
  the mutation through.
- **Audit** — every write produces an `AuditLog` row that includes
  `workspaceId`, so even compliance queries respect tenancy.

Procedures live in `src/server/trpc.ts` and come in two main flavors:

- **`workspaceProcedure`** — requires an authenticated user and an active
  workspace context. Validates membership and resolves the user's role
  in that workspace. Most read and write procedures use this.
- **`adminProcedure`** — same as `workspaceProcedure`, plus a check that
  the caller has the `ADMIN` role in the workspace. Used for
  destructive operations and configuration mutations.

::: info
There is no "global" workspace, no "across all workspaces" API surface,
and no internal admin role with cross-workspace reach. The `User` model
is global; everything else is tenant-scoped.
:::

## API keys: two levels of scope

API keys (`forge_sk_*`) authenticate the MCP surface and any
plugin-installed integration. They carry **two** levels of scope on top
of the workspace boundary.

### 1. Coarse PluginScope ceiling

Every API key has a `scopes: PluginScope[]` array. Values:

- `READ_ISSUES`
- `WRITE_ISSUES`
- `READ_PROJECTS`
- `WRITE_PROJECTS`
- `READ_COMMENTS`
- `WRITE_COMMENTS`
- `READ_USERS`
- `READ_ANALYTICS`
- `SUBSCRIBE_EVENTS`
- `INVOKE_SKILLS`
- `ADMIN`

A key's scope set is the **ceiling** — it can never exceed the scope set
declared in the parent plugin manifest, and individual operations check
that the requested operation is in the key's scopes before proceeding.

::: warning
`ADMIN` is the all-keys-fit-this-lock value. Issue it sparingly. Forge
ships with two ADMIN-scoped keys (one for Victor, one for Mizu) and the
intent is that future sub-agents get narrower scopes.
:::

### 2. Optional narrowing arrays

Below the coarse ceiling, three arrays narrow the scope further:

- `projectIds: string[]` — limit access to issues, comments, and
  attachments belonging to these projects.
- `labelIds: string[]` — limit access to issues carrying any of these
  labels.
- `initiativeIds: string[]` — limit access to projects belonging to
  these initiatives, and transitively to issues in those projects.

Empty array = unrestricted within the declared coarse scopes. Non-empty =
filter to those ids.

The narrowing arrays AND together: a key with `projectIds = [a, b]` and
`labelIds = [x]` only sees issues that are in project `a` or `b` **and**
carry label `x`.

```ts
// Example: a per-initiative bot.
{
  scopes: ["READ_ISSUES", "WRITE_COMMENTS", "SUBSCRIBE_EVENTS"],
  initiativeIds: ["init_q2_2026"],
  // empty projectIds, empty labelIds - unrestricted within initiative
}
```

```ts
// Example: a triage bot for design issues.
{
  scopes: ["READ_ISSUES", "WRITE_ISSUES"],
  labelIds: ["lbl_design", "lbl_a11y"],
}
```

## linkedAgentId: agent attribution

API keys also carry an optional `linkedAgentId: string | null` that
points at an `Agent` row. Three things change when it's set:

- **MCP self-management.** `agents.me` returns the linked agent's row.
  `agents.heartbeat` mutates it. Keys without a `linkedAgentId` are
  rejected by these tools.
- **Caller inference.** Tools that need to know "who's calling" — most
  notably `issues.assigned` — resolve the agent from the key without
  the caller passing `profileKey`.
- **Comment attribution.** Comments created by the key get
  `authoringAgentId` set automatically, so the agent's avatar and name
  appear on the comment in the UI.

```ts
// On the agent side:
const me = await mcp.call("agents.me", {});
// returns the agent row associated with this key
```

::: tip
Always set `linkedAgentId` on keys that are issued to agents. It's how
the rest of Forge correctly attributes the work back to that agent.
:::

## The three enforcement points

API key access is checked in three places. All three live in
`src/server/services/api-key-auth.ts`.

### authenticateApiKey

The first check on every MCP request. Validates that the key:

- Exists.
- Is not revoked (`revokedAt IS NULL`).
- Belongs to the workspace addressed by the request.
- Hashes correctly against the stored `keyHash`.

On success, returns the resolved `ApiKey` row including its scopes,
narrowing arrays, and `linkedAgentId`. On failure, the request is
rejected with `UNAUTHORIZED` before any handler runs.

### assertKeyScope

A per-entity check that runs inside individual handlers. Given a key and
a target entity (issue, project, comment, ...), it confirms the entity
is reachable under both the coarse scope **and** the narrowing arrays.

```ts
await assertKeyScope(key, {
  type: "issue",
  id: "iss_01HX",
  required: "WRITE_ISSUES",
});
// throws FORBIDDEN if the key can't write the issue
```

This is the load-bearing check for single-entity reads and mutations
(`issues.get`, `issues.transition`, `comments.create`, etc.).

### buildKeyScopeWhere

A helper that returns a Prisma `where` fragment for list queries. Used
to filter `findMany` calls so they only return rows the key can see —
without making the handler itself enumerate the narrowing arrays.

```ts
const scope = buildKeyScopeWhere(key, "issue");
const issues = await prisma.issue.findMany({
  where: { workspaceId, ...scope, status: "TODO" },
});
```

The fragment AND-s with whatever the handler is already filtering on, so
list endpoints stay narrow without the call site having to know
anything about narrowing arrays.

## Practical guidance

- **Issue keys with the smallest narrowing that still works.** A key
  that powers a per-initiative bot should carry `initiativeIds =
  [that_one]`, not full workspace scope. Keys are cheap; over-scoped
  keys are expensive when something goes wrong.
- **Don't reuse keys across agents.** Each agent gets its own key with
  its own `linkedAgentId`. Sharing keys defeats attribution and makes
  rate-limiting useless.
- **Revoke aggressively.** When a key is no longer needed (an agent is
  retired, a plugin is uninstalled), set `revokedAt`. Forge keeps the
  audit trail intact while immediately denying further use.
- **`ADMIN` is for humans-only or absolutely-trusted agents.** It
  bypasses the narrowing arrays implicitly because it can do everything.
- **Workspaces, not roles, are the security boundary.** A user with
  `MEMBER` role in workspace A and `ADMIN` role in workspace B has the
  union of those abilities — there's no global escalation. If you want
  someone out of a workspace, remove them from membership.

## Cross-references

- [Primitives](/concepts/primitives.html) — the models that carry
  `workspaceId`.
- [Activity & Audit](/concepts/activity-and-audit.html) — how access
  decisions are recorded.
- [Agents → Hermes Integration](/agents/hermes.html) — the
  `linkedAgentId` end-to-end story.
- [Automation → API Keys](/automation/api-keys.html) — the full
  `ApiKey` model and lifecycle.
