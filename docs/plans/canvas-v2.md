# Forge Canvas v2 — Excalidraw + Flow + Agent-Driven

> Execution plan. Phases below are ordered by dependency, not priority.
> Each phase declares its scope, files, agent allocation, and
> verification gate. Phases can be greenlit individually.

## Goal

Turn Forge's canvas from "spatial entity arrangement + sticky notes"
into a full idea/planning/execution surface that supports:

1. Free-form drawing primitives (boxes, lines, arrows, titles, subtexts,
   freehand pen) à la Excalidraw — annotation layer.
2. Node-flow drag-to-connect with edge auto-routing à la xyflow /
   React Flow — structured layer.
3. Agent-driven authoring: chat with Victor / Mizu / Claude to build
   out the canvas (the agent calls canvas MCP tools live).
4. Operator UX polish: resizable sidebar, topbar settings modal.

Plus the load-bearing prerequisite from round 4: chat tool-use must
ACTUALLY execute (with a write-confirmation gate), not just display
intent.

## Round-4 follow-ups status

Related to this plan:
- ✅ already shipped — confirm modal, canvas perf, CRUD lifecycle, chat
  streaming endpoint, canvas attachment previews.
- 🟡 **Auto-execution of chat tool calls** — load-bearing for Phase 4.
  Folded in as Phase 0.

NOT related (parked, can be done later as a small follow-up batch):
- Streaming chat with attachments unified (currently text-only via
  stream, attachments fall back to dispatch).
- "Stop generating" button on the streaming bubble.
- Per-thread provider/model override controls.

These three don't block any phase here. We can do them after Phase 4
in a small sweep, or interleave if convenient.

---

## Phase 0 — Tool-use execution + write-confirmation gate

**Why first**: Phases 4 (agent-driven canvas) needs the agent to
actually invoke `canvas.addNode`, `canvas.addNote`, etc. from chat.
The round-4 streaming endpoint emits `tool_use` events but the
frontend renders them as cards only. We need a server-side execution
loop + a client-side confirm-on-write gate.

**Files**
- `src/server/services/chat-stream.ts` — extend the streaming loop
  so when the model returns a tool call, the server actually invokes
  the matching MCP tool, captures the result, and feeds it back as
  a tool result message before the next streaming turn.
- `src/server/services/chat-tools-allowlist.ts` (new) — whitelist of
  MCP tools available to chat agents, with `requiresConfirm: boolean`
  per tool. Reads are auto-allowed (`issues.get`, `agent.context.bundle`,
  `canvases.get`, `runs.list`, etc.). Writes require confirm
  (`issues.assign`, `comments.create`, `canvas.addNode`,
  `canvas.addNote`, `canvas.addEdge`, `canvas.patchNode`,
  `canvas.patchNodeMeta`, `canvas.removeNode`, `canvas.convertToPlan`).
- `src/app/api/chat/stream/route.ts` — when a write-class tool arrives,
  the SSE stream emits a new `tool_confirm` event instead of executing.
  Operator's frontend renders an approve/decline UI; on approve, the
  client POSTs to a new `/api/chat/tool/approve` endpoint that the
  stream's pending future resolves against.
- `src/components/mission-control/chat-thread.tsx` — render
  `tool_confirm` cards with **Approve** / **Decline** buttons. Approve
  → POST to `/api/chat/tool/approve`. Decline → close the call with a
  "user rejected" tool result.
- `src/components/mission-control/chat-message.tsx` — rehydrate
  approved/declined tool calls on reload (`contextSnapshot.tool_calls`
  now has a per-call status).
- Tests: integration coverage for read-auto-execute, write-requires-
  confirm, write-on-approve, write-on-decline, allowlist rejection.

**SSE events added**
- `tool_call_started` `{ id, name, args, requiresConfirm }`
- `tool_confirm` `{ id, name, args }` (replaces `tool_use` for writes)
- `tool_result` `{ id, ok, summary, result }`

