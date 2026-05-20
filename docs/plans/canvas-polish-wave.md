# Forge Canvas Polish Wave — Smoothness · Creation Parity · Daily Polish

> Execution plan. Three waves, parallelizable inside each wave. Targets
> the gaps identified in the canvas UX audit (2026-05-20): perceived lag
> on frame drag, creation asymmetry (only places existing entities,
> can't author new ones from canvas), missing on-canvas feedback
> (alignment guides, distance labels, hover states), no inspector for
> selection, and missing table-stakes (undo/redo, copy/paste,
> right-click menus).
>
> Builds on the unified-workspace-flow plan (2026-05-19). Schema and
> server surface from that plan are reused; this wave is mostly
> interaction-layer + new shape kinds + a few small Prisma additions.

## Goal

The canvas stops feeling like a placeholder. It hits the bar a daily
user expects from Figma / FigJam / Miro / tldraw: drags feel weightless,
authoring new entities happens *on the canvas* rather than via the
sidebar, every selection has a contextual inspector, and the keyboard
shortcuts users muscle-memory'd in other tools all work here.

Three waves, in order. Wave 1 ships the smoothness + creation parity.
Wave 2 reaches authoring parity with Figma/Miro. Wave 3 closes the
table-stakes gap (undo/redo, clipboard, context menus, focus modes).

---

## Audit findings (root-causes the waves address)

1. **Frame drag lag is O(frames²) at click**, not in the rAF loop.
   `page.tsx:1408-1458` — the title-bar `mousedown` handler walks all
   frames synchronously to build the cascade drag set before the first
   paint. The rAF coalescing is fine; the perceived stutter is
   click-to-first-paint.

2. **Drag invalidates the whole canvas every tick.**
   `page.tsx:945-980` — `displayNodes` / `displayShapes` / `displayFrames`
   memos all depend on `dragRev`. Each rAF tick re-runs the auto-layout
   pass over every frame on the canvas, not just the affected one.

3. **Creation is asymmetric.** Shapes/frames can be drawn from scratch
   but every entity card (issue, note, chat, plan, artifact) is
   place-existing-only. The schema and routers already exist to create
   new entities; the canvas just doesn't wire it.

4. **No on-canvas affordance feedback.** No alignment guides during
   drag, no distance labels, no marquee count badge, no hover outline,
   selection ring is dashed for everything (no nesting hierarchy).

5. **No selection inspector.** Toolbar swatches apply to new shapes
   only. Existing selection has no way to change fill, stroke, opacity,
   font size, rotation, exact x/y/w/h without using the layers panel.

6. **Missing table-stakes.** No undo/redo, no copy/paste/duplicate, no
   right-click context menu on canvas items, no space-to-pan, no
   zoom-to-selection, no F-to-focus-selected-frame.

7. **Eraser tool is half-built.** Cursor is `not-allowed`; clicks do
   nothing. Either implement (delete shape under cursor) or hide.

8. **Tools are sticky by default.** Every other canvas auto-returns to
   Select after one shape; Forge stays in the active tool. Shift to lock
   sticky is the expected pattern.

---

## Locked scope decisions

- **Three waves**, in order. Wave 1 unblocks Wave 2 (selection
  inspector pattern), Wave 2 unblocks Wave 3 (right-click menu reuses
  inspector shell).
- **No new top-level primitives** — sticky notes and comment pins are
  new `CanvasShape.kind` values (`sticky`, `comment-pin`). Reactions /
  stamps are a third `kind: "stamp"` with an emoji payload. All three
  fit the existing `CanvasShape` row with no schema change.
- **Inline-create entities** (issue, note, chat thread, plan, artifact)
  reuse the existing tRPC mutations. New tool kind: `entity-create`
  with a sub-mode per entity. Click-to-place opens an inline editor;
  ⌘↩ commits and stamps the real row via the existing create
  mutations, then drops the resulting `CanvasNode` at xy.
- **Undo/redo is local-first**: client-side command stack with
  inverse mutations. No server history table yet; if a mutation fails
  the stack is invalidated and reset. Cross-tab collaboration on undo
  is deferred.
- **Copy/paste is canvas-clipboard-scoped**: in-memory clone + offset
  20px. System clipboard integration (paste from Figma → Forge) is
  deferred.
- **Floating selection inspector** ships before any side-panel
  inspector. Mini toolbar above the bbox, Figma-style. The right-side
  panel slot is already taken by Layers/Components.
- **Smart guides are purely client-side.** Sample sibling positions on
  drag start, render guide lines when within `SNAP_THRESHOLD_PX = 4` on
  any axis. No server config.
- **Cursor switching already works** via `cursorForTool` — the gap is
  the eraser (not-allowed) and the missing space-to-pan modifier, not
  the underlying mechanism.

---

## Wave 1 — Smoothness + creation parity

Goal: ship the work that closes the "feels like a placeholder" gap.
Frame drag stops stuttering, canvas can author new entities, every
selection has a floating inspector, alignment guides appear during
drag, sticky notes exist as a primitive.

### W1.1 — Frame drag performance

Files: `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- Build `frameChildIndex: Map<frameId, { childFrames[], childNodes[], childShapes[] }>` in a memo keyed on frames/nodes/shapes (not on `dragRev`). Use it in the frame title-bar `mousedown` handler so cascade is O(1).
- Split drag-override layer from static layer. Three memos:
  - `staticNodes` / `staticShapes` / `staticFrames` — depend on rows only, never on `dragRev`.
  - `dragOverlay` — depends on `dragRev` + the drag refs. Renders only the items in the active drag set.
- Auto-layout pass: recompute only for frames in the active drag set. Cache other frames' positions in `autoLayoutPositionsRef`.
- Verify: drag a frame nested 3 deep with 50 sibling frames; first-frame paint < 16ms (one frame).

### W1.2 — Inline entity creation

Files: `src/components/canvas/canvas-toolbar.tsx`, `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`, new `src/components/canvas/canvas-entity-creator.tsx`

- Add `entity-create` tool with sub-modes: `issue`, `note`, `chat`, `plan`, `artifact`. Sub-mode selector dropdown next to the tool button.
- Click-to-place: drop an inline editor at xy. Title input + body textarea + ⌘↩ commit + Esc cancel.
- On commit: call the existing create mutation (`issues.create`, `notes.create`, etc.), receive the created row, then `canvases.addNode` at xy. Stamp `sourceNoteId` / `sourceCanvasNodeId` where the schema supports it.
- Toolbar tooltip shows the sub-mode and shortcut: `I` for issue, `N` for note, `C` for chat, `P` for plan, `A` for artifact (re-bind existing C shortcut for Connect to Shift+C).

### W1.3 — Sticky notes, comment pins, stamps

Files: `prisma/schema.prisma` (none — just CanvasShape.kind values), `src/components/canvas/canvas-shapes.tsx`, `src/components/canvas/canvas-toolbar.tsx`

- New `CanvasShape.kind` values: `sticky`, `comment-pin`, `stamp`.
- `sticky`: 200×120 default, fixed palette (yellow / pink / blue / green / lavender / orange), 3 lines of text, inline edit on double-click.
- `comment-pin`: 24×24 anchor, opens a `Comment` thread row on click. Reuse `comments.create` mutation; thread bound to `targetType: "canvas-shape"` + `targetId: shapeId`.
- `stamp`: 48×48 emoji glyph, no text. Single-click to drop, palette of 8 common emojis (👍 👎 ⭐ 🔥 ❤️ 💡 ⚠️ 🎯).
- Toolbar: add three new tool kinds, three new cursors (sticky → `crosshair`, comment-pin → `help`, stamp → `copy`).

### W1.4 — Smart alignment guides

Files: `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`, new `src/lib/canvas-snap-guides.ts`

- At drag start, sample sibling AABBs (within parent frame, or whole canvas if no parent).
- During drag rAF tick, compute snap candidates: edges (left/center/right, top/middle/bottom) within `SNAP_THRESHOLD_PX = 4`.
- Apply snap to drag override position. Render guide lines (1px ember/40 dashed) from the snapped edge across the canvas.
- Show distance labels (`12px`, `48px`) on guides between the active item and its nearest sibling.
- Show width × height label on the active item bbox while dragging.

### W1.5 — Floating selection inspector

Files: new `src/components/canvas/canvas-selection-inspector.tsx`, `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- Mini toolbar floats 8px above the selection bbox. Auto-flips below if the bbox is near the top of the viewport.
- Per-kind property surfaces (4-6 properties max each):
  - **Shape** (box/ellipse/line/arrow/freehand): fill, stroke, stroke width, opacity, rotation, lock.
  - **Frame**: name (inline edit), auto-layout direction toggle, gap, padding, background fill.
  - **Node card**: open detail, change status (issue/project), detach, lock.
  - **Text shape**: font size, weight, align, color.
  - **Sticky**: color (palette), font size.
  - **Edge**: kind (solid/dashed/dotted/curved), arrow head/tail, label.
- Multi-selection: show only properties common to every selected kind.
- All edits debounced 200ms, then mutate via existing `shapePatch` / `framePatch` / `edgePatch`.

### W1 Definition of Done

- [ ] Frame drag with 50 sibling frames + 3-deep nesting: first paint < 16ms.
- [ ] Canvas can create new Issue / Note / Chat / Plan / Artifact entities inline. Resulting rows visible in their respective list views.
- [ ] Sticky notes, comment pins, stamps render and round-trip through `shapeAdd` / `shapePatch`.
- [ ] Smart alignment guides appear within 4px of any sibling edge during drag. Distance labels render between guide and active item.
- [ ] Selecting any shape / frame / node / edge shows a floating inspector with the documented property surface for its kind.
- [ ] All work passes `pnpm lint && pnpm typecheck && pnpm test`.
- [ ] DEVLOG entry under `## 2026-05-20` describes the wave.

---

## Wave 2 — Authoring parity

Goal: hit the interaction-pattern bar of Figma/Miro. Auto-return-to-Select, space-to-pan, comment threads, hover states, marquee count, snap-to-grid visual feedback, eraser actually erases.

### W2.1 — Tool ergonomics

Files: `src/components/canvas/canvas-toolbar.tsx`, `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- Auto-return-to-Select after one shape draw. Shift while clicking the tool button locks sticky (visual indicator: ember dot on the tool).
- Space held down → temporarily flip to Pan tool (regardless of active tool). Release → restore previous tool. Cursor becomes `grab` while held, `grabbing` during active pan.
- Tooltips on every tool button include the shortcut letter.
- Eraser tool: implement click-to-delete-shape-under-cursor. Cursor → custom circle (24px outline). On click, hit-test under cursor, call `shapeRemove`. Hold to "sweep" delete (loop while mousedown).

### W2.2 — Comment threads on canvas

Files: `src/components/canvas/canvas-shapes.tsx`, new `src/components/canvas/canvas-comment-popover.tsx`, `src/server/routers/comment.ts` (verify `targetType: "canvas-shape"` is allowed; if not, add it)

- Click comment-pin → opens popover with thread (`comments.list({ targetType: "canvas-shape", targetId })`).
- Reply input + resolve checkbox + assign-to dropdown.
- Resolved pins render with `opacity-40 ring-success/40` instead of ember.
- Unread count badge on pin (red dot if any comments since `lastSeenAt`).

### W2.3 — Hover + selection visual polish

Files: `src/components/canvas/canvas-shapes.tsx`, `src/components/canvas/canvas-frames.tsx`

- Hover outline: 1px `border-foreground/20` on every shape/frame/node hover. Already exists for toolbar buttons; copy the pattern.
- Selection rings: solid 1.5px ember for shapes, dashed 1px ember for groups, double 1px ember for frames. Gives visual hierarchy.
- Marquee rubber-band: floating badge in the top-right of the rect — `12 selected`.
- Group bbox visible when any member of a group is selected — `border-ember/40` dashed wrapping all members.

### W2.4 — Snap-to-grid visual feedback

Files: `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- Grid is already toggled via `viewPrefs.showGrid` and rendered as dots. When snap-to-grid is on and a drag is active, render a 1px `ember/20` grid-line highlight on the row + column the snap target maps to.
- Snap-to-grid + smart guides are mutually exclusive — guides win when both could apply.

### W2 Definition of Done

- [ ] Drawing any shape auto-returns to Select. Shift-click on tool locks it sticky with visible indicator.
- [ ] Space-to-pan works from any tool. Eraser tool actually deletes shapes under cursor.
- [ ] Comment pins open a working thread; resolved pins styled distinctly; unread badge appears on pins with new replies.
- [ ] Hover outline visible on every shape/frame/node on mouseover.
- [ ] Selection rings differ by kind (shape / group / frame).
- [ ] Marquee shows live count badge.
- [ ] Snap-to-grid renders row/column highlight during drag.

---

## Wave 3 — Table-stakes that are still missing

Goal: the keyboard-driven daily-driver bar. Undo/redo, clipboard,
right-click context menu, focus modes, zoom-to-selection.

### W3.1 — Undo / redo

Files: new `src/lib/canvas-undo.ts`, `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- Client-side command stack. Each user action pushes `{ do: () => Mutation, undo: () => Mutation }`.
- Cmd+Z calls `undo` of the top command and pops it onto the redo stack. Cmd+Shift+Z reverses.
- Stack invalidated on any failed mutation (rollback to server state).
- Stack capped at 100 entries. Cleared on canvas change.
- Visual feedback: a 200ms toast `Undone: moved 3 shapes` / `Redone: added sticky`.

### W3.2 — Copy / paste / duplicate

Files: `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- Cmd+C: serialize selection to in-memory clipboard (shapes + frames + nodes + edges within the selection).
- Cmd+V: paste at cursor (or +20px offset from original if cursor is over an empty area).
- Cmd+D: duplicate in place at +20px offset.
- Pasted edges re-link to pasted endpoints when both ends are in the clipboard; otherwise drop the edge.
- Cross-canvas paste works (target canvas resolves the workspace, denies if scope differs).

### W3.3 — Right-click context menu

Files: new `src/components/canvas/canvas-context-menu.tsx`, `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- Right-click on shape / frame / node / edge → context menu with per-kind actions.
- Background right-click → "Paste here" / "New issue here" / "New note here" / "Reset view".
- Reuse the selection inspector's per-kind action set as the menu source of truth; menu just renders the same actions vertically.

### W3.4 — Focus / zoom modes

Files: `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx`

- `F` while a frame is selected: zoom-to-fit-frame (80px padding). Double-tap `F`: max zoom into frame center.
- `Shift+2`: zoom-to-fit-selection (regardless of kind).
- `1` already exists for zoom-to-fit-all — keep it.
- `0` already exists for reset-to-100% — keep it.

### W3 Definition of Done

- [ ] Cmd+Z / Cmd+Shift+Z undo and redo: move, add, delete, patch, group, ungroup, edge add/remove.
- [ ] Cmd+C / Cmd+V / Cmd+D round-trip a multi-select with edges intact.
- [ ] Right-click on shape / frame / node / edge / background opens a context menu with the relevant per-kind actions.
- [ ] `F` zoom-to-frame, `Shift+2` zoom-to-selection both work.
- [ ] All work passes `pnpm lint && pnpm typecheck && pnpm test`.
- [ ] DEVLOG entry under the wave's date describes Wave 3.

---

## Parallelization map

Wave 1 (5 workstreams) can run in parallel by 4-5 agents:

| Agent | Workstream |
|---|---|
| F1 | W1.1 (frame drag perf) |
| F2 | W1.2 (inline entity creation) |
| F3 | W1.3 (sticky / comment-pin / stamp shape kinds) |
| F4 | W1.4 (smart alignment guides) |
| F5 | W1.5 (floating selection inspector) |

Wave 2 + Wave 3 each have 3-4 sub-streams that parallelize similarly.

Within a wave, agents coordinate on touching `page.tsx`. Strategy: F1
lands first (splits the drag layer), then F2/F4/F5 land in parallel
against the new layered structure. F3 is independent (new shape kinds
only touch `canvas-shapes.tsx` + a toolbar entry).

---

## Open questions

1. **Sticky note default palette** — match warm-earthy tokens or stay
   with the canonical post-it yellow/pink/blue/green? I'd default to
   warm-earthy variants (sand, blush, sage, sky, lavender, peach) so
   they don't feel jarringly bright against the canvas background.
2. **Comment thread surface** — popover only, or also surfaced in the
   Activity drawer? I'd say both; ActivityEvent already has the
   plumbing.
3. **Undo/redo persistence** — local only at first. If users want it
   across sessions, add a `CanvasUndoEntry` table later.
4. **Inline-create defaults** — when creating a new Issue from canvas,
   what status / priority / project? I'd default to `BACKLOG` /
   `MEDIUM` / no project, and let the inspector adjust.
5. **Stamps as reactions on entities** — should dropping a 👍 stamp on
   top of an issue card count as a reaction on the issue, or just a
   floating glyph? I'd say just a glyph initially; reactions-on-entities
   is its own feature.

---

## Verification gate

Before declaring the plan complete:

1. Run all three wave DoD checklists end-to-end on a fresh canvas.
2. Run `pnpm lint && pnpm typecheck && pnpm test`.
3. Run `pnpm test:e2e` for canvas-specific specs.
4. Append three DEVLOG entries (one per wave) under their landing dates.
5. Commit each wave separately so they can be reviewed and rolled
   back independently if needed.
