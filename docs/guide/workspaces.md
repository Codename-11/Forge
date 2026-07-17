# Workspaces

A workspace is the tenant boundary in Forge. Every issue, project, sprint,
attachment, and audit row carries a `workspaceId`, and access is gated on
membership. This page covers identity (key vs slug vs name), members and
roles, and the workspace-level configuration knobs that govern dispatch,
SLAs, and AI features.

## Workspace as tenant

One workspace, one isolated dataset. Members of one workspace see nothing of
another, even if they share a Forge instance. All tenant-scoped procedures
in `src/server/trpc.ts` enforce this — `workspaceProcedure` requires an
active membership for the targeted workspace, and `adminProcedure`
additionally requires `OWNER` or `ADMIN` role.

A user can belong to multiple workspaces; switch between them with
<kbd>g</kbd> <kbd>w</kbd>.

## Identity: key, slug, name

Three fields describe a workspace:

| Field | Mutable? | Used for |
|---|---|---|
| `key` | **No** | Issue-id prefix (`WRK-42`) |
| `slug` | Yes | URL segment (`/w/<slug>/...`) |
| `name` | Yes | Display name |

The `key` is the load-bearing one. It's the prefix on every issue id, so
changing it after-the-fact is not a settings update — it's a data
migration. Issue keys appear in `IssueRelation` payloads, audit rows,
webhook deliveries that have already been shipped, external systems that
cached the id, and (often) commit messages. Forge does not support
in-place renames of `key` for this reason.

::: warning
Pick the `key` deliberately at creation time. Three to four uppercase
letters, related to the workspace name. If you absolutely must change it,
see the migration pattern in `DEVLOG.md` under "Phase 1 of 2026-04-20" —
but expect downtime and external coordination.
:::

`slug` and `name` are display affordances and can be changed freely. Slug
changes update the URL; old links 404. Name changes are cosmetic.

## Members and roles

Forge has four roles:

| Role | What it grants |
|---|---|
| `OWNER` | Everything an admin can do, plus delete the workspace |
| `ADMIN` | Settings, members, agents, plugins, dispatch, statuses, labels |
| `MEMBER` | Create/edit issues, projects, sprints, comments |
| `GUEST` | Read-only on issues they're explicitly added to |

Workspace admins can invite a specific email from **Settings → Members**.
Forge sends a random 256-bit bearer token, stores only its SHA-256 digest, and
requires the signed-in account email to match before creating membership. The
link supports an existing account or the instance's configured identity
provider for first sign-in. Links expire, are single-use, and can be resent or
revoked; Forge does not support domain-wide or unauthenticated auto-join.

::: info
Invitation creation, resend, revoke, and acceptance are tenant-scoped and
audited. Resend preserves the previous working token if outbound delivery
fails, then rotates it only after the provider accepts the replacement email.
:::

The compatibility `workspace.addMember` operation remains available for an
already-known Forge account. Role changes, removal, invite history, resend,
and revoke are all admin-only.

## The configurability principle

Bailey's standing rule for Forge: **prefer settings-driven values over
hardcoded defaults**. Every workspace-level knob lives as a column on
`Workspace`, not as a constant in a handler. If a number governs behavior,
it's surfaced in Settings, with a sensible default and a documented effect.

This is not a stylistic preference — it's why dispatch, SLAs, watchdogs,
and AI behavior are all tunable per workspace without touching code.

## Workspace knobs

Here's the full list of workspace-level configuration columns, grouped by
what they govern.

### Sprints and time

| Knob | Default | What it does |
|---|---|---|
| `cycleLengthDays` | 7 | Default sprint length in days |
| `cycleCooldownDays` | 0 | Gap between sprints |
| `timeTrackingEnabled` | false | Surfaces the time-tracker widget |
| `attachmentQuotaMb` | 1024 | Per-workspace MinIO quota |
| `inviteExpiryHours` | 168 | Lifetime of a newly issued or resent invitation link |

### Dispatch

| Knob | Default | What it does |
|---|---|---|
| `autoDispatch` | false | Master toggle for dispatcher |
| `autoDispatchMode` | MANUAL_ONLY | One of MANUAL_ONLY / ROUND_ROBIN / PRIORITY_MATCH / CAPABILITY_MATCH |
| `autoStartOnAssign` | false | Push webhook immediately on assign |
| `requireApprovalBeforeStart` | false | Gate dispatch behind manual approval |

See [Agents → Auto-dispatch](/agents/auto-dispatch.html) for what each
mode does and how ties are broken.

### SLAs, stalls, and acks

| Knob | Default | What it does |
|---|---|---|
| `agentIdleTimeoutMinutes` | 0 | Auto-OFFLINE sweep window (0 = disabled) |
| `assignmentSlaMinutes` | 0 | Stall detection window (0 = disabled) |
| `autoRedispatchOnStall` | false | Clear assignment on stall |
| `requiredAckSeconds` | 0 | Required-ack window after assign (0 = disabled) |
| `autoRedispatchOnNoack` | false | Clear assignment on noack |
| `slaEnforcementEnabled` | false | Enable per-issue SLA breach checks |

See [Agents → SLAs and watchdogs](/agents/slas-and-watchdogs.html) for
the timing semantics.

### AI

| Knob | Default | What it does |
|---|---|---|
| `aiEnabled` | false | Master toggle for AI features |
| `aiTriageOnCreate` | true | Run AI triage on issue create (when AI enabled) |
| `aiCoachEnabled` | true | AI Coach posts comments on stall/noack/breach |
| `aiProvider` | "hermes" | hermes / openai / anthropic / custom |
| `aiModel` | (provider default) | Override model id |

See [Agents → AI triage and coach](/agents/ai-triage-and-coach.html) for
what triage produces and when the Coach speaks up.

::: tip
All knobs are editable in Settings → Workspace. None require a server
restart; changes apply on the next request.
:::

## Reading and updating

In tRPC: `workspace.get`, `workspace.update`. The latter is admin-gated and
validates each field. Attempts to change `key` are rejected at the
validator.

```ts
await trpc.workspace.update.mutate({
  workspaceId,
  cycleLengthDays: 14,
  autoDispatch: true,
  autoDispatchMode: "ROUND_ROBIN",
});
```

Over MCP, the same surface is `workspace.update` (subject to the API key's
scope ceiling).

## Where to next

- [Settings](/guide/settings.html) — the full settings UI map.
- [Issues](/guide/issues.html) — what a workspace contains.
- [Agents → Auto-dispatch](/agents/auto-dispatch.html) — dispatch knobs in
  context.
- [Agents → SLAs and watchdogs](/agents/slas-and-watchdogs.html) — SLA
  knobs in context.
