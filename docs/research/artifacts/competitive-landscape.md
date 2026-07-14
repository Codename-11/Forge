# Artifact systems: competitive landscape

Research date: 2026-07-13. Sources are current official OpenAI and Anthropic documentation. “Not documented” means the reviewed official material does not establish the capability; it is not proof that the product lacks it.

## Executive read

- The strongest model is a **promotion ladder**, not a single catch-all artifact: conversational output → editable/versioned document or code → shareable interactive snapshot → durable hosted app/site.
- **Version and publication must be separate concepts.** ChatGPT Sites explicitly separates saving a reviewable version from deploying it; Claude Code Artifacts publishes each update as a version and can pin viewers to a chosen version.
- **Sharing and editing are separate grants.** ChatGPT Sites sharing is visit-only. Claude Code Artifacts adds viewer/editor roles, while Claude’s consumer “Customize” action creates a fork instead of changing the original.
- Rich rendering is a first-class type system in Claude Artifacts (Markdown, code, HTML, SVG, diagrams, React). OpenAI splits similar jobs between Canvas, Visualizations, and Sites.
- Governance is part of the product, not an admin afterthought: audience scopes, public-sharing policy, retention, audit events, takedown, secret handling, sandboxing, and destructive-delete warnings all need explicit lifecycle states.
- Neither vendor’s reviewed docs promise document-level URL unfurls or link-card rendering. Forge should treat safe link cards and controlled embeds as a deliberate capability, not assume parity behavior.

## Capability comparison

| Area | ChatGPT Sites / Canvas / Visualizations | Claude Artifacts | Product lesson for Forge |
|---|---|---|---|
| Core model | Canvas is an editable writing/code surface; Visualizations are conversation-scoped interactive explanations; Sites are persistent hosted websites/apps/games. | Claude app Artifacts are standalone documents/code/apps beside a chat; Claude Code Artifacts are live single-page captures published from a coding session. | Preserve one artifact identity, but make render type and publication target explicit. Avoid forcing static notes, media, and runnable apps through one renderer. |
| Versioning | Canvas provides history, restore, and diffs. Sites separates **save version** from **deploy version** and associates local builds with a Git commit. | Claude app has a version selector and conversation branching. Claude Code makes every publish a version at the same URL; sharing can target a selected version or follow updates. | Use immutable revisions plus a mutable artifact head; add compare, restore-as-new-revision, publication pointers, and source provenance. |
| Sharing | Sites supports owner/admin, selected users/groups, workspace, or internet audiences; sharing permits visiting, not editing. Canvas shares through a conversation-like action. Visualizations use conversation sharing. | Consumer artifacts can be public without sign-in; Team/Enterprise conversation artifacts are internal. Claude Code supports private, named org members, org-wide, and public when enabled; editor roles are available on Team/Enterprise. | Model audience and role independently: `viewer`, `editor`, `owner`; `private`, `named`, `workspace`, `public-link`. |
| Collaboration | Sites docs describe iterative authoring with ChatGPT but not co-edit access. | “Customize” forks an artifact into a new conversation; Claude Code editors can publish new versions from their own sessions. Shared-storage apps can support collaborative runtime data. | Support both fork/remix and controlled co-authoring. Record author per revision and never silently mutate the source artifact. |
| Rich content | Canvas renders documents, code, and sandboxed React/HTML; its document editor exposes only basic Markdown formatting. Visualizations cover charts, maps, diagrams, calculators, simulations, and explainers. Sites can host full web experiences and persistent file/data-backed apps. | Explicit types include Markdown/plain text, code, single-page HTML, SVG, diagrams/flowcharts, and interactive React. Claude Code accepts Markdown or HTML, styles Markdown, embeds images, and allows inline JavaScript under a strict CSP. | Build a renderer registry with a safe native path for Markdown/media and a separately sandboxed path for runnable HTML/apps. |
| Images and files | Sites supports uploaded files via object storage and tells publishers to review generated images, files, and links. Canvas web previews can load images subject to network controls. | SVG is native artifact content. Claude Code embeds images as data URIs and caps the rendered page at 16 MiB; Claude app persistent storage is text-only and does not store images/files/binary data. | Treat image assets as versioned attachment references with previews, dimensions, alt text, quotas, and explicit public-access checks. Do not bury binary data in document revisions. |
| Links / cards / embeds | Sites can contain links as normal site content. Canvas can load external resources when network access is permitted. Reviewed docs do not specify automatic URL cards/unfurls. | Public Claude app artifacts can be embedded on allowed domains. Claude Code blocks external resource requests and relative links; reviewed docs do not specify automatic document URL cards/unfurls. | Add server-side, cached, sanitized link previews as an explicit block type. Gate rich embeds by provider allowlist and permission; always offer a plain-link fallback. |
| Apps and live data | Sites supports relational data, file storage, workspace/public authentication, and hosted secrets. Visualizations are generally snapshots rather than synchronized dashboards. | Claude app artifacts can call Claude, use MCP tools with per-user authentication/approval, and use limited personal/shared persistent storage. Claude Code Artifacts are deliberately backend-free static pages with no view-time API calls. | Declare runtime class per artifact: `static`, `interactive-local`, or `hosted-app`. Each class needs different security, persistence, and availability promises. |
| Export / portability | Canvas exports documents to PDF, Markdown, and Word; code exports in its detected file extension. Sites can link to a local source project, but reviewed docs do not describe a generic Site export/archive flow. | Claude app supports code view, clipboard copy, and file download. Claude Code writes the source as local `.html`/`.md`; compliance APIs can retrieve a specific artifact version. | Provide raw-source download, rendered export where meaningful, and a complete revision archive with metadata/assets. |
| Lifecycle / governance | Sites remain after the creating task ends. Publishing and access are reversible, but permanent Site deletion cannot be restored. Enterprise can gate create/publish via RBAC; public publishing is off by default. Sites is beta and currently lacks data/inference residency. | Unpublish revokes access; for consumer artifacts it cannot be republished and deletes persistent storage. Claude Code offers retention controls, audit events, public-sharing policy, and compliance APIs for list/retrieve/delete. | Make archive, unpublish, revoke, delete, and purge distinct. Show impact previews, especially for public URLs and attached runtime data. Keep audit events for every visibility and lifecycle change. |

