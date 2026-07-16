# Forge Artifacts: enhancement and delivery brief

Status: research complete; AXI-86 implementation is documented in `docs/artifacts.md`

Branch: codex/artifacts-system-audit

Scope: product direction and implementation planning only; no application code changed

## Product decision

- Treat an **Artifact** as a durable working object: editable, versioned, linked to Forge work, and usable by humans and agents.
- Treat a **Publication** as an immutable, permissioned release of one artifact version.
- Use a promotion ladder: working artifact → reviewed version → shared publication → optional hosted site/app later.
- Keep draft editing separate from anything already reviewed or shared.
- Use one permission evaluator and one typed renderer registry across UI, tRPC, MCP, embeds, assets, search, export, and public routes.

## What Forge already has

- Workspace-scoped artifacts with stable slugs, types, lifecycle labels, and source provenance.
- Append-only body revisions with human/agent attribution and changelog text.
- Create, edit, promote, archive, restore, duplicate, and delete operations.
- Markdown rendering for structure, code, tables, data blocks, issue references, mentions, attachments, media, and selected embeds.
- Artifact embeds in other Markdown surfaces.
- Polymorphic attachment storage and rich file/media lightboxes.
- MCP, agent-run, Canvas, context-set, Command Center, and audit/activity integration.

## Blockers to fix before expanding the product

- **Artifact authorization:** narrowed API keys can read or mutate artifacts outside their project/initiative/label lane.
- **Safe link metadata:** the current server-side title fetch can request loopback, link-local, cloud-metadata, or private-network targets.
- **Revision truth:** draft head, saved revision, accepted content, and published content are currently conflated.
- **Concurrent editing:** there is no base-version precondition or conflict recovery, so simultaneous saves can overwrite or race.
- **Artifact ACLs:** workspace membership currently implies broad artifact mutation; there are no owner/editor/viewer grants or public-link boundaries.
- **Attachment integrity:** artifact files lack a first-class UI and audit trail, and hard deletion can orphan attachment rows and stored bytes.
- **Lifecycle consistency:** archive status and archivedAt can diverge; archived artifacts remain readable and embeddable by direct ID/slug.
- **History usability:** users cannot preview, compare, restore, link, or export a historical version.

## MVP enhancement list

- **Draft/release separation** — let authors continue editing without silently changing reviewed or shared output.
- **Immutable version browser** — open full historical content, compare any two versions, identify authorship, and restore as a new version.
- **Optimistic conflict control** — require a base version and preserve both edits when another writer has moved the head.
- **Focused artifact editor** — provide source, preview, and split modes; autosave recovery; dirty/conflict state; templates; keyboard controls; and a real focus layout.
- **Explicit render manifest** — declare Markdown, text, code, image, data, or file instead of inferring the renderer from one body string.
- **Rich Markdown contract** — add stable heading anchors/outline navigation and keep rendering consistent across detail, embed, export, and shared views.
- **Image and media presentation** — add responsive images, galleries, captions, alt text, lightbox, download, safe SVG handling, and graceful failure cards.
- **Artifact asset manager** — support upload, paste, drop, asset reuse, insertion at the cursor, replace, reorder, metadata, and permission-aware deletion.
- **Version-bound assets** — pin the exact attachment bytes/checksums used by each revision and publication.
- **Safe general link cards** — cache sanitized title, description, site, and image metadata through an SSRF-safe fetch pipeline, with a plain-link fallback.
- **Internal sharing** — support private, selected-member/group, and workspace audiences independently from owner/editor/commenter/viewer roles.
- **Revocable external links** — use hashed opaque tokens, pinned versions, expiry, noindex defaults, short-lived asset access, and immediate revoke behavior.
- **Review and publish gate** — make draft, in review, approved, and live states explicit; reuse review gates and keep agent publishing policy-controlled.
- **Server-side artifact library** — full-text search, slim list payloads, stable pagination, filters, sorts, URL state, and permission-safe snippets.
- **Baseline export** — export a selected immutable version as raw Markdown/source, assets ZIP, sanitized HTML, and readable print/PDF.
- **Security and accessibility release gate** — require CSP/sanitization/rate-limit coverage plus keyboard, focus, zoom, reduced-motion, axe, and manual screen-reader QA.

## Next enhancement list

