# Plan — Apply the Forge design spec to the app (Claude Design handoff)

> **Goal:** The linked `Forge Primitives Canvas` is a **design spec** — Claude
> Design's rendering of how Forge's primitives should look and the motion that
> should enhance them. This plan **applies that spec to the existing Forge app**.
> We are **not** rebuilding the Claude Design canvas tool, and **not** adding a
> new route. We make the real components + global CSS match the spec, and we
> implement the ten motion enhancements (M1–M10) on the real surfaces.
>
> Source bundle (decompressed from the handoff): `forge-design-system/`.
> Files read: `README.md`, `chats/chat1.md`, `project/forge-tokens.css`,
> `project/js/lib.jsx`, `project/js/canvas-app.jsx` (the canvas + its engine,
> `design-canvas.jsx`, are the *presentation medium* — reference only, not to be
> ported).

## Decisions (baked in — change here if wrong before setting the goal)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Scope | Apply spec to real components/CSS. **No new route, no canvas tool.** |
| D2 | Motion CSS home | Append to `src/app/globals.css` under `/* Motion — forge-* */`; register keyframes in `tailwind.config.ts`. Namespaced `forge-*` to match `.ui-*` / `.dag-*`. |
| D3 | Motion gating | Every animation gated on **both** `@media (prefers-reduced-motion: no-preference)` **and** `[data-motion="on"]`, with static `[data-motion="off"]` fallbacks. No new color tokens. |
| D4 | Motion default | `data-motion="on"` on `<html>` via `AppearanceProvider` (next to `data-density`/`data-textsize`). |
| D5 | Staging | Land per the transcript's PR sequence (below), not all 10 at once. Defer M2 + M3 (don't stack ambient backgrounds). |

## Part 1 — Token audit (expected no-op)
`forge-tokens.css` (handoff) claims to mirror `src/app/globals.css` verbatim.
Diff the `:root` + `.dark` blocks. `globals.css` is canonical — if anything
drifted, fix the handoff understanding, **not** the app. Record the diff in the
DEVLOG. No token edits expected.

## Part 2 — Primitive conformance check
The spec's artboards (in `canvas-app.jsx`) describe how each primitive should
look. Confirm the real `@/components/ui` components already match; fix only real
divergences (the `lib.jsx` shims are reference, not a target to copy). Check:

- **Button** — 6 variants (default, subtle, ghost, ember, outline, danger) ×
  3 sizes (sm/default/lg), icon + Kbd composition, disabled.
- **Badge** — 6 tones (subtle, ember, success, warning, danger, muted).
- **Card** — default / subtle (`bg-card/40`) / outlined.
- **EmptyState** — page / section / card variants.
- **Skeleton** family on `.ui-shimmer`; **Spinner** sizes.
- **Toast** — stripe-per-variant (default=ember, success, warning, error=danger).
- **Picker / Dialog**, **Kbd / Chord**, **Avatar** sizes, status dots.

Output: a short conformance note in the DEVLOG. Most should already match; this
is verification, not a rebuild.

## Part 3 — The ten motion enhancements (the real work)

### 3.0 Foundation (prereq for all motions)
1. **`src/app/globals.css`** — append the `forge-*` classes + keyframes from
   `forge-tokens.css` lines 144–354:
   `.forge-grid-bg`/`forge-grid-drift` (M1), `.forge-aurora`/`forge-aurora-drift`
   (M2), `.forge-dots`/`forge-dots-drift` (M3), `.forge-row-rise`/`forge-row-rise`
   kf (M4 — **use `rem`: `translateY(0.25rem)`** so it scales with density),
   `.forge-streaming` + `.forge-streaming-cursor` + `forge-stream-sweep` /
   `forge-caret-blink` (M5), `.forge-active-node`/`forge-pulse` (M7),
   `.forge-caret` (M8), `.forge-hairline`/`forge-hairline-sweep` (M9),
   `.forge-breath`/`forge-breath` kf (M10). All double-gated per D3.