## Product patterns worth copying

### 1. Revision graph with explicit publication pointers

- Every edit creates an immutable revision containing content, type, author/agent, timestamp, source run, source issue/project, and asset references.
- `currentRevisionId` identifies the working head; a publication stores `publishedRevisionId` separately.
- Support “save revision,” “publish this revision,” “publish latest automatically,” “compare,” and “restore as a new revision.”
- Keep a stable artifact URL while allowing a share link to pin a revision. Display whether a viewer is seeing latest, published, or historical content.
- Attach build/deployment status and logs to the revision, not to the artifact globally.

Intent: match ChatGPT Sites’ review-before-deploy safety and Claude’s stable-URL, multi-version continuity without making ordinary edits immediately public.

### 2. Typed, progressive rendering

- Native renderers: Markdown, plain text, code, image, image gallery, file/download, diagram/SVG, table/data, and link collection.
- Rich blocks inside Markdown: attachments, image captions, callouts, issue/project references, and safe link cards.
- Interactive renderer: sandboxed HTML/React with strict CSP, no ambient Forge credentials, explicit network policy, and clear failure states.
- Hosted-app tier: opt-in runtime with declared storage, authentication, secrets, network/MCP access, quotas, and owner responsibility.
- Always expose source/raw view and a fallback readable representation when a renderer fails.

Intent: provide Claude-like breadth while preserving the OpenAI distinction between a lightweight visualization and a durable application.

### 3. Safe links, link cards, and embeds

- Store the canonical URL and a point-in-time preview payload (title, description, image, site name, fetched-at, status).
- Fetch metadata server-side with SSRF protection, redirects/size/time limits, private-network blocking, and sanitization.
- Refresh only on demand or policy-controlled expiry; clearly mark stale or unavailable previews.
- Render compact, standard-size cards by default with expand/open/copy actions and a plain-link fallback.
- Treat embeds as a separate trusted-provider feature. Require provider allowlisting, sandbox attributes, and an explicit user action before third-party content loads.

Intent: make links genuinely useful in reports and decision artifacts without inheriting the privacy and execution risks of arbitrary embeds.