**Verification**
- A chat asking "what are my assigned issues?" auto-executes
  `issues.assigned` without confirm.
- A chat asking "create an issue titled X" opens a confirm card; on
  approve, `issues.create` runs and a follow-up agent reply confirms.
- An attempt to call an off-allowlist tool returns an error tool
  result, the agent sees it, and can recover.

**Agent allocation**: 1 agent owns this end-to-end. Estimated 1
session.

---

## Phase 1 — Sidebar resizable + canvas settings modal

**Why**: Pure UX polish; unblocks everything else by getting the
chrome out of the way.

### 1A. Resizable sidebar

**Files**
- `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx` — wrap the
  existing `CanvasEntityRail` in a resizable container. Add a 4px
  vertical drag handle on its right edge. Mousedown + move tracks
  width; constrain to `[180, 480]` px. Persist last width to
  localStorage keyed by workspace slug (`forge.canvas.sidebar.${slug}`).
  Honor a collapsed state (existing `openSidebar`); when collapsed,
  the drag handle is hidden.
- (optional) `src/hooks/use-resizable.ts` — if a generic
  resize hook is useful for other places later. Keep it tiny.

### 1B. Canvas settings topbar modal

**Files**
- `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx` — replace any
  inline settings affordances (archive button currently in the
  topbar actions area, plus anything else like "show grid",
  "snap to grid", "presence on/off") with a single
  "Settings" cog button in the topbar. Open a new
  `<CanvasSettingsModal>`.
- `src/components/canvas/canvas-settings-modal.tsx` (new) — modal
  body with tabs / sections:
  - **General**: name (editable + autosave), scope (display only),
    archive (calls existing mutation via Confirm).
  - **View**: show grid toggle, snap to grid toggle, presence
    visible toggle (already implemented behaviors; just surface
    them here).
  - **Sharing**: read-only summary for now (workspace-scoped).
    Placeholder for future per-canvas sharing.
- The modal uses the existing `<Dialog>` or `<Confirm>`-style
  primitive at `src/components/ui/dialog.tsx`.

**Verification**
- Sidebar can be dragged from 180px to 480px; width survives reload.
- Settings cog opens a modal with all canvas-level controls; no
  inline settings remain in the canvas page header.

**Agent allocation**: 1 agent.

---

## Phase 2 — Drawing primitives (Excalidraw-style)

**Why**: The canvas needs visual annotation primitives that DON'T
reference entities — pure shapes for ideation + grouping.

### Schema

**Files**
- `prisma/schema.prisma` — new model `CanvasShape`:

```prisma
model CanvasShape {
  id          String   @id @default(cuid())
  workspaceId String
  canvasId    String
  /// box | ellipse | line | arrow | text | freehand
  kind        String
  /// Position. For bounded shapes (box/ellipse/text): x,y,width,height.
  /// For path shapes (line/arrow/freehand): start at (x,y); points
  /// stored in `path` JSON as an array of relative (dx, dy) tuples.
  x           Float
  y           Float
  width       Float?
  height      Float?
  path        Json?
  /// Style. stroke, fill, strokeWidth, dasharray, fontSize, color,
  /// fontWeight, opacity. Free-form for v1; can tighten later.
  style       Json?
  /// Optional text content for text + arrow-label shapes.
  text        String?  @db.Text
  zIndex      Int      @default(0)
  /// Optional grouping. Shapes with the same groupId move together.
  groupId     String?
  createdById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  workspace   Workspace        @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  canvas      WorkspaceCanvas  @relation(fields: [canvasId], references: [id], onDelete: Cascade)
  createdBy   User?            @relation("CanvasShapeCreator", fields: [createdById], references: [id], onDelete: SetNull)

  @@index([canvasId, zIndex])
  @@index([workspaceId])
}
```

- Migration `0044_canvas_shape`.
- Add `WorkspaceCanvas.shapes CanvasShape[]` back-relation.
- Add `User.createdShapes` back-relation.

