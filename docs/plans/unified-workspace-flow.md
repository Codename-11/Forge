# Forge Unified Workspace Flow — Notes • Dashboard-Canvas • Full Figma • Storyboard

> Execution plan. Workstreams are largely parallelizable behind a shared
> schema landing; each declares its scope, files, agent allocation, and
> verification gate. Built for an **agent team** running in parallel
> after Workstream A (schema) merges.

## Goal

Forge becomes a single unified human/agent workspace for tasks, issues,
projects, sprints, ideas, planning, and design. The canvas is the
canonical *working surface* — not a side feature — and the structured
views (Inbox, lists, queues) are alternate lenses on the same data.

Four big moves, all together:

1. **Notes upgraded** — existing Note primitive becomes the lightweight
   idea/goal surface. Add lifecycle status + a Convert-to-X path. No new
   primitives.
2. **Dashboard-as-canvas** — every user gets a Personal canvas. The
   dashboard route flips between List view (current Inbox) and Canvas
   view (spatial). The Today zone auto-arranges; the rest is free.
3. **Full Figma on the canvas** — frames, multi-page, groups,
   components & instances with overrides, auto-layout, constraints,
   design tokens (color/text/effect styles), alignment + distribute +
   snap, layers panel, full multi-select. Confirmed: full Figma scope,
   not the cheap floor.
4. **Storyboard grammar for agents** — compound MCP gestures
   (`canvases.storyboard*`) so chatting with the agent produces real
   spatial layouts: plan card + chat thread + sources column + notes
   lane, all framed and aligned.

Plus a cross-cutting **canvas polish pass** — the user-flagged
unpolished interactions: connector-draw latency, missing tool cursors,
incomplete multi-select. These get fixed alongside the Figma work
because they share the same interaction layer.

---

## Locked scope decisions

- **Full Figma**, not the cheap floor. Components, auto-layout,
  multi-page, design tokens all in scope.
- **All workstreams together** behind a shared schema landing. Agent
  team parallelizes after Workstream A.
- **Notes stays single primitive.** Add `Note.status` enum (IDEA |
  SOMEDAY | ACTIVE | ARCHIVED). Existing `kind` (NOTE | JOURNAL) is
  orthogonal and unchanged.
- **Frames are first-class**, not a shape variant. Distinct model
  (`CanvasFrame`) so they can own children, act as pages, and host
  auto-layout config without polluting `CanvasShape`.
- **Components live as workspace-level reusable definitions**, instanced
  per canvas with override JSON. Cross-canvas reuse from day one.
- **Multi-page** = a canvas can hold multiple top-level frames marked
  `isPage = true`. No second model layer.

---

## Workstream map

```
                      ┌─────────────────┐
                      │   A — Schema    │  ← lands first, unblocks rest
                      └────────┬────────┘
                               │
        ┌──────────┬───────────┼───────────┬──────────┬──────────┐
        │          │           │           │          │          │
        ▼          ▼           ▼           ▼          ▼          ▼
   B — Canvas  C — Styling  D — Notes  E — Dashboard F — Polish  G — Agent
   core        & layers    upgrade    -as-canvas   & a11y     storyboard
   (frames,   (tokens,    (status,   (Today zone, (cursors,   (MCP +
   groups,    components, promote,   view toggle, multi-      prompts +
   auto-     layers       inbox      pinning)     select,     Hermes)
   layout,   panel)       surfacing)              perf)
   align)
```

Workstreams B–G run in parallel after A. Cross-stream deps are flagged
inline.

---

## Workstream A — Schema (lands first)

**Agent**: 1 backend.
**Why first**: every other stream depends on these tables existing.

**Migrations**

- `Note.status` enum field: `IDEA | SOMEDAY | ACTIVE | ARCHIVED`,
  default `IDEA`. Backfill existing rows to `ACTIVE`. New index on
  `(workspaceId, userId, status, updatedAt)`.
- `Note.promotedToType` + `Note.promotedToId` (nullable string pair,
  polymorphic forward link to `issue | project | initiative`).