2. **`tailwind.config.ts`** — register keyframes alongside `fade-in`/`shimmer`:
   `forge-grid-drift, forge-aurora-drift, forge-dots-drift, forge-row-rise,
   forge-stream-sweep, forge-pulse, forge-breath, forge-hairline-sweep,
   forge-caret-blink`.
3. **`src/lib/use-count-up.ts`** — port `useTinyCountUp`: `IntersectionObserver`
   + `rAF`, cubic ease-out, honors reduced-motion (jump to target), **idempotent
   per mount** (`useRef(target)`; bail if unchanged).
4. **`AppearanceProvider`** — set `data-motion="on"` on `<html>`. (Optional
   follow-up: a "Motion: Full / Reduced" control in `/settings/appearance` that
   flips it — note in DEVLOG, not v1.)
5. **Lint guard** — require new keyframe/animation class names in `globals.css`
   to be `forge-`/`ui-`/`dag-` prefixed; grandfather `shimmer`/`fade-in`.

### 3.1 Per-motion surface wiring (real files)

| ID | Enhancement | Lands on | Notes |
|----|-------------|----------|-------|
| **M1** | Animated grid bg (48s drift) | dashboard `page.tsx` background; EmptyState (`src/components/ui/empty-state.tsx`) page variant | Extends existing `.grid-striped`. Subtle; behind content. |
| **M4** | Staggered row rise | `src/components/issue-list.tsx`, `src/components/mission-control/swimlane.tsx` | **Only on initial mount** — gate with an `isInitialMount` ref so virtualized remounts don't re-stagger. Cap delay ~row 8. |
| **M7** | Active-node pulse | `src/components/orchestration/dag-view.tsx` + `step-node.tsx` | One `.forge-active-node` per render (the unique RUNNING step) — bake into the component, not a sprinkle-able class. Pairs with existing `.dag-edge-flow`. |
| **M5** | Streaming text shimmer | `src/components/mission-control/chat-message.tsx` (+ `chat-thread-stream` channel) | Animate only while `phase === 'delta'`; **drop `.forge-streaming` on `finalized`** so persisted text is real `--foreground` and selectable. |
| **M6** | Metric count-up | dashboard stat tiles (`dashboard/page.tsx`) | Use `useCountUp` (3.0.3). Count once per mount; don't re-tween on filter remount. |
| **M8** | Omnibar caret blink | `src/components/command-palette.tsx` | Ember 1px caret. Bridges omnibar to the streaming visual language. |
| **M9** | Hairline divider sweep | settings section dividers (`src/components/ui/section.tsx` / settings pages) | 6s ember band across one divider; a slow heartbeat. |
| **M10** | Idle status-dot breath | `src/components/agent-presence-dot.tsx` (+ `agent-presence-strip.tsx`) | **ONLINE only** breathes; BUSY/OFFLINE stay static. |
| ~~M2~~ | Ember aurora glow | deferred | Pick one ambient bg per surface — don't stack with M1/M3. |
| ~~M3~~ | Token-dot drift | deferred | Sibling to M1; choose per surface later. |

### 3.2 Staging (commit/PR sequence, from the transcript)
1. **Foundation (3.0)** + **M1 + M4 + M7** — extend patterns Forge already
   ships (`.grid-striped`, `fade-in`, `.dag-edge-flow`). Zero new deps/tokens.
2. **M5** — wire into `chat-thread-stream`; respect the selection caveat.
3. **M6** — `useCountUp` on dashboard tiles.
4. **M8 / M9 / M10** — independent; land as those surfaces get touched.
5. **Defer M2 + M3** until one ambient bg is chosen per surface.

## Out of scope
- The Claude Design canvas tool / any new route (D1).
- The separate docs site (`Forge Design System.html` → `docs/design-system/`
  tokens/components/principles) — track separately if wanted.
- Server-synced anything; the Appearance motion toggle (optional follow-up).
- M2 / M3 in product (deferred).

## Before shipping
`pnpm lint && pnpm typecheck && pnpm test` → `pnpm test:e2e` → append DEVLOG →
commit. Verify reduced-motion: set OS reduced-motion (or `data-motion="off"`)
and confirm every motion falls back to static and text in streaming bubbles
stays selectable.