### tRPC + MCP

**Files**
- `src/server/routers/canvas.ts` — new procedures (workspace-scoped):
  - `shape.add({ canvasId, kind, x, y, width?, height?, path?, style?, text?, groupId? })` → `{ id }`.
  - `shape.patch({ id, ...partial })` → `{ ok }`.
  - `shape.remove({ id })` → `{ ok }`.
  - `shape.bulkPatch({ ids: string[], style?, groupId?, dxdy? })` → `{ ok, count }`.
  - Extend `canvas.hydrate` to also return `shapes` (lightweight; no
    entity hydration needed).
- Mirror as MCP tools: `canvases.shapeAdd`, `canvases.shapePatch`,
  `canvases.shapeRemove`. These get auto-allowed (write) via Phase 0
  with `requiresConfirm: true`.

### Renderer

**Files**
- `src/components/canvas/canvas-shapes.tsx` (new) — pure SVG
  renderer for shapes. Lives INSIDE the transformed canvas surface
  alongside `EdgesOverlay` so it shares pan/zoom.
- Shape rendering:
  - `box` / `ellipse`: `<rect>` / `<ellipse>` with fill + stroke.
    Boxes have rounded corners (`rx=6`).
  - `line` / `arrow`: `<path d="M x,y L x+dx,y+dy">` for straight,
    `<path d="M ... Q ...">` for curved (later). Arrowheads via
    `<marker>` defs (reuse the existing edge-arrow markers).
  - `text`: `<foreignObject>` with a `<div>` rendering markdown (via
    `ChatMarkdown`). Default font size 14 for `subtext` style and 24
    for `title` style. Wraps; resizable handle on right edge.
  - `freehand`: `<path>` smoothed via Catmull-Rom-to-Bezier from the
    captured (dx, dy) point array.

### Toolbar

**Files**
- `src/components/canvas/canvas-toolbar.tsx` (new) — floating toolbar
  pinned to the bottom-center of the canvas. Tools: select, hand
  (pan), box, ellipse, arrow, line, text, freehand, eraser. Pressing
  a tool changes the cursor + drag behavior. Esc returns to select.
- Style controls beside the toolbar (small color swatches + stroke
  width). Persist last-used style per workspace in localStorage.
- Group / ungroup actions (when multiple shapes selected).

### Selection + manipulation

**Files**
- `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx` — extend the
  existing selection system (currently only nodes have drag).
  Selection now supports nodes + shapes. Box-select via shift+drag
  on background. Group-move: dragging a selected shape moves all
  selected shapes by the same delta. Style edit applies to selected.
- Keyboard: Delete removes selected shapes. Cmd/Ctrl+D duplicates.
  Cmd/Ctrl+G groups (writes a fresh `groupId` to selected shapes).
  Cmd/Ctrl+Shift+G ungroups.

### Verification
- Operator can pick the box tool, drag a rectangle on the canvas,
  release → a `CanvasShape` row exists, renders inline, survives
  reload.
- Same for ellipse / arrow / line / text / freehand.
- Selecting multiple shapes + Cmd+G stamps a common `groupId`;
  dragging one moves them all.
- Style controls update the selected shape(s).

**Agent allocation**: 2 agents (one backend + tools + tests, one
frontend renderer + toolbar + selection). Estimated 2 sessions.

---

## Phase 3 — Node-flow connectors + auto-routing

**Why**: Operators want to draw flowcharts using entity nodes —
"AXI-31 → AXI-32 with label 'depends on'". Currently you can do
this via the canvas edge model but there's no drag-to-connect UI
and no routing — edges go straight through nodes.

### Drag-to-connect UI

**Files**
- `src/app/(app)/w/[slug]/canvas/[canvasId]/page.tsx` — when the
  select tool is active and the operator hovers a node's edge, render
  four "handle" dots (top/right/bottom/left). Mousedown on a handle
  + drag starts a connector preview line that follows the cursor.
  Mouseup on another node creates an edge (default kind: `"links"`,
  default style: muted-solid).