- Reverse link: `Issue.sourceNoteId`, `Project.sourceNoteId`,
  `Initiative.sourceNoteId` (all nullable cuids).
- `WorkspaceCanvas.kind` enum: `PROJECT | INITIATIVE | CYCLE | ISSUE |
  PERSONAL | DESIGN`. Default current behavior maps to `PROJECT` (or
  null-anchor default). `PERSONAL` is auto-provisioned per user;
  `DESIGN` is the new "designs file" canvas type that supports pages.
- `WorkspaceCanvas.ownerUserId` (nullable) — set for `PERSONAL`.
- `WorkspaceCanvas.activePageId` (nullable) — current page for
  multi-page canvases.
- New model **`CanvasFrame`** — `id, workspaceId, canvasId, parentFrameId
  (nullable), name, x, y, width, height, isPage (bool), autoLayout
  (Json — direction/gap/padding/align/justify or null), constraints
  (Json), backgroundFill (Json), z, createdAt, updatedAt`. Indexes on
  `(canvasId, parentFrameId, z)` and `(canvasId, isPage)`.
- New model **`CanvasGroup`** — `id, workspaceId, canvasId,
  parentFrameId (nullable), name, z, createdAt`. Groups are non-visual
  transform containers.
- New model **`CanvasComponent`** — workspace-scoped reusable
  definition. Fields: `id, workspaceId, name, description, thumbnail
  (nullable), definition (Json — node/shape/frame tree), createdById,
  createdAt, updatedAt, archivedAt`. Indexed on `(workspaceId,
  archivedAt, updatedAt)`.
- New model **`CanvasComponentInstance`** — placed instance of a
  component. Fields: `id, workspaceId, canvasId, componentId, x, y,
  width, height, overrides (Json), z, parentFrameId (nullable)`.
- New model **`CanvasStyle`** — workspace-scoped reusable style.
  Fields: `id, workspaceId, kind (COLOR | TEXT | EFFECT), name,
  value (Json), createdAt`. Indexed `(workspaceId, kind)`.
- Add `parentFrameId` (nullable) + `groupId` (nullable) to
  `WorkspaceCanvasNode` and `CanvasShape`. Add `z` (int, default 0) for
  in-frame stacking order.
- Add `lockedAt`, `hiddenAt` (both nullable timestamps) to
  `WorkspaceCanvasNode`, `CanvasShape`, `CanvasFrame`, `CanvasGroup`,
  `CanvasComponentInstance` for layer panel hide/lock.

**Done = ** migration 00XX merged, generated, applied locally. Zod
schemas regenerated. No router work yet — that's per stream.

---

## Workstream B — Canvas core: frames, groups, auto-layout, alignment

**Agent**: 1–2 frontend + 1 backend.
**Depends on**: A.

**Scope**

- **Frames**
  - Toolbar `F` to draw. Click-drag rectangle creates a `CanvasFrame`.
  - Children inside a frame move with it; resize doesn't resize children
    unless auto-layout enabled.
  - Frames render with title bar (name editable inline) and an optional
    background fill.
  - Frames can be nested (`parentFrameId`). `isPage=true` frames render
    as page tabs at top of canvas.
- **Multi-page canvases** (`DESIGN` kind)
  - Page tab bar above canvas viewport. Click switches `activePageId`.
  - Add page (`+` tab), rename, reorder, delete (with confirm).
  - Switching pages persists viewport per-page in `viewport` JSON.
- **Groups**
  - `Cmd+G` / `Cmd+Shift+G` to group/ungroup multi-selection.
  - Non-visual; just a transform unit. Members share a `groupId`.
- **Auto-layout** (per-frame `autoLayout` config)
  - Direction: horizontal | vertical.
  - Gap: number. Padding: top/right/bottom/left.
  - Align: start | center | end. Justify: start | center | end |
    space-between.
  - Children get computed positions; manual drag inside auto-layout
    re-orders, doesn't free-position.
  - Side panel config UI.
- **Constraints** (per-child relative-to-frame)
  - `left | right | center | scale` for X.
  - `top | bottom | center | scale` for Y.
  - Honored only when parent frame is resized without auto-layout.