- **Anchored comments and review threads** — discuss a paragraph, code range, table, or image and preserve quoted context when anchors drift.
- **Presence and merge-assisted collaboration** — show who is editing and resolve stale saves before considering character-level multiplayer editing.
- **Code renderer** — syntax, line numbers, wrap/search/copy/download, and line-aware diffs without execution.
- **Data/table renderer** — typed CSV/JSON preview, sort/filter, virtualization, accessible table semantics, and safe export.
- **Diagram/chart renderer** — Mermaid and one declarative chart grammar with visible source and text/table alternatives.
- **PDF/document preview** — searchable PDF viewing and inert file cards for formats without an approved conversion path.
- **Publication management** — preview, publish, update, rollback, unpublish, audience inspection, and propagation status in one surface.
- **Sharing upgrades** — groups, commenter/editor roles, invitation expiry, optional passwords, and explainable effective access.
- **Privacy-minded analytics** — documented views, approximate uniques, downloads, referrer domains, retention, and disable controls.
- **Abuse and takedown operations** — admin publishing policy, scans, report flow, quarantine, audit, incident owner, and kill switch.
- **Agent workflow parity** — exact version provenance, base-version-aware writes, coalesced checkpoints, and required human review where configured.
- **Portable archive/import** — versions, checksums, assets, authorized comments, publication metadata, and unresolved-reference reporting.

## Later enhancement list

- **Sandboxed interactive previews** — run HTML/SVG/React/declarative output only on an isolated origin with no ambient Forge credentials or network.
- **Site-class publications** — add separate preview/production deployments, pinned builds, audience enforcement, rollback, quotas, and operations.
- **Approved-domain embeds** — generate embed code only for eligible publications with per-publication frame-ancestor policy and revocation.
- **Remix/templates/branching** — create a new artifact with explicit lineage and only permitted assets; never mutate the source.
- **Custom domains/discoverability** — admin eligibility, DNS verification, certificates, canonical/social metadata, indexing controls, and takedown.
- **Connected data and AI capabilities** — use explicit per-viewer, least-privilege, metered, revocable capability tokens instead of embedded credentials.

## Recommended implementation team

- **Artifact core** — schema, version/publication semantics, diff/restore, concurrency, events, migrations, MCP parity.
- **Artifact experience** — library, editor, history, review, sharing/publishing UX, responsive and accessibility behavior.
- **Rendering and media** — renderer registry, Markdown, images/assets, files, links, code/data/diagram/PDF, export.
- **Trust and platform** — authorization, API-key narrowing, public routes/tokens, SSRF safety, CSP/sandbox, moderation, analytics, operations.
- **Integration owner** — owns permission, renderer, revision/publication, event, and version-asset contracts across all lanes.

## Delivery, merge, and deploy sequence

1. **Contract hardening:** write the Artifact/Version/Publication ADR; add characterization, permission-matrix, SSRF, lifecycle, attachment-purge, and concurrency tests; fix the critical gaps.
2. **Versions and editor:** migrate/backfill immutable revisions and draft/published pointers; dual-read/write for one release; ship history, compare, restore, and focused authoring behind a workspace flag.
3. **Permissioned sharing:** land the central policy engine, internal grants, publication previews, version-bound assets, safe link cards, review gates, and canary external links.
4. **Library and quality gate:** switch to permission-safe server search; add exports; complete responsive, accessibility, security, load, and renderer-fallback testing.
5. **Collaboration and operations:** add review threads, richer renderers, publication management, agent provenance, moderation, and operational ownership incrementally.
6. **Interactive decision gate:** approve a separate security/product ADR before sandboxed code or site hosting; require quotas, SLOs, incident runbooks, and a kill switch.
7. **Merge:** rebase thin, feature-flagged vertical slices onto the development integration branch and require lint, typecheck, full unit/integration, build, and Playwright gates. This checkout has no local dev branch, so confirm the intended remote development ref before implementation begins.
8. **Deploy:** migrate/backfill with integrity reports, deploy to staging, enable internal-only canaries, monitor conflicts/render errors/access denials/revocation SLA, then expand by workspace. Keep legacy reads and a rollback path until parity is proven.

## MVP non-goals

- Arbitrary React/HTML execution.
- Persistent app storage, forms, payments, secrets, or external API calls.
- Public search/gallery, ratings, or discovery feeds.
- Custom domains or search-engine indexing.
- Real-time character-level multiplayer editing.
- AI usage billed to artifact viewers.

## Detailed reports

- [Competitive landscape](./competitive-landscape.md) — current official ChatGPT Sites/Canvas/Visualizations and Claude Artifacts patterns with sources.
- [Current-system audit](./current-system-audit.md) — evidence-backed Forge findings with severity, file/line references, and technical gaps.
- [Implementation blueprint](./implementation-blueprint.md) — architecture, MVP/Next/Later features, dependencies, risks, acceptance criteria, migration, rollout, and release gates.