- Add a small "Connect" overlay icon on the toolbar that, when
  active, shows the handles permanently (so an operator can connect
  by dragging from one node to another without going through the
  hover-edge dance).

### Auto-routing

**Files**
- `src/lib/canvas-routing.ts` (new) — orthogonal A* on a grid
  derived from node bounding boxes. Algorithm:
  1. Build an obstacle grid where each node's rect is a wall +
     padding.
  2. From the source handle's anchor point, find the shortest
     orthogonal path to the target handle's anchor.
  3. Smooth corners with quadratic Bezier curves for visual
     softness.
  4. Cache routes keyed by `(fromNodeId, toNodeId, fromHandle,
     toHandle, nodes-bbox-hash)` so re-renders don't recompute.
- Fallback (when A* fails / loops detected): cubic-bezier between
  the two anchor points.

### Edge handles

**Files**
- Extend `WorkspaceCanvasEdge.meta` to optionally store
  `{ fromHandle: "top"|"right"|"bottom"|"left", toHandle: same }`
  so the operator can pick which side the arrow leaves / enters.
  No schema migration needed — `meta` is `Json?`.
- Default behavior (no handles set): pick the pair that minimizes
  path length.

### Edge editing

**Files**
- Edge label: click to edit inline. Persist via
  `canvas.edgePatch({ id, label?, kind?, meta? })` (new procedure;
  symmetric with `patchNode`).
- Edge kind palette: solid / dashed / dotted / curved-only.
- Edge delete: select edge + Delete key, or right-click → Delete.

### Renderer changes

**Files**
- `EdgesOverlay` in `canvas/[canvasId]/page.tsx` → swap straight-line
  rendering for routed paths. Keep the per-kind styling.
- Memoize routes so drag doesn't recompute the whole graph (Agent J's
  perf principles apply: ref-based recompute + rAF coalescing when
  layout shifts).

### Verification
- Operator hovers a node, drags from its right handle to another
  node's left handle, releases → an edge exists, renders routed,
  survives reload.
- Edges auto-route around obstacles; dragging a node along the
  edge path reroutes within ~16ms (one frame).
- Edge labels editable; kind / handles persisted.

**Agent allocation**: 2 agents (one for backend procs, one for
routing algo + frontend handles + renderer). Estimated 2 sessions.

---

## Phase 4 — Agent-driven canvas authoring

**Why**: This is the big payoff. Operator says "Victor, set up a
retro canvas for last week" and the agent calls
`canvas.create → canvases.shapeAdd × 4 (quadrants) → canvases.addNote × N`
live.

**Prerequisite**: Phase 0 (chat tool-use execution + write
confirmation). Without that, the agent can describe the canvas it
WOULD build but can't actually build it.

### Canvas context binding

**Files**
- `src/components/mission-control/chat-thread.tsx` — when the
  operator is currently viewing a canvas (route ends in
  `/canvas/{canvasId}`), the chat composer auto-attaches
  `canvasId` to the SSE request body. The server-side stream
  passes it through to the model in the system prompt:
  "The operator is currently viewing canvas {id} ({name}, scope
  {scope}). Available tools include canvases.* — use them to
  modify the canvas in place. Confirm before writes."
- `src/server/services/chat-stream.ts` — when `canvasId` is set,
  preload `canvas.hydrate({ id })` into the model context as a
  compact summary (nodes count by targetType, shapes count by kind,
  bounding box). Refresh on each model turn so the agent doesn't
  hallucinate state.

### Canvas-specific tool allowlist additions

In `chat-tools-allowlist.ts` (Phase 0), explicitly include:
- READ: `canvases.get`, `canvases.list`, `canvases.hydrate` (with
  shapes added in Phase 2), `agent.context.bundle`.
