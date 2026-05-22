# Motion

The ambient motion layer. Canonical definitions live in `src/app/globals.css`
under `/* Motion — forge-* */`; matching keyframes are registered in
`tailwind.config.ts` (so `animate-forge-*` utilities exist too).

## Gating (every animation)

Double-gated, with a static fallback in both off-states:

```css
@media (prefers-reduced-motion: no-preference) {
  [data-motion="on"] .forge-x { animation: …; }
}
```

- **OS reduced-motion** → no animation (the media query).
- **`data-motion="off"`** on `<html>` → no animation. Set by the root layout
  from the user's `motion` pref and by the **Appearance → Motion** toggle
  (`full` | `reduced`). Independent of the OS setting.

Class names are `forge-` prefixed (enforced by
`tests/unit/globals-keyframe-prefix.test.ts`).

## The ten

| ID | Class / hook | What | Where it's wired |
|----|--------------|------|------------------|
| **M1** | `.forge-grid-bg` | Two-axis paper grid, 48s drift. Extends `.grid-striped`. | Dashboard background (40% opacity) |
| **M2** | `.forge-aurora` | Soft ember radial, 28s drift. | Class only — deferred (don't stack ambient bgs) |
| **M3** | `.forge-dots` | Sparse low-alpha dot field, 60s drift. | Class only — deferred |
| **M4** | `.forge-row-rise` | Staggered fade-in-up on list-row mount (`--row-i × 35ms`, rem-based). | `IssueList` (initial mount only) |
| **M5** | `.forge-streaming` / `.forge-streaming-cursor` | Ember sweep over streaming text + caret. | Agent draft bubbles (`chat-message.tsx`); dropped on finalize so text stays selectable |
| **M6** | `useCountUp` / `CountUp` | Count 0 → value on scroll-in (rAF, no lib). | Dashboard "By status" counts |
| **M7** | `.forge-active-node` | Ember inset ring + breathing halo on the RUNNING node. Pairs with `.dag-edge-flow`. | Orchestration `StepNode` (running only) |
| **M8** | `.forge-caret` | Ember 1px caret blink. | Sidebar "Search or jump" omnibar trigger |
| **M9** | `.forge-hairline` (`SectionDivider`) | Slow ember band across a divider. | Appearance settings dividers |
| **M10** | `.forge-breath` | Breathing success halo on ONLINE presence. | `AgentPresenceDot` (`pulse`, ONLINE only) |

## Implementation watch-items

- **M4 + virtualized lists**: stagger only on initial mount — gate with an
  `isInitialMount`/`staggeredOnce` ref so virtual remounts don't re-stagger.
  Cap `--row-i` (~8).
- **M5 + selection**: `background-clip:text; color:transparent` kills text
  selection — drop `.forge-streaming` on finalize so persisted text is real
  `--foreground`.
- **M7 scope**: one `.forge-active-node` per render (the unique RUNNING step);
  baked into the component, not a sprinkle-able utility.
- **M6 idempotency**: tween once per mount; don't re-run when a filter remounts
  the same value.
- **M4 units**: `translateY` in rem so the rise scales with density.
