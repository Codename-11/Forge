# Principles

Extracted from `CLAUDE.md`, `globals.css`, and how the primitives behave.

1. **Tokens, never literals.** Every color comes from a CSS variable. No raw
   hex/rgb in components. A hue change happens in `globals.css` and nowhere
   else.
2. **No pure white, no pure black.** Light is warm paper, dark is graphite.
3. **One accent.** Ember (warm amber) is the only accent — primary action,
   focus ring, selection, motion cues. Don't add a second.
4. **Small, precise type; mono for identifiers.** Issue IDs, keys, run ids,
   tokens — monospace. Everything else sans (Inter).
5. **Density-aware sizing.** Sized values are rem so the density × text-size
   cascade scales the whole app from one root `font-size`. Use the `.text-*`
   role utilities for sub-12px primary content; hardcode true labels.
6. **Generous whitespace, zero ornament.** Nothing-inspired restraint — no
   gradients-for-decoration, no drop shadows beyond soft elevation, no
   borders that aren't doing a job.
7. **Borders are hairlines.** 1px `--border`; dashed only for "draft/optional"
   affordances.
8. **Motion is ambient and degradable.** Quiet, slow, never bouncy. Every
   animation is gated on `prefers-reduced-motion: no-preference` **and**
   `[data-motion="on"]`, with a static fallback. See [motion.md](./motion.md).
9. **Keyboard-first.** Focus is always visible (`focus-ring` → ember halo).
   Shortcuts shown with `Kbd`/`Chord`.
10. **Themed, not native.** UI chrome — including tooltips — uses Forge
    primitives. No browser-native tooltips (a global delegate converts every
    `title` attribute into a themed tooltip).

## Allowed / refused at review

| Allowed | Refused |
|---------|---------|
| `bg-card/40`, `text-muted-foreground`, token classes | ad-hoc `text-[#…]`, `bg-white`, `bg-black` |
| `forge-`/`ui-`/`dag-` prefixed animations | new bare keyframe names (`shimmer`-style) |
| rem sizes / `.text-*` utilities for primary content | hardcoded `text-[11px]` on primary content |
| ember for the single accent | a second accent hue |
| `<Tooltip>` / `title` (themed by the delegate) | hand-rolled native-only tooltips |