### 4. Sharing, remixing, and collaboration

- Audience presets: private, named workspace members/groups, entire workspace, public link.
- Roles: owner, editor, viewer; publishing permission can be narrower than editing permission.
- “Duplicate/remix” creates a new artifact with provenance back to the source revision; it never mutates the original.
- Optional co-author mode records the author and source run for each revision; resolve concurrent updates by creating branches rather than overwriting.
- Public links support revoke/rotate, optional expiry, discoverability controls, and a viewer-safe presentation without internal comments or source context.

Intent: combine ChatGPT’s explicit audience controls with Claude’s fork/remix and editor workflows.

### 5. Complete lifecycle and governance

- States: draft → reviewable → published; orthogonal lifecycle states: active, archived, revoked, deleted, purge-pending.
- Separate artifact content from publication, share grants, deployments, and runtime data so each can be revoked or retained independently.
- Warn before destructive actions; show affected URLs, audiences, stored data, and dependent embeds.
- Audit create, revise, compare/restore, publish, visibility change, export, archive, delete, and purge.
- Workspace settings for public sharing, allowed artifact/runtime types, link-preview policy, network/connector access, retention, quotas, and data residency constraints.
- Admin inventory with owner, audience, last publish, storage, external dependencies, and takedown controls.

Intent: make the artifact system safe enough for agent-created outputs to become durable workspace knowledge or public deliverables.

## Surface-specific cautions

- **OpenAI’s surfaces are intentionally different.** A Visualization is generally a conversation snapshot; Sites is the durable, permissioned, persistent destination. Forge should offer an explicit “promote to artifact/site” path rather than pretending every inline result is already a maintained publication.
- **ChatGPT Canvas is not a full rich-text editor.** Official docs list only basic Markdown controls even though code canvases can render React/HTML. Forge should avoid conflating document editing controls with rendered-output capability.
- **Anthropic sharing rules vary by surface.** Claude conversation Artifacts documentation says Team/Enterprise artifacts are organization-only, while Claude Code documentation says public sharing can be enabled by an owner. Forge should use one consistent policy model with per-artifact-type restrictions instead of surface-specific ambiguity.
- **Runnable output needs a visible trust boundary.** Canvas may request permission for third-party network communication; Claude Code disables external requests entirely. Forge should display the artifact runtime class and permissions before execution.
- **Deletion can destroy runtime data.** Both ChatGPT Sites and Claude Artifacts document irreversible deletion behavior. Forge should default to revocation/archive and reserve purge for an explicit, audited action.

## Official sources

- OpenAI, [Sites — ChatGPT Learn](https://learn.chatgpt.com/docs/sites): persistent projects; save-versus-deploy versions; Git commit association; access scopes; storage, auth, and secrets.
- OpenAI Help Center, [Creating and managing ChatGPT Sites](https://help.openai.com/en/articles/20001339): availability, custom domains, audience controls, publishing, and irreversible deletion.
- OpenAI Help Center, [Managing ChatGPT Sites for your workspace](https://help.openai.com/en/articles/20001338-managing-chatgpt-sites-for-your-workspace): RBAC, public-publishing controls, administration, and residency caveats.
- OpenAI Help Center, [What is the canvas feature in ChatGPT and how do I use it?](https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt): version history/diffs/restore, sharing, export formats, Markdown editing, React/HTML sandboxing, and network controls.
- OpenAI, [Visualizations — ChatGPT Learn](https://learn.chatgpt.com/docs/visualizations): interactive result types, snapshot semantics, conversation sharing, variable exports, and promotion to Sites.
- Anthropic Help Center, [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them): supported content types, versions, direct Markdown editing, export, AI/MCP capabilities, and persistent storage.
- Anthropic Help Center, [Publish and share artifacts](https://support.claude.com/en/articles/9547008-publish-and-share-artifacts): public and organization sharing, selected-version publication, embedding, unpublish behavior, and Customize/fork semantics.
- Anthropic, [Share session output as artifacts — Claude Code Docs](https://code.claude.com/docs/en/artifacts): stable live URLs, per-publish versions, viewer/editor collaboration, static-page constraints, retention, audit events, and Compliance API support.