- WRITE (requires confirm): `canvases.addNode`, `canvases.addNote`,
  `canvases.addEdge`, `canvases.addChatThread`, `canvases.patchNode`,
  `canvases.patchNodeMeta`, `canvases.removeNode`,
  `canvases.shapeAdd` (Phase 2), `canvases.shapePatch` (Phase 2),
  `canvases.shapeRemove` (Phase 2), `canvases.edgePatch` (Phase 3),
  `canvases.removeEdge`, `canvases.convertToPlan`.

### Bulk operations

Common agent patterns need batch writes. Add:
- `canvases.bulkAddShapes({ canvasId, shapes: [...] })` so the agent
  can build a retro / decision-matrix in one call instead of N.
- `canvases.applyTemplate({ canvasId, templateId, position })` so the
  agent can drop a "Decision matrix" or "Retro" template at a chosen
  position (already exists as a UI feature; surface as MCP).
- `canvases.layout({ canvasId, algorithm: "topological" | "force" })`
  so the agent can re-flow a messy canvas.

### Inline approval card UX

**Files**
- `chat-thread.tsx` — the `tool_confirm` card from Phase 0 gets
  canvas-specific previews:
  - For `canvases.addNode`: show a mini-card preview at the proposed
    (x, y) (greyed out + "preview" badge) so the operator sees where
    it would land before approving.
  - For `canvases.shapeAdd`: same — mini SVG preview.
  - For `canvases.bulkAddShapes`: list of N shape kinds + "Approve
    all / Approve some / Decline all".
- Approval can be one-shot ("Always allow for this thread") to
  reduce friction during long authoring sessions. Stored in
  localStorage per (threadId, tool).

### Streaming + live canvas updates

When the agent calls a write tool and the operator approves:
1. Forge executes the MCP tool against the DB.
2. The tool's normal SSE fan-out (the workspace realtime channel)
   broadcasts the change.
3. The currently-open canvas page already subscribes to the canvas
   subjectType — the new shape / node lands live.
4. The chat thread shows the `tool_result` card with a short summary.

### Verification
- Operator on canvas page chats: "Set up a retro for last week."
- Agent emits a `tool_confirm` for `canvases.applyTemplate(retro)` +
  4 `canvases.shapeAdd` (quadrant labels).
- Operator approves; canvas updates live; chat shows tool results.

**Agent allocation**: 1 agent (mostly server-side + chat UI; the
canvas already supports the underlying writes from earlier phases).
Estimated 1 session.

---

## Phase 5 — Round-4 chat follow-ups (parked)

Small sweep, no urgency:
- Unify streaming + attachments — `/api/chat/stream` accepts
  `attachments[]` and forwards them as multimodal content blocks to
  the provider (Claude supports image input natively).
- Stop-generating button — wire the existing abort ref to a button
  on the streaming bubble.
- Per-thread provider/model override — extend `ChatThread` with
  `provider` + `model` columns; settings popover surfaces an override
  per thread.

**Agent allocation**: 1 agent. Estimated 1 session.

---

## Sequencing recommendation

If you want to ship this in fewest rounds:

- **Round A**: Phase 0 + Phase 1 (parallelize, ~3 agents). Unblocks
  everything else and improves the chrome immediately.
- **Round B**: Phase 2 (parallel: backend agent + frontend agent).
- **Round C**: Phase 3 (parallel: routing-algo agent + handles-UI
  agent).
- **Round D**: Phase 4 (one agent; small because most plumbing
  exists).
- **Round E** (optional): Phase 5 cleanup.

Each round commits + deploys independently. Migrations: 0044 in
Round B (Phase 2). No others required.

## Deferred / out of scope

- Multi-cursor collaboration (presence cursors already exist; we don't
  do multi-operator editing conflict resolution).
- Voice-to-canvas (Hermes has voice; could be a future addon).
- Real-time canvas export to image (right-click → "Export as PNG").
- Layers / z-index management UI (the data field exists; no UI yet).
- Smart node alignment guides (snapping is already in scope for
  Phase 2 toolbar; sophisticated guides are deferred).
