# Navigation and agent setup

Forge separates everyday work, operations, account preferences, and administration.

| Destination | Purpose |
| --- | --- |
| Home (`/`) | Your accessible open assignments, workspace shortcuts, Inbox and Activity. |
| Workspaces (`/workspaces`) | Workspaces you belong to; creation and authorized management links. |
| Mission Control (`/mission-control`) | Cross-workspace agent operations, delivery, runtime health and intervention links. |
| Agents (`/agents`) | Agent definitions, ownership, workspace access and connection setup. |
| My account (`/settings`) | Personal identity, sign-in, preferences and owned resources. |
| Administration (`/admin`) | Instance-wide people, workspaces, authentication, governance and infrastructure. |

Workspace routes remain under `/w/<slug>`. Their members, integrations and
workflow settings apply to that workspace. `/settings/workspaces` redirects
to the directory for existing bookmarks. Mission Control's former operational
dashboard remains available at `/mission-control`.

## Connect an agent

Begin in **Agents** and choose the execution intent:

- **Connect an external client**: your desktop app, CLI or MCP client executes
  the work. Choose the workspace and either your personal identity or an agent.
  Personal credentials act as the current user. Agent credentials identify the
  agent and record the issuing operator. No managed runtime is required.
- **Connect a managed runtime**: choose **Connect a runtime** and its home
  workspace, then continue to the runtime-host form. Choose the supported
  adapter (for example Hermes or Codex app server) and supply the host's
  connection details. No existing agent identity is required. You can also
  view existing runtimes without opening a new registration.
- **Configure an agent** inside managed setup: choose an existing identity or
  create/request one, then review its workspace access and runtime. Agent
  identities and hosts are separate: several identities can use one host.

Workspace owner/admin authority is required for managed setup; instance
administration alone is not workspace membership. Opening setup does not
create a credential, register a host, grant access, or dispatch work.

An existing agent with workspace access can continue directly to its scoped
MCP credential setup. Otherwise its detail page explains how an authorized
workspace administrator adds access. New agent definitions retain the existing
instance policy under Administration → Agent governance. The compatibility
default remains approval required; changing policy does not approve existing
requests, share identities, or grant workspace membership.

## Running build

The admin header and shell footers use the same `system.buildInfo` source.
They show the running version and a seven-character commit identifier in a
bounded single line. Hover/accessibility descriptions retain the full commit,
release and build timestamp; the link opens What's New. While build metadata
is unavailable the label says Forge, not an invented development version.

## Ownership, availability and authorization

These are separate facts:

- **Owner** manages the agent definition. Personal identities belong to one
  active human; service-owned identities are managed by instance administrators
  independently of the person who created them. Creation provenance grants no
  management authority and remains separate when ownership changes.
- **Catalog availability** determines whether other workspace administrators
  may select the agent. Instance availability does not make the instance its
  owner and grants no workspace membership or project visibility.
- **Workspace access** is the agent's explicit workspace association and policy.
- **Permissions** remain limited by workspace roles, project authorization,
  service-principal grants and credential scopes/narrowing as applicable.
- **Connection** identifies a client or transport. A configured runtime is not
  proof that it executed an MCP operation. A valid credential is not live presence.

Profile owners do not gain access to other workspaces' runs or client metadata
through ownership. Explicit instance administrators retain administrative
visibility. Disabled, archived and pending-approval agents are unavailable
through either workspace or global setup. Dispatch secrets are not returned
by profile/catalog read surfaces; only their configured presence is exposed.

## Runtime lifecycle safety

Runtime ownership can extend beyond the workspace where it was registered.
The existing schema still retains that registration-home relationship.
Permanent deletion of a workspace with any registered runtime is blocked,
including archived, disabled, unbound or legacy ownerless runtimes. Archiving
the workspace remains available. Runtime archival does not waive this guard.

The guard and deletion execute under a PostgreSQL workspace-row lock so a
concurrent runtime registration cannot slip between the check and deletion.
Object storage cleanup starts after these checks while the workspace still
reserves its slug, before the database row is deleted. This prevents cleanup
from deleting a new workspace's bucket after slug reuse. Storage and database
deletion remain non-atomic: a later database failure cannot restore removed
objects, and failed best-effort storage cleanup can leave orphaned objects.

## Ownership management

Administrators can create service-owned agents directly or transfer an existing
identity between personal and service ownership. Transfers use a reviewed owner
and version snapshot, validate active personal targets, and preserve sharing,
workspace access, client credentials, history and creator attribution. An
incompatible private runtime must be explicitly cleared before ownership changes.
Service profile keys are unique instance-wide; personal keys remain unique per
owner. A service identity is not a human login account.

Personal creation policy supports:

- **Disabled**: users cannot create or request personal identities; admins may.
- **Approval required**: requests remain pending until an admin approves them.
- **Self-service**: users can create their own approved, private identities.

Self-service never grants service ownership, sharing, elevated runtime access,
workspace adoption or additional credential scopes. Existing identities and
pending requests are unchanged when the policy changes.

## Runtime transfer and removal

Administration → Runtimes shows archived registrations on demand and provides
an impact preview for **Archive & disable**, **Transfer ownership / home**, and
**Remove registration**. All three require exact-name confirmation and a fresh
snapshot. Child secret/repository/configuration edits invalidate that snapshot.

Transfer/removal require the registration to be archived and disabled first.
This prevents future Forge use; it does not stop the external host or complete
its existing work. Active/unresolved runs, delivery, connections, sessions,
diagnostics and agent/profile attachments are blockers.

Ownership-only transfers may preserve terminal history in the original home.
Moving the registration home additionally requires no historical tenant-scoped
references. Credentials, repositories, GitHub App links, nonempty adapter config,
or endpoint credentials/query parameters must be reviewed and cleared in the
original home before a transfer. Nothing is silently moved across tenants.
Use a new registration when existing history prevents a home move.

Removal is for unused registrations only. The preview identifies any stored
secret/repository configuration that will be deleted; it never deletes or stops
the external runtime host. Historical registrations stay archived to preserve
evidence. New attachment of an **Unassigned** runtime requires explicit admin
adoption; existing legacy bindings are preserved until deliberately changed.

MCP management respects the same ownership rules. Service API keys do not
inherit their issuer's instance-admin role. Ownerless service registrations
remain unassigned until an administrator adopts them.

## Migration and release caution

The ownership migration preserves existing human owners and does not invent
historical creators. Ownerless runtimes become explicitly UNASSIGNED. Personal
ownership foreign keys prevent hard-deleting an owner until resources are
transferred or removed; service resources survive creator deletion.

The new ownership CHECK constraints require updated runtime writers to supply
their owner type. The production rollout must quiesce old web/worker
writers before applying this migration, then start the matching new application
and worker together. An old binary must not continue writing to the new schema.
Local validation does not authorize this production migration or deployment.

## Scope boundary

This ownership model does not replace the separate multi-user People & Access,
Teams, directory or SCIM program. No existing grants are migrated or widened.
Production migration and release require the operator-approved process in
`RELEASE.md`.