- **Alignment & distribute toolbar**
  - Floats above multi-selection.
  - Align left/center/right (X) + top/middle/bottom (Y).
  - Distribute horizontal / vertical.
  - Tidy-up (Figma-equivalent: snap to grid + equalize gaps).
- **Snap guides**
  - Pink lines on drag when edge/center aligns with another item or
    a frame edge.
  - Tolerance: 4px. Toggle with `Shift` held.

**MCP / router**

- `canvases.frameAdd / framePatch / frameRemove`.
- `canvases.groupCreate / groupDissolve`.
- `canvases.pageAdd / pageRemove / pageReorder / pageActivate`.
- `canvases.alignSelection({ canvasId, ids[], op })` — server validates,
  computes positions, persists in one transaction.

**Done =** can draw a frame, drop nodes into it, drag the frame and
children come along, set auto-layout direction:vertical and watch
children stack. Multi-page works. Align/distribute toolbar visible on
multi-select.

---

## Workstream C — Canvas styling: tokens, components, layers panel

**Agent**: 1 frontend + 0.5 backend.
**Depends on**: A. Can land in parallel with B.

**Scope**

- **Styling side panel** (right edge, reveals on selection)
  - Per-selection: fill color, stroke color + width, opacity, corner
    radius, shadow/effect.
  - Text styling for notes + text shapes: font size, weight, color,
    align, line height.
  - Color picker: design tokens first (from `globals.css` warm-earthy
    palette), then `CanvasStyle` color styles, then free hex.
- **Design tokens / styles** (`CanvasStyle` table)
  - "Create style" from current selection (color / text / effect).
  - Manage styles modal: list, rename, delete.
  - Applying a style stores the `styleId` so later edits cascade.
- **Components & instances**
  - Right-click selection → Create Component. Definition snapshot stored
    in `CanvasComponent.definition`.
  - Components panel (sidebar tab) shows workspace components with
    thumbnails. Drag onto canvas → creates `CanvasComponentInstance`.
  - Instance overrides: edit a child of an instance → diff stored in
    `overrides`. Reset override returns to definition value.
  - "Update component" from instance: pushes current state back to
    `definition`. Other instances re-render (overrides preserved where
    paths still exist).
  - Detach instance → expands back into raw nodes/shapes/frames.
- **Layers panel** (right edge, collapsible)
  - Tree by `parentFrameId` + `groupId` hierarchy, per active page.
  - Per-node: rename inline, hide/show (`hiddenAt`), lock/unlock
    (`lockedAt`), reorder via drag.
  - Click selects on canvas; bidirectional highlight.
- **Copy/paste styling** — `Cmd+Opt+C` copy style, `Cmd+Opt+V` paste.

**MCP / router**

- `canvases.styleCreate / styleList / styleUpdate / styleDelete`.
- `canvases.componentCreate / componentList / componentUpdate /
  componentArchive`.
- `canvases.instanceCreate / instancePatch / instanceDetach`.
- `canvases.patchNode` etc. extended to accept `styleRefs` (object of
  `{ fill: styleId, text: styleId }`).

**Done =** create a "Card" component once, drag 5 instances onto a
canvas, edit one instance's label without affecting siblings, push a
shared color change to the component and watch all instances update.

---

## Workstream D — Notes upgrade

**Agent**: 1 backend + 0.5 frontend.
**Depends on**: A. Independent of B/C.

**Scope**

- **Status lifecycle**
  - `Note.status` drives chip color and grouping. UI lets user move
    between IDEA → SOMEDAY → ACTIVE → ARCHIVED.
  - New Notes default to `IDEA`.
- **Promote to issue/project/initiative**
  - `notes.promote({ noteId, kind, ...overrides })` MCP tool. Creates
    target entity, sets `sourceNoteId` on it and
    `promotedToType/promotedToId` on the Note. Note transitions to
    `ACTIVE` automatically on promote.
  - UI affordance: "Convert →" menu on note row (Issue / Project /
    Initiative). Inline prefill from note title/body.
