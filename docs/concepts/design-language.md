# Design Language

Warm paper, single ember accent, dense but readable.

Forge's visual language has three goals: be calm, be legible, and stay
out of your way. This page is the reference for anyone extending the UI
— a plugin author, a designer adding a surface, or anyone wondering
"why does this look the way it does."

## Palette intent

The palette is warm earthy stones. Three named colors do most of the
work:

| Token | Approx HSL | Use |
| --- | --- | --- |
| `--paper` | `hsl(38 20% 97%)` | App background, card surfaces. |
| `--graphite` | `hsl(30 10% 12%)` | Primary text, icons, borders' darkest neighbor. |
| `--ember` | `hsl(25 80% 50%)` | Single accent — focus rings, primary CTA, active markers. |

Around those three sit a small ladder of supporting tones: card-tinted
backgrounds, muted-foreground text, hairline tan borders. They live in
`src/app/globals.css` as CSS custom properties and are surfaced through
Tailwind tokens (`bg-card/40`, `text-muted-foreground`, `border-border`).

::: warning
Never pure white, never pure black. `#fff` and `#000` are warm-tinted in
the token set on purpose. The substitution matters: pure white reads as
clinical, pure black reads as harsh, and the warm offsets read as paper
and graphite. Don't reach around the tokens.
:::

The dark mode palette inverts the paper/graphite relationship without
losing the warm tint. Ember stays the same.

## Type

Two faces, no display.

- **Inter** — sans-serif. The body face. Used for prose, UI chrome,
  labels, button text, table headers, basically everything that isn't an
  identifier.
- **JetBrains Mono** — monospace. Used for identifiers: issue keys
  (`AXI-42`), agent handles (`@victor`), API keys, hashes, file names,
  keyboard hint chips (<kbd>⌘K</kbd>), and anything else that should
  read as machine-shaped.

There is no display face, no tertiary face, no italic body. Italics are
used sparingly for emphasis in prose and for nothing else.

::: tip
When you're tempted to introduce a third face — for a hero, for a
quote, for "personality" — don't. The product's personality is supposed
to come from precision, not from typography variety.
:::

## Restraint

The ember accent appears in five places:

1. **Primary CTAs** — the single most important button on a screen.
2. **Focus rings** — keyboard focus state on every interactive element.
3. **Active sidebar markers** — the small tick on the currently-selected
   nav item.
4. **Unread indicators** — the dot on a notification or comment thread
   you haven't seen.
5. **Code-block left rail** — a thin ember stripe down the left edge of
   syntax-highlighted code blocks.

That's the list. Body text is monochrome. Status colors come from the
`Status.color` row, not from the palette. Priority colors come from a
small per-priority palette (`URGENT` is ember-leaning red, `HIGH` is
amber, `MEDIUM` is the muted graphite, `LOW` is grayer still, `NONE` is
hairline).

Every additional ember-touched element is a budget hit. Spend it
intentionally.

## Density

Two per-user preferences cascade onto `<html>`:

- `data-density` — `"compact"` or `"comfortable"`.
- `data-textsize` — `"default"` or `"larger"`.

The `AppearanceProvider` reads these from the user's `User.density` and
`User.textSize` columns and sets them on the document root. CSS in
`globals.css` keys off the data attributes to scale spacing and primary
content text size.

Four utility classes pick up the cascade:

- **`.text-id`** — issue IDs, keys, mono identifiers. Includes
  `font-mono`.
- **`.text-meta`** — timestamps, secondary metadata.
- **`.text-filename`** — filename overlays on attachment thumbs.
- **`.text-subtitle`** — topbar subtitles.

Use these classes when you're rendering primary content that the
Appearance setting should actually move. Hardcoded `text-[10px]` and
`text-[11px]` are reserved for true labels (badges, kbd hints, count
bubbles, uppercase eyebrows) — those should stay small regardless of
the user's density preference.

```tsx
// Primary content — moves with the user's preferences.
<span className="text-id">{issue.key}</span>
<span className="text-meta">{relativeTime(issue.updatedAt)}</span>

// Persistent labels — stay small.
<span className="text-[10px] uppercase tracking-wide">Sprint</span>
```

::: info
The four utility classes are an explicit boundary. If you find yourself
adding a fifth, consider whether it really belongs in primary content
(in which case extend the convention) or in chrome (in which case
hardcode and move on).
:::

## Motion

Short, ease-out, no overshoot.

- All transitions use `ease-out` curves between **100ms** and **300ms**.
- No bounce, no spring, no overshoot.
- All motion respects `prefers-reduced-motion`. When the user has
  reduced motion enabled, transitions collapse to instant.

The transitions you'll touch:

- **Hover** — 100-150ms color shift on borders and surfaces.
- **Focus** — instant focus ring (no transition; the ring should appear
  immediately on focus).
- **Open/close** — 200ms ease-out for popovers, dialogs, and dropdowns.
  No translate-on-open; the surface fades and scales subtly (95% → 100%).
- **Route change** — no animated route change. The page swaps.

```css
/* Standard surface transition */
.surface {
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .surface { transition: none; }
}
```

## Borders, radius, no shadows

Forge does not use drop shadows on surfaces. Layer separation comes from:

- **Hairline tan borders** — `1px` solid `hsl(35 20% 88%)` (paper) or
  the dark-mode equivalent. Borders separate cards and table rows.
- **Tinted card backgrounds** — `bg-card/40` is a subtle warm tint over
  paper. It reads as a card without the visual cost of a shadow.
- **Soft hover color shifts** — borders darken on hover (`border-foreground/15`
  → `border-foreground/30`) instead of shadows appearing.

Radius is small and consistent: `4px` on inputs, `6px` on cards and
buttons, `8px` on dialogs and large surfaces. Nothing is fully rounded
except avatars and circular badges.

## Cross-references

- [Guide → Settings](/guide/settings.html) — the Appearance section
  where users pick density and text size.
- [Guide → Keyboard](/guide/keyboard.html) — the keyboard surface that
  the design language assumes is available.
- [Guide → Welcome](/guide/welcome.html) — the design discipline as
  product principle.
