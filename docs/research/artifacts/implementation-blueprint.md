# Forge Artifacts: implementation blueprint

Status: implementation-ready product blueprint

Date: 2026-07-13

Scope: Forge's existing Artifacts system; no application code changed

## Product decision

Forge should treat an **Artifact** as a durable working object and a **Publication** as an immutable, permissioned release of one artifact version. That separation is the foundation for trustworthy versioning, review, sharing, rich rendering, and later interactive “site” experiences.

The near-term goal is not to clone ChatGPT Sites or Claude Artifacts. It is to bring their strongest product contracts into Forge's project-management context:

- A working draft can change without silently changing what viewers were sent.
- Every meaningful version can be inspected, compared, and restored without destroying history.
- Internal access, link sharing, and public publishing are explicit, revocable, and independently governed.
- The same content renders consistently in the artifact page, inline embeds, comments, exported files, and public views.
- Rich content fails safely: unsupported, blocked, or broken previews degrade to understandable links or files.
- Humans and agents use the same artifact APIs, audit trail, review gates, and publication rules.

## Evidence and competitive patterns

This is a code-and-product research audit, not a screenshot-based visual audit. Competitive facts below were checked against first-party product documentation on 2026-07-13.

### ChatGPT patterns worth carrying forward

- ChatGPT Sites separates a private preview from publishing and recommends saving a version before deploying, so reviewed changes do not update the live URL by accident. Forge should copy this **preview → immutable release → publish** contract, not the hosting implementation. [Creating and managing ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites)
- Sites supports owner/admin-only access, selected users or groups, workspace-wide access, and public access when admins permit it. Forge should use the same clear audience ladder and default new publications to private. [Managing ChatGPT Sites for your workspace](https://help.openai.com/en/articles/20001338-managing-chatgpt-sites-for-your-workspace)
- ChatGPT writing/code blocks offer direct editing, full-screen focus, undo/redo, source/preview switching, and specialized previews for HTML, React, SVG, Mermaid, and Vega. These are useful renderer and editor affordances for Forge, with execution kept sandboxed. [Working with writing blocks and code blocks in ChatGPT](https://help.openai.com/en/articles/20001246-working-with-writing-blocks-and-code-blocks-in-chatgpt)
- Sites makes review of files, links, forms, generated content, access settings, and visitor behavior an explicit pre-publish responsibility. Forge needs a concrete publish checklist and workspace governance before it attempts interactive public artifacts. [Understanding responsibilities for your ChatGPT Sites](https://help.openai.com/en/articles/20001337-understanding-responsibilities-for-your-chatgpt-sites)

### Claude patterns worth carrying forward

- Claude presents substantial standalone work in a dedicated artifact surface, supports a version selector, source view, copy, download, and several render types: Markdown/plain text, code, single-page HTML, SVG, diagrams, and React components. Forge should make render type and version first-class instead of inferring everything from a Markdown body. [What are artifacts and how do I use them?](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- Claude's sharing flow makes the selected version shareable; public viewers can interact, while “Customize” creates a copy rather than mutating the original. Forge should pin shared links to a reviewed release by default and make remix/duplicate an explicit later action. [Discovering, publishing, customizing, and sharing artifacts](https://support.anthropic.com/en/articles/9547008-discovering-publishing-customizing-and-sharing-artifacts)
- Claude for Work keeps artifact sharing within the organization and inherits project access. Forge should likewise prevent an artifact share from bypassing its owning project's restrictions.
- Claude warns that sharing may expose conversation attachments. Forge should deliberately do better: a publication includes only the files referenced by its pinned version or explicitly added to its release manifest—never ambient chat or issue files.
- Claude's public embeds require allowed domains. If Forge later offers embeddable publications, domain allowlists and revocation belong in the first release of that feature, not as cleanup.

## Current Forge foundation

Forge already has more backend foundation than the current UI suggests:

- `Artifact` and append-only `ArtifactVersion` models exist in `prisma/schema.prisma`; types cover documents, decisions, runbooks, reports, specs, briefs, verification logs, and notes.
- `src/server/services/artifact-service.ts` creates version 1 and snapshots a new version on body changes; create/update/archive/promote actions dual-write audit and activity records.
- `src/server/routers/artifact.ts` provides workspace-scoped list/get/render/create/update/archive/restore/duplicate/delete/promote operations.
- `src/server/services/mcp.ts` gives agents artifact list/get/create/update/archive/promote tools, and run completion can reference produced artifact IDs.
- The artifact list supports type/status filtering and client-side title/summary search; the detail page renders Markdown, offers a plain-text editor, and lists version metadata.
- `MarkdownWithAttachments` already supports headings, emphasis, strike, inline/fenced code, blockquotes, ordered/unordered/task lists, tables, issue refs, mentions, file/image tokens, data blocks, and artifact embeds.
- Artifact attachments already use the polymorphic `Attachment` model and MinIO/S3-compatible storage.
- Rich-content primitives already include image lightboxes, direct media previews, safe HTTP(S) links, link attachments, and allowlisted YouTube/GitHub/Loom/Figma embeds.
- Inline artifact cards already distinguish image, code, and Markdown heuristically and cap long previews.

## Material gaps and architecture risks

- **Draft and published state are ambiguous.** `Artifact.body` is the head body, the detail route renders it directly, and `currentVersionId` is seeded even for a DRAFT. `publish: false` may change the head without adding a version. The model cannot reliably answer “what is live?” versus “what am I editing?”
- **History is visible but unusable.** Users cannot open a historical body, compare versions, restore one, name a release, or identify a currently published version in the UI.
- **All members who can enter a workspace can read artifacts.** There are no artifact ACLs, selected-user grants, external share tokens, public routes, expirations, or access logs.
- **Search is local and incomplete.** It filters only the fetched list page and searches title/summary, not body, author, linked work, or all results.
- **Rendering is capable but implicit.** Content type is inferred from one body string; there is no explicit renderer manifest, source/preview switch, PDF/document/data renderer contract, or sandbox for executable content.
- **Link metadata fetching needs a publication-grade threat model.** Existing best-effort title scraping is useful, but public link cards require SSRF defenses, DNS rebinding protection, cache controls, redirect limits, response caps, and privacy-aware fetch behavior.
- **No review conversation exists on artifacts.** The issue/execution-step `Comment` model is not polymorphic; there are no selection anchors, resolutions, or artifact approval flow.
- **Artifact events reuse `ISSUE_UPDATED`.** This weakens notifications, audit interpretation, analytics, and plugin subscriptions.
- **Attachments are attached to the artifact identity, not a version manifest.** A historical or shared release cannot prove exactly which file bytes belonged to it.
- **No export, publication analytics, abuse controls, or content lifecycle exists.** Archive/delete are not substitutes for unpublish, revoke, retention, or legal takedown.

## Target architecture

### Core model contracts

- Keep `Artifact` as the stable workspace identity: slug, type, ownership, source provenance, linked issue/project, lifecycle, and draft pointer.
- Evolve `ArtifactVersion` into an immutable revision: content type, source body/blob reference, title/summary snapshot, checksum, renderer version, asset manifest, author, changelog, and creation reason.
- Add `ArtifactPublication`: stable publication slug, pinned `artifactVersionId`, lifecycle (`DRAFT`, `PUBLISHED`, `UNPUBLISHED`), audience, published/unpublished actor and timestamps, SEO metadata, and optional later custom domain.
- Add `ArtifactAccessGrant`: artifact or publication scope, principal (`USER`, later `GROUP`), permission (`VIEW`, `COMMENT`, `EDIT`, `MANAGE`), granting actor, and expiry.
- Add `ArtifactShareLink`: hashed opaque token, pinned publication/version, permission, expiry, revocation, optional password later, and last-used metadata. Never store the raw token.
- Add `ArtifactVersionAsset`: explicit join between a version and the attachments it renders; capture filename, MIME, byte checksum, role, caption, alt text, and ordering.
- Add `ArtifactComment` (or deliberately generalize `Comment`): artifact/version target, thread parent, selection/block anchor, status, author, mentions, and resolution metadata.
- Add dedicated artifact events (`ARTIFACT_CREATED`, `VERSION_CREATED`, `REVIEW_REQUESTED`, `PUBLISHED`, `UNPUBLISHED`, `SHARE_CREATED`, `SHARE_REVOKED`, `VIEWED`, `EXPORTED`) instead of overloading issue events.
- Keep high-volume view telemetry out of `ActivityEvent`; aggregate it into a publication analytics table/job with a short-lived, privacy-minimized raw event buffer if unique counts require one.

### API boundaries

- `artifact.*` owns working identity, editing, version inspection, diff, restore, review, and internal ACLs.
- `artifactPublication.*` owns preview, publish, unpublish, audience, share links, public metadata, and analytics.
- Public reads use a separate rate-limited route and a reduced DTO; they never run through an authenticated workspace query or expose internal IDs, provenance, comments, audit metadata, or unreferenced attachments.
- MCP mirrors human capabilities but honors the same permission evaluator and publication gates. Agent publishing should be disabled by default or require an approved review gate.
- A renderer registry accepts a version render manifest and returns a typed, sanitized view model. Pages, inline embeds, export, and public routes consume the same registry.

### Version semantics

- Autosave updates a mutable draft buffer or creates coalesced recovery checkpoints; it does not flood semantic history.
- “Save version” creates an immutable revision with an optimistic `baseVersionId`; conflicts never overwrite another writer silently.
- “Restore vN” creates a new revision from vN and records `restoredFromVersionId`; history remains append-only.
- “Publish” pins one immutable revision. Editing the draft never changes the live publication until another reviewed revision is published.
- Share links default to the pinned publication. “Always latest published” is an explicit option; never share the mutable draft implicitly.

## Delivery roadmap

Each item below is intended to be independently assignable to an implementation owner. “Dependencies” name existing Forge primitives to reuse and new contracts that must land first.

### MVP — trustworthy documents and controlled sharing

#### M1. Draft/release separation

- **User intent:** “I can keep editing without changing the artifact version my team has reviewed or shared.”
- **Dependencies:** schema migration for explicit draft and published pointers; `artifact-service.ts`; optimistic concurrency field.
- **Risks:** ambiguous backfill of existing `currentVersionId`; agents relying on current head-body behavior.
- **Acceptance:** every artifact identifies a draft revision and optional published revision; draft edits cannot change a publication; legacy rows backfill deterministically; API tests cover draft-only, published, and edited-after-publish states.

#### M2. Version browser, compare, and restore

- **User intent:** “I can inspect what changed, compare any two versions, and recover an older version without losing later work.”
- **Dependencies:** M1; server-side text diff service; history drawer/page; revision actor hydration.
- **Risks:** large-body diff latency and misleading diffs for non-text formats.
- **Acceptance:** users can open full historical content, select two text versions for unified or side-by-side diff, and restore by creating a new version; 200 KB bodies remain responsive; non-text versions get metadata/checksum comparison instead of a fake text diff.

#### M3. Focused editor with source/preview

- **User intent:** “I can write and review a substantial artifact without fighting a cramped textarea.”
- **Dependencies:** M1; existing `MarkdownWithAttachments`; existing appearance/density tokens.
- **Risks:** building a complex WYSIWYG editor too early; unsaved-change loss.
- **Acceptance:** full-width focus mode, source/preview/split views, keyboard save, autosave recovery, unsaved/conflict status, and accessible tab/focus behavior; Markdown stays the canonical MVP source.

#### M4. Explicit render manifest

- **User intent:** “Forge displays my artifact predictably instead of guessing from its first line.”
- **Dependencies:** `ArtifactVersion` migration; renderer registry; backfill inference for current content.
- **Risks:** enum churn and old clients assuming every body is Markdown.
- **Acceptance:** every new version declares `MARKDOWN`, `PLAIN_TEXT`, `CODE`, `IMAGE`, `DATA`, or `FILE`; current heuristic becomes a migration fallback only; unknown types render a safe downloadable file card.

#### M5. Rich Markdown contract

- **User intent:** “My spec or report reads like a polished document, with usable structure and links.”
- **Dependencies:** current custom renderer and URL safety tests; heading-slug utility; print styles.
- **Risks:** custom-parser edge cases; inconsistent output across inline/full/public views.
- **Acceptance:** headings have stable anchors and outline navigation; GFM-style lists, tasks, tables, quotes, code, issue refs, mentions, and footnote-safe fallback render consistently; raw HTML and scriptable URLs never execute; snapshot/accessibility tests cover all supported syntax.

#### M6. Image and media presentation

- **User intent:** “I can publish visual work with captions, useful previews, and a proper full-screen view.”
- **Dependencies:** artifact attachments, lightbox, M4, M9 version asset manifest.
- **Risks:** SVG scriptability, huge images, animated-media performance, missing alt text.
- **Acceptance:** PNG/JPEG/WebP/GIF/SVG render with intrinsic aspect ratio, responsive sizing, optional caption/alt text, keyboard lightbox, and download/open actions; SVG is sanitized or served as a non-inline file; decode failures fall back to a file card.

#### M7. Safe links and link cards

- **User intent:** “References are recognizable at a glance and remain safe when metadata cannot be fetched.”
- **Dependencies:** `Attachment.kind=LINK`, existing embed detector/fetch helpers, SSRF-safe fetch service, metadata cache.
- **Risks:** internal-network access, tracking leakage, stale or malicious titles/images, redirect abuse.
- **Acceptance:** HTTP(S)-only cards show title, host, description, and optional image after a bounded server fetch; private/reserved IPs, credentialed URLs, unsafe redirects, oversized responses, and non-HTML content are rejected; failure produces a plain hostname link; users can refresh or remove cached metadata.

#### M8. Internal sharing and permissions

- **User intent:** “I can keep an artifact private, share it with selected workspace members, or make it workspace-visible.”
- **Dependencies:** central artifact permission evaluator; `ArtifactAccessGrant`; membership/user picker; project-access inheritance rule.
- **Risks:** conflicting inherited/direct grants; GUEST leakage; expensive permission filtering.
- **Acceptance:** owner/admin-only, selected-user, and workspace audiences work in UI, tRPC, MCP, search, inline embeds, and attachments; access never exceeds a restricted owning project; revocation takes effect on the next request; permission matrix tests cover OWNER/ADMIN/MEMBER/GUEST/agent keys.

#### M9. Version-bound assets

- **User intent:** “A shared historical version always opens the exact images and files it contained when it was released.”
- **Dependencies:** `ArtifactVersionAsset`; attachment checksums; M1/M4.
- **Risks:** storage duplication and deletion of assets still referenced by old versions.
- **Acceptance:** each revision has an immutable ordered asset manifest; publishing validates every referenced file; deleting an attachment is blocked or retained while a version references it; public/private authorization is derived from the release, not ambient issue/chat access.

#### M10. Revocable share links

- **User intent:** “I can send a read-only link outside Forge and turn it off or expire it later.”
- **Dependencies:** M1, M8, M9; `ArtifactShareLink`; public reduced DTO; rate limiting.
- **Risks:** token leakage, indexing, attachment URL leakage, cached access after revocation.
- **Acceptance:** 128-bit-or-stronger opaque tokens are stored hashed; links default to read-only, pinned version, noindex, and optional expiry; creators/managers can list and revoke links; public responses expose only release content; presigned asset URLs are short-lived and scoped; revoked/expired links return a neutral unavailable page.

#### M11. Review status and publish gate

- **User intent:** “I know whether an artifact is a draft, under review, approved, or live, and publishing requires the right approval.”
- **Dependencies:** M1; existing `ReviewGate`; dedicated artifact events; permission evaluator.
- **Risks:** duplicating ArtifactStatus and ReviewGate state; agents bypassing policy.
- **Acceptance:** request-review, approve/request-changes, and publish actions have one documented state machine; configured artifacts cannot publish with an open/failed review gate; all transitions are audited; workspace setting controls whether agents may publish directly.

#### M12. Search and library baseline

- **User intent:** “I can find an artifact by title or contents regardless of which list page it is on.”
- **Dependencies:** Postgres full-text index; M8 permission predicate; list URL state.
- **Risks:** permission leaks in snippets/counts; index lag; costly wildcard search.
- **Acceptance:** server-side search covers title, summary, current permitted body, type, author, and linked issue/project; filters and sort persist in the URL; snippets never reveal inaccessible text; p95 query target is defined and measured on a production-sized fixture.

#### M13. Baseline export

- **User intent:** “I can take my work out of Forge in a portable form.”
- **Dependencies:** M4/M9; export worker for heavier formats; permission checks.
- **Risks:** remote asset leakage, broken relative links, PDF rendering differences.
- **Acceptance:** Markdown downloads with an asset folder/ZIP, rendered HTML is sanitized and self-contained where practical, and print-to-PDF produces readable headings/tables/images; export records actor/version/format; exports always use a selected immutable version.

#### M14. Security and accessibility release gate

- **User intent:** “I can trust shared artifacts to be safe and usable with keyboard or assistive technology.”
- **Dependencies:** all MVP render/share features; CSP; security test fixtures; axe/Playwright.
- **Risks:** treating automated checks as complete accessibility or security proof.
- **Acceptance:** public pages use restrictive CSP, no remote HTML injection, sanitized SVG/Markdown, safe iframe policy, rate limits, and security headers; all artifact flows work by keyboard with visible focus, semantic headings/landmarks, alt-text prompts, reduced-motion support, 200% zoom, and automated axe checks plus a documented manual screen-reader pass.

### Next — collaboration, richer files, and publishing operations

#### N1. Anchored comments and review threads

- **User intent:** “I can discuss a specific paragraph, code range, image, or table and resolve the thread.”
- **Dependencies:** M1/M8; polymorphic or artifact-specific comment model; stable block IDs/selection anchors; notifications.
- **Risks:** anchors drifting after edits; comment access outliving artifact access.
- **Acceptance:** comments may target the artifact or a version selection; orphaned anchors remain visible with quoted context; threads support mentions, replies, resolve/reopen, and permission-aware notifications; public links do not expose internal comments unless explicitly enabled.

#### N2. Edit collaboration and conflict handling

- **User intent:** “Multiple people or agents can contribute without silently overwriting one another.”
- **Dependencies:** M1/M3; base-version preconditions; SSE; optional later CRDT evaluation.
- **Risks:** premature real-time co-editing complexity.
- **Acceptance:** MVP-next ships presence and optimistic conflict resolution first; stale saves present compare/merge choices; no last-write-wins loss; real-time character co-editing remains behind an evidence-based decision gate.

#### N3. Code renderer and source tools

- **User intent:** “I can inspect code cleanly, copy or download it, and compare revisions.”
- **Dependencies:** M4; syntax-highlighting library evaluation; M2 diff; sandbox policy.
- **Risks:** bundle size, unsupported grammars, accidental execution.
- **Acceptance:** language label, line numbers, wrap toggle, search, copy, download, and syntax highlighting work without executing code; large files virtualize or fall back to download; code diff is line-aware and keyboard accessible.

#### N4. Data/table renderer

- **User intent:** “I can review tabular evidence without downloading a CSV first.”
- **Dependencies:** M4/M9; current data-block primitives; CSV/JSON parsing worker; row/column caps.
- **Risks:** browser memory, formula injection on export, misleading type inference.
- **Acceptance:** CSV/JSON/table artifacts support typed preview, sort/filter, frozen header, pagination/virtualization, accessible table semantics, and CSV download; formulas are neutralized on spreadsheet export; truncation and inferred types are disclosed.

#### N5. Diagrams and charts

- **User intent:** “I can render architecture diagrams and evidence-backed charts beside the source that created them.”
- **Dependencies:** M4; existing Mermaid package; renderer sandbox; optional Vega-Lite evaluation.
- **Risks:** XSS through labels/links, inaccessible canvas/SVG, inaccurate chart defaults.
- **Acceptance:** Mermaid and one declarative chart grammar render from visible source with error fallback; SVG is sanitized; charts include title, data table/text alternative, legend, keyboard-readable values where feasible, and downloadable source/image.

#### N6. PDF and document previews

- **User intent:** “I can read common deliverables in Forge and still download the original.”
- **Dependencies:** M4/M9; PDF renderer; file conversion policy/job queue.
- **Risks:** active document content, conversion vulnerabilities, fidelity expectations.
- **Acceptance:** PDF gets paged, searchable preview with download; text/Markdown render natively; unsupported Office formats remain clear file cards until a sandboxed conversion service is approved; no macros or active content execute.

#### N7. Publication management

- **User intent:** “I can preview, publish, update, unpublish, and see exactly what audience is live.”
- **Dependencies:** MVP publication model, M11; public route; audit events.
- **Risks:** draft/live confusion and stale CDN content.
- **Acceptance:** publication dashboard shows live version, audience, URL, last publisher, preview, share links, and recent changes; updating live requires explicit publish; unpublish invalidates public content and asset access within a defined SLA; rollback republishes an old revision as a new release action.

#### N8. Sharing upgrades

- **User intent:** “I can share with a team, comment-only reviewer, or time-limited external partner using the least access needed.”
- **Dependencies:** M8/M10; workspace groups model or integration; email delivery; optional password hashing.
- **Risks:** group lifecycle drift, forwarded invitations, password-support burden.
- **Acceptance:** selected groups, VIEW/COMMENT/EDIT roles, expirations, optional one-time invitation, and share-link password are consistently enforced; managers can inspect effective access and revoke a principal without changing the URL for everyone else.

#### N9. Publication analytics

- **User intent:** “I can tell whether a published artifact is being used without invasive tracking.”
- **Dependencies:** publication IDs; privacy-minimized event pipeline; retention setting; aggregate job.
- **Risks:** bot inflation, privacy/legal obligations, high-volume writes.
- **Acceptance:** owners see views, approximate unique visitors, downloads, referrer domains, and version over time; bot filtering and metric definitions are documented; IP/user-agent handling has a short configured retention; analytics can be disabled per workspace/publication.

#### N10. Abuse, moderation, and takedown

- **User intent:** “Admins can govern public publishing and respond to unsafe or accidental exposure.”
- **Dependencies:** admin settings, dedicated artifact events, publication management, report intake.
- **Risks:** public hosting creates operational and legal obligations.
- **Acceptance:** workspace settings control who may share externally/publish publicly; pre-publish warning and content scan run; public pages expose Report; admins can unpublish, quarantine, audit, and restore after review; incident/takedown runbook and owner are documented before public launch.

#### N11. Agent-aware artifact workflow

- **User intent:** “An agent can draft or update deliverables, while humans retain clear review and publication control.”
- **Dependencies:** MCP parity, M1/M11, run completion contracts, review gates.
- **Risks:** excessive versions, authorship ambiguity, agent publishing sensitive data.
- **Acceptance:** agent writes carry agent identity and run provenance; agents provide changelog/baseVersionId; version spam is coalesced or rate-limited; configured artifacts require human approval; completion links the exact produced version, not only artifact identity.

#### N12. Portable and machine-readable export

- **User intent:** “I can archive or migrate artifacts with versions, metadata, links, and assets intact.”
- **Dependencies:** M13; data-portability router; version asset manifests.
- **Risks:** very large archives and accidental export of inaccessible linked entities.
- **Acceptance:** JSON/ZIP export includes artifact metadata, permitted version history, checksums, asset manifest, comments when authorized, and publication metadata; imports validate schema/checksums and report unresolved Forge links rather than dropping them.

### Later — interactive artifacts and site-class publishing

#### L1. Sandboxed interactive previews

- **User intent:** “I can safely interact with an HTML, SVG, React, Mermaid, or Vega artifact beside its source.”
- **Dependencies:** M4, N3/N5, isolated render origin, build service, CSP/iframe messaging contract.
- **Risks:** arbitrary code execution, network/data exfiltration, dependency supply chain, resource abuse.
- **Acceptance:** interactive code runs only in a separately isolated origin/worker with no ambient Forge credentials, no network by default, explicit capability grants, CPU/memory/time limits, dependency allowlist/lockfile, console/error view, and a guaranteed source-only fallback.

#### L2. Site-class publications

- **User intent:** “I can turn a reviewed artifact into a polished hosted microsite or lightweight internal app.”
- **Dependencies:** L1, publication pipeline, asset bundling, deployment records, preview environments, N10 operations.
- **Risks:** this changes Forge from document sharing into application hosting; uptime, privacy, abuse, storage, logs, secrets, and data residency become product obligations.
- **Acceptance:** private preview and production deployments are distinct; every deploy pins source/version/build/checksum; audience/RBAC applies at edge; rollback is one action; forms, storage, secrets, external network, and authentication are unavailable until separately designed and governed.

#### L3. Embed published artifacts elsewhere

- **User intent:** “I can place a Forge publication in an approved external site without making it universally embeddable.”
- **Dependencies:** publication route, L1/L2, frame-ancestor policy, per-share domain allowlist.
- **Risks:** clickjacking, token leakage, third-party cookie/privacy behavior.
- **Acceptance:** embed code is available only for eligible publications; allowed domains are mandatory and validated; `frame-ancestors` is generated per publication; revocation stops future embeds; direct links remain a safe fallback.

#### L4. Remix, templates, and branching

- **User intent:** “I can reuse a good artifact as a new independent starting point without changing the original.”
- **Dependencies:** version/export contracts; permission/licensing metadata; lineage model.
- **Risks:** copying restricted data or unclear ownership/licensing.
- **Acceptance:** Duplicate/Remix creates a new artifact with explicit source lineage and only permitted assets; public creators may disable remix; reusable templates define required fields and default structure without inheriting comments, share links, or secrets.

#### L5. Custom domains and discoverability

- **User intent:** “Approved public artifacts can use a trusted domain and deliberate search metadata.”
- **Dependencies:** L2; DNS verification; certificate automation; N10; SEO settings.
- **Risks:** phishing/impersonation, certificate/DNS support load, accidental indexing.
- **Acceptance:** admins control custom-domain eligibility; domains are verified and continuously checked; canonical URL, title, description, social image, sitemap/indexing, and takedown work; private/link-only publications always emit noindex.

#### L6. Connected data and AI-powered artifacts

- **User intent:** “An interactive artifact can use approved Forge data or an agent capability without exposing credentials.”
- **Dependencies:** L1/L2; capability tokens; per-user authorization; metering; consent and audit model.
- **Risks:** prompt injection, data exfiltration, confused deputy, cost abuse, privacy obligations.
- **Acceptance:** capabilities are explicit, least-privilege, per-viewer, revocable, metered, and visible before use; creators never embed raw API keys; public users cannot access creator/workspace data; audit logs identify capability, actor, artifact version, and result class.

## Cross-cutting implementation rules

### Permissions

- Centralize one permission evaluator and call it from tRPC, MCP, public routes, search, embeds, attachments, comments, export, and analytics.
- Deny by default. Workspace membership alone should not bypass artifact-specific or owning-project restrictions.
- Separate permission to edit an artifact from permission to publish it publicly.
- Add workspace settings rather than hardcoded policy: external sharing enabled, public publishing enabled, eligible roles, default link expiry, agent publish policy, analytics enabled/retention, and allowed embed providers.

### Rendering and content safety

- Keep unknown content inert. Never inject remote HTML into Forge's origin.
- Use a renderer registry keyed by explicit version content type and renderer schema version.
- Sanitize at render time with a maintained allowlist; preserve original source bytes for export and future renderer upgrades.
- Run active previews on an isolated origin with sandbox attributes and a minimal postMessage protocol.
- Proxy or fetch metadata/media only through an SSRF-safe service; unknown URLs stay links.
- Store content checksum and asset checksums on each version so publication/export integrity is testable.

### Accessibility

- Treat the source/preview/version/share controls as one keyboard-operable workflow, not a collection of mouse-only panels.
- Preserve logical heading order, landmarks, visible focus, text alternatives, responsive reflow, and reduced motion in internal and public views.
- Pair every chart/diagram with source or a text/table alternative; do not rely on color alone for status or diff meaning.
- Include artifact fixtures in the existing Playwright + axe suite and conduct manual screen-reader testing before public sharing launches.

### Observability and operations

- Record all content, permission, review, publication, revocation, export, and admin actions in audit logs with human/agent attribution.
- Define SLOs for publication availability, revoke/unpublish propagation, metadata fetching, render failures, export jobs, and analytics lag.
- Emit structured renderer errors by content type/version, but never include artifact body or share tokens in logs.
- Add storage, render, link-fetch, export, and public-view quotas to workspace settings/metrics before site-class publishing.

## Migration and rollout plan

### Phase 0 — contract hardening (one team, 1–2 iterations)

- Write an ADR for Artifact vs Version vs Publication semantics and freeze names before schema work.
- Add characterization tests around current create/update/`publish:false`/currentVersion behavior, MCP output, inline embeds, and attachment authorization.
- Add dedicated artifact event enum values and central permission/render interfaces behind no-op defaults.
- Define production-sized fixtures and baseline list/detail/render performance.

### Phase 1 — versions and editor (two parallel tracks, 2–3 iterations)

- **Data/API track:** M1, M2 backend, M4, migration/backfill, concurrency, audit events.
- **Product/UI track:** M2 UI, M3, M5, compact/full artifact layouts.
- Dual-read legacy `body/currentVersionId` while new pointers are backfilled; dual-write during one release; provide rollback that leaves old columns valid.
- Exit only when current internal artifacts round-trip without body, attachment, author, slug, or MCP behavior loss.

### Phase 2 — permissioned sharing (three parallel tracks, 2–4 iterations)

- **Access track:** M8, M10, central policy tests, public reduced DTO.
- **Content track:** M6, M7, M9, publication-safe fallbacks.
- **Review/release track:** M11, publication preview, audit/event integration.
- Roll out internal selected-user access first, then time-limited external links to canary workspaces; keep public indexing disabled.

### Phase 3 — library, export, and quality gate (2 iterations)

- M12, M13, M14 plus load/security/accessibility testing.
- Backfill search indexes asynchronously and compare old/new list result counts before switching reads.
- Make new artifact pages the default only after error rate, render fallback rate, and save-conflict metrics meet thresholds.

### Phase 4 — collaboration and operations (incremental)

- Deliver N1–N12 in vertical slices, prioritizing anchored review, publication management, PDF/data/code renderers, agent provenance, and abuse operations.
- Public publishing stays feature-flagged until N10 is operational and an owner/on-call/takedown process exists.

### Phase 5 — interactive/site-class decision gate

- Run a security and product ADR before L1. Do not infer that existing Markdown embeds are sufficient isolation for arbitrary HTML/React.
- Launch source/preview for declarative formats first; then an isolated interactive runtime; then hosted sites, embeds, domains, and connected capabilities.
- Each step requires its own threat model, quotas, incident runbook, and kill switch.

## Backfill specifics

- For each existing artifact, preserve `body` as a new immutable revision if its checksum does not equal the pointed version body.
- Interpret the newest body-equivalent revision as the working draft. Treat `ACCEPTED` artifacts as having that revision published; leave DRAFT/IN_REVIEW unpublished unless product owners explicitly choose a different historical rule.
- Set `restoredFromVersionId` only for future restores; do not invent lineage for legacy versions.
- Build version asset manifests by parsing Forge attachment tokens and artifact-scoped attachments; flag ambiguous/unreferenced assets for review rather than silently publishing them.
- Backfill explicit content type using the current image/code/Markdown heuristic, mark it `inferred=true`, and let the next edit confirm or change it.
- Preserve legacy slug URLs with redirects if publication slugs become distinct.
- Run integrity reports before and after: artifact count, version count, body checksums, current/published pointer validity, asset references, workspace IDs, and orphan rows.

## Recommended team split

- **Artifact core:** schema, service semantics, version/diff/restore, concurrency, audit events, MCP parity.
- **Artifact experience:** library, focus editor, history, review, share/publish UX, responsive/accessibility behavior.
- **Rendering/media:** renderer registry, Markdown, images, files, data/code/diagram renderers, export.
- **Trust/platform:** ACLs, public routes, token security, SSRF-safe metadata, CSP/sandbox, moderation, analytics, operations.
- Appoint one integration owner for shared contracts: permission evaluator, render manifest, version/publication semantics, events, and version-bound assets. Teams should merge thin vertical slices behind workspace flags, not long-lived subsystem branches.

## Release gates and definition of done

- No artifact body, version, asset, comment, or publication can cross `workspaceId` boundaries in API, MCP, search, share, export, or cache keys.
- A draft edit cannot mutate a pinned shared or published release.
- Restore and rollback are append-only and attributable.
- Effective access is explainable in the UI and covered by a role/principal matrix test.
- Revocation/unpublish invalidates content and asset access within the documented SLA.
- Unsupported or failed rich content always leaves a usable source/file/link fallback.
- Public content executes no arbitrary code in Forge's authenticated origin.
- Internal, shared-link, and public views pass keyboard/zoom/axe checks; manual screen-reader results are recorded.
- Every release path has unit/integration tests plus Playwright coverage for create → edit → version → review → share/publish → revoke/unpublish → restore.
- DEVLOG, API/MCP reference docs, admin policy docs, migration notes, and incident/takedown runbook ship with the feature.

## Explicit non-goals for MVP

- Arbitrary React/HTML execution.
- Persistent app storage, forms, payments, secrets, or external API calls.
- Custom domains or search-engine discovery.
- Real-time character-level multiplayer editing.
- Public gallery, ratings, or discovery feed.
- AI usage billed to artifact viewers.

These are valuable only after Forge proves the core promise: artifacts are durable, reviewable, permissioned outputs whose exact versions can be trusted.