- **Notes index page polish**
  - Filter chips: Ideas | Someday | Active | Archived | All. Counts per
    chip. Pinned section above.
  - Bulk actions: move status, archive, delete.
- **Inbox / dashboard surfacing**
  - Dashboard list-view zone "Ideas" — top N (5) pinned + recent
    `IDEA`-status notes with one-click promote.
  - Notes show on global cmd-k search results.

**Router**

- `notes.list({ status?, pinned?, kind?, archived?, search? })`.
- `notes.setStatus({ noteId, status })`.
- `notes.promote({ noteId, kind, title?, projectId?, initiativeId? })`.

**Done =** can capture a thought as a Note (default IDEA), see it on
the dashboard Ideas zone, click "Convert → Issue" and have a backlinked
issue created in one step.

---

## Workstream E — Dashboard-as-canvas

**Agent**: 1 frontend + 0.5 backend.
**Depends on**: A (canvas.kind, ownerUserId), D (ideas surfacing).
**Soft-depends on**: B (frames make the Today zone cleaner but not
required for v1).

**Scope**

- **Personal canvas auto-provision**
  - On first dashboard load post-migration: create
    `WorkspaceCanvas { kind: PERSONAL, ownerUserId: viewer.id, name:
    "<displayName>'s Workspace" }`. Idempotent.
