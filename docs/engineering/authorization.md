# Authorization boundaries

Forge keeps authentication, workspace membership, project access, API-key
narrowing, and external-credential authority as separate layers. A successful
login never grants workspace, project, or integration access by itself.

## Project access

Projects are either `WORKSPACE` or `RESTRICTED`.

- Workspace owners and admins inherit full project access.
- Members inherit read and contribute access only for `WORKSPACE` projects.
- Guests do not inherit project access.
- Explicit grants are `VIEWER`, `CONTRIBUTOR`, or `MANAGER` and belong to a
  workspace membership. A `MANAGER` may maintain that project's access list.

Collection queries must compose the shared project/issue visibility predicate.
Direct reads return `NOT_FOUND` when the caller cannot read the underlying
project, so restricted resource existence is not disclosed. Mutations assert
the required action at the destination and, for moves, at the source as well.
Assignment, authorship, watching, an artifact grant, or a canvas reference does
not widen project access.

The same floor applies to comments, relations, files, artifacts, plans, runs,
goals, canvases, context sets, analytics, activity, notifications, realtime
events, search, dashboards, Command Center, standups, and Today views. Durable
workers may operate across a workspace, but human-facing fanout and hydration
must be filtered for the recipient.

## Integration access

External access is deliberately two-stage:

1. `ConnectionAuthorization` records credential-owner consent for one mapping,
   its exact credential source, capability ceiling, security-policy digest,
   and revocation state.
2. `IntegrationGrant` authorizes an exact user, agent, API key, or workspace
   automation principal for a workspace or project and an explicit capability
   set.

The effective permission is the intersection of current workspace membership,
project access, an active principal grant, active credential-owner consent,
mapping state and direction, API-key scope/narrowing, and provider or GitHub App
authority. Workspace administration does not bypass credential consent.
Changing security-sensitive mapping fields invalidates the authorization
digest; disconnecting or removing a personal credential pauses its mappings
and revokes consent. Workspace-App authority is kept separate from the human
who originally configured it. Switching credential source or exact App binding,
or shrinking the authorized capability ceiling, revokes every derived grant so
principals must be reviewed against the new consent boundary.

Capabilities are explicit: `READ`, `IMPORT`, `LINK`, `SYNC`, `WRITE`, and
`ADMIN`. Callers must hold every capability required by an operation; `ADMIN`
does not imply provider data permissions.

## API keys and revocation

Personal and session keys act as the current human user. Every request
revalidates the user's active state, workspace membership, current role, and
project grants. Stored project, label, and initiative restrictions remain an
additional ceiling and can never widen access. Role demotion immediately
removes effective `ADMIN` authority.

Agent and plugin keys are service principals. Their issuer is audit
attribution, not inherited authorization, so suspending an issuer does not
silently disable unrelated automation. Integration use still requires a grant
for the exact service principal.

Membership removal and user suspension/deletion revoke human keys and user
integration grants immediately. Revoked grant rows are retained for audit;
they are not cascade-deleted with membership removal.

## Implementation rules

- Every authorization row and foreign-key path is tenant-scoped by
  `workspaceId`.
- Use the central project and integration authorization services; do not
  reproduce role checks in individual routers.
- Filter list, count, aggregate, notification, hydration, and realtime paths as
  well as direct reads and writes.
- Write audit/activity records in the same transaction as grant, consent, and
  revocation changes.
- Never return credential secrets, token material, key hashes, or unauthorized
  principal metadata from management queries.
