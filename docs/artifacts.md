# Artifact Studio

Forge is the source of truth for durable artifacts. Artifact Preview is an
optional renderer/deployment target; it does not own revision, review,
permission, comment, publication, or audit state.

## State model

- `Artifact.body` and `currentVersionId` are the mutable working head and latest
  immutable saved revision.
- `acceptedVersionId` pins the revision a human owner accepted.
- `publishedVersionId` pins the revision currently selected for publication.
- `ArtifactPublication` records an audience and immutable revision. Link tokens
  are returned once, stored only as SHA-256 hashes, expire by default, and can
  be revoked immediately.
- `ArtifactDeployment` records delivery of a published revision to Artifact
  Preview. Draft saves never move accepted, published, or deployed pointers.

Editing an accepted artifact creates a new draft head while the accepted and
published revisions remain stable. Restoring history always creates a new
revision; it never rewrites or removes later work.

## Access

New artifacts default to `PRIVATE`. Existing rows are migrated to `WORKSPACE`
to preserve their prior visibility. Workspace-visible artifacts grant members
read/comment access; editing and management require creator, admin, or an
explicit `ArtifactGrant`. Grants support users and agents with `VIEWER`,
`COMMENTER`, `EDITOR`, or `OWNER` roles. API-key project/label/initiative
narrowing is applied in addition to artifact access.

Version manifests snapshot referenced attachment identifiers and integrity
metadata. An attachment referenced by any historical revision is retained.
Public asset requests must present a live publication token and the requested
attachment must appear in that pinned revision's manifest.

## Review and publishing

The normal flow is:

1. Save a draft revision with the last-seen `baseVersionId`.
2. Request review.
3. An owner accepts the pinned revision or requests changes.
4. Publish the accepted revision to a workspace audience or expiring link.
5. Optionally deploy the published revision to Artifact Preview.

Agents can create, revise, restore, comment on, and request review for artifacts
they own or were granted. Acceptance requires a human owner. Agent publication
follows `Workspace.artifactAgentPublishPolicy`: `NEVER`, `REQUIRE_APPROVAL`, or
`ALLOW`.

## Configuration

Workspace admins configure Artifact Studio under **Settings → Artifacts**.
Artifact Preview additionally requires server configuration:

```dotenv
ARTIFACT_PREVIEW_URL=https://preview.example.test
ARTIFACT_PREVIEW_TOKEN=apv7_scoped_token
```

Use an Artifact Preview token limited to artifact read/write. Forge deploys a
standalone inert render bundle and records success/failure against the exact
published version.

## MCP surface

The artifact tools include list/get/getVersion, create/update/archive,
promote, requestReview, restoreVersion, comment list/create/resolve, human
acceptance, and policy-gated publication. Writes preserve human/agent
provenance and emit Forge audit/activity records.

## Vault integration

Synology Drive and the Axiom Obsidian vault are deliberately deferred. A future
plugin can provide source discovery, import/sync, backlink mapping, and conflict
policy. The plugin should call the same artifact/version APIs and receive only
explicitly granted paths; the core product must not depend on a mounted vault.