- **View toggle**
  - Dashboard route gets two views: List (current Inbox) and Canvas.
  - Toggle in topbar; persisted in `User.dashboardView` pref.
  - Keyboard: `\` flips view; `g d` jumps to dashboard.
- **Today zone (auto-arranged)**
  - Reserved frame at top of Personal canvas, locked from drag.
  - Auto-layout horizontal with gap. Populated server-side on canvas
    fetch with: assigned issues (≤7), due today, recent chat threads
    (≤5), top ideas (≤3).
  - Today zone refreshes on canvas open; pinned items below are
    untouched.
- **Pin onto Personal**
  - Pin gesture on any entity (note / issue / artifact / chat thread /
    plan / web link) drops a node on the user's Personal canvas in
    free space.
  - "Pin to canvas" item in entity action menus.
  - Server route: `pins.set` extended with `canvasId` (default Personal).

**Router**

- `canvases.personalForViewer` (read or auto-provision).
- Reuse `pins.set` with optional `canvasId`.

**Done =** new user lands on `/`, hits `\`, sees their Personal canvas
with a Today strip + scratch space; pins an issue from the inbox and it
appears as a node.

---

## Workstream F — Canvas polish & a11y

**Agent**: 1 frontend (dedicated to UX/perf).
**Depends on**: nothing structurally — can land incrementally
throughout.

**Scope (user-flagged + obvious adjacencies)**

### Multi-select (currently incomplete)
- Marquee selection on empty-canvas drag — selects all entity types
  (nodes, shapes, frames, groups, chat threads, component instances)
  inside the box.
- `Shift+Click` extends across mixed types; `Alt+Click` removes from
  selection.
- `Cmd+A` selects all on active page; with a frame focused, scopes to
  that frame's children.
- All group operations (delete, copy, paste, move, align, group,
  hide/lock, restyle) work on heterogeneous selection.
- Selection box visuals: unified ring + corner handles regardless of
  underlying type.

### Cursors (currently doesn't change with tool)
- Per-tool cursor state machine:
  - Select → default arrow.
  - Pan/Hand → grab / grabbing while held.
  - Shape tools (rect, ellipse, line, arrow, text) → crosshair with
    badge icon for the active tool.
  - Frame tool → crosshair with frame badge.
  - Connector tool → crosshair with port indicator; ports glow on hover.
  - Text → I-beam.
  - Over draggable element → move.
  - Over resize handle → directional resize (8 variants).
  - Over rotation handle → rotate.
- Immediate swap on tool change; no flicker.
- Brief 200ms tool-name pill near cursor on tool switch.

### Connector / node-flow drawing (currently delayed)
- Root-cause the lag. Likely culprits:
  - Edge re-routing recompute happening per pointer-move (orthogonal
    router is expensive).
  - React reconciliation on the entire edges layer.
  - Hit-testing scanning all ports per move.
- Fixes:
  - During drag, render preview line as cheap straight SVG; commit
    orthogonal route only on drop.
  - rAF-throttle pointer-move; batch state updates.
  - Spatial index for port hit-test (KD-tree or grid bucket).
  - Move edges layer to its own transform-only renderer.
- Port affordances:
  - Snap to port within 24px radius.
  - Hover-glow on candidate target.
  - `Esc` cancels in-progress draw.

### Hover, focus, micro-interactions
- Consistent hover ring (1px token color + soft shadow) on all
  interactive nodes.
- Focus ring on keyboard nav (Tab traversal).
- Toolbar tooltips with kbd hints after 600ms.
- Drag-start lift: `transform: scale(1.02)` + elevated shadow.
- Pan/zoom with momentum + smooth deceleration.
- Pinch-zoom anchors at cursor.
- `1` zoom-to-fit; `2` zoom-to-selection; `0` reset to 100%.
- Undo/redo (`Cmd+Z` / `Cmd+Shift+Z`) covers all canvas ops:
  add/remove/move/group/style/component apply/detach.
- Copy/paste preserves type, position offset, and styling.
- `Cmd+D` duplicate with smart offset.

### Performance
- Audit re-renders on drag — should be transform-only, no React
  reconciliation for unaffected nodes.
- Virtualize layers panel for >500-item canvases.
- Defer thumbnail generation for component panel to web worker.

### Accessibility
- Full keyboard navigation: Tab between selectable items, arrows nudge
  selection, Shift+arrows nudge 10px, Cmd+arrows resize.
- ARIA roles on toolbar, layers panel, side panel.
- Reduced-motion media query honored (kills the drag lift + tool pill).

**Done =** drawing a connector feels instant; switching to the frame
tool changes the cursor; marquee selects a frame + a chat thread + 3
notes; delete removes all three; Cmd+Z brings them all back.

---

## Workstream G — Agent storyboard grammar

**Agent**: 1 backend + 0.5 frontend (prompts + Hermes adapter).
**Depends on**: B (frames must exist for any of these to land
properly).

**Scope**

- **Compound MCP tools** (in `canvases.*` namespace)
  - `canvases.storyboardPlan({ canvasId, planId, pageId? })`
    - Creates a frame labeled `<plan.title>`.
    - Inside: plan card node (top), chat thread node (right), notes
      lane (left), sources/links column (right of chat).
    - Returns frame id + child ids for follow-up edits.
  - `canvases.storyboardResearch({ canvasId, topic, pageId? })`
    - Frame: chat node, sources column, scratchpad text node, "Next
      steps" lane.
  - `canvases.storyboardIssue({ canvasId, issueKey, pageId? })`
    - Frame: issue card, related-issues mini-list, comment stream node,
      attachments column.
  - `canvases.storyboardCustom({ canvasId, spec })` — escape hatch:
    spec is a Zod-validated tree the agent composes itself. Useful when
    the three preset shapes don't fit.
- **System prompt addition** (`src/server/services/chat-stream.ts` or
  prompt-builder)
  - Document the `storyboard*` tools as the "spatial composition"
    gestures. Trigger phrases: "storyboard / lay out / sketch / organize
    / set up a canvas for / pull this together".
  - Examples in the prompt of correct vs. incorrect usage (don't drop
    25 floating nodes; do drop a frame with a clear grammar).
- **Hermes platform adapter** (`~/.hermes/hermes-agent/gateway/
  platforms/forge.py` in Bailey's fork)
  - Expose the new MCP tools to remote agents.
  - No spec change beyond tool registration.
- **Write-confirm gate** (existing from canvas-v2 round 4)
  - `storyboard*` tools count as write — go through the existing
    confirm modal unless the canvas is the user's Personal canvas
    (auto-allow on own scratch space).

**Done =** in chat, "Victor, storyboard the migration plan on my
canvas" results in a labeled frame containing the plan card, a chat
thread node, a sources column, and a notes lane — all aligned, on the
active page.

---

## Cross-stream dependencies

| Stream | Hard deps | Soft deps |
|---|---|---|
| A — Schema | — | — |
| B — Canvas core | A | — |
| C — Styling / components / layers | A | B (frames help layers panel grouping) |
| D — Notes upgrade | A | — |
| E — Dashboard-as-canvas | A, D (ideas zone) | B (cleaner Today zone) |
| F — Polish | — | B (frames change selection model) |
| G — Storyboard | A, B | C (components let storyboards reuse cards) |

**Suggested launch order for the agent team**:

1. **Wave 1** (sequential): A (schema) — 1 agent.
2. **Wave 2** (parallel): B, C, D, F start. E waits a beat for D.
3. **Wave 3** (parallel after B lands): E completes, G starts.
4. **Wave 4**: Integration pass — verify storyboard works on Personal
   canvas, run full E2E suite, polish the polish.

---

## Verification gates

Per stream:
- **A** — `prisma migrate dev` clean; `pnpm typecheck`; new tables
  visible in Prisma Studio.
- **B** — Playwright test: draw frame, drop node, drag frame, child
  moves. Multi-page tab switch. Align toolbar appears on multi-select.
- **C** — Playwright: create component, instance it 3x, edit
  definition, all instances update. Override on one instance survives
  the update.
- **D** — Vitest: `notes.promote` creates linked issue with
  `sourceNoteId`. UI test: convert → issue from dashboard ideas zone.
- **E** — Playwright: new user lands on `/`, toggles to Canvas view,
  Today zone populates with their actual assigned issues.
- **F** — Manual perf check: connector draw at 60fps on a 200-node
  canvas. Keyboard a11y walkthrough.
- **G** — MCP smoke: each `storyboard*` tool from `mcp.tool` CLI
  produces correct frame layout. Chat E2E: "storyboard this plan"
  triggers the right tool call.

Full release gate: `pnpm lint && pnpm typecheck && pnpm test &&
pnpm test:e2e` clean. DEVLOG entry per stream.

---

## Out of scope (defer)

- Vector pen tool / boolean ops (illustration, not layout — Figma has
  it, we don't need it).
- Prototyping links (interactive prototype flows between frames).
- Real-time multi-user co-editing cursors (we have presence, not
  collab-cursor — bigger lift, separate plan).
- Export to PNG/SVG/PDF — easy to bolt on later; not in critical path.
- Plugin API for canvas — comes after the surface stabilizes.

---

## Open questions (raise before kickoff)

1. **Personal canvas privacy** — visible to admins on
   `/canvases` list, or hidden entirely? Default: hidden unless owner
   shares.
2. **Component naming collisions** — workspace-scoped names; allow
   duplicates or unique-name constraint? Lean unique.
3. **Idea-status default for journal-kind notes** — Journal entries
   should probably default `ACTIVE` (not IDEA), since they're records,
   not pitches. Confirm.
4. **Today zone refresh** — re-run on every canvas fetch, or only on
   explicit "Refresh Today"? Lean: every fetch, server-side cache 30s.
5. **Auto-layout vs constraints precedence** — if both set on a frame's
   children, auto-layout wins. Confirm.

---

## Definition of done (whole goal)

- User opens `/`, sees structured Inbox with their work + ideas surfaced.
- Hits `\`, lands on Personal canvas: Today strip auto-arranged, free
  scratch space below.
- Captures a thought as a Note (IDEA), one-clicks Convert → Issue,
  backlink preserved.
- Drags out a frame on a Design canvas, adds nodes, sets vertical
  auto-layout, watches them stack.
- Builds a "Card" component, instances it 5x across canvases, updates
  the definition, all instances refresh.
- Asks Victor "storyboard the OAuth plan on my canvas" — gets a labeled
  frame with the plan card, chat thread, notes lane, sources column,
  all aligned.
- Drawing a connector is instant. Cursor signals the active tool.
  Marquee selects everything in the box including mixed types.

When the above is true, this goal is done.
