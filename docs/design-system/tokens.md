# Tokens

Mirrored from `src/app/globals.css` (`:root` = light, `.dark` = dark).
Values are HSL components (`H S% L%`); consume as `hsl(var(--token))` or via
the Tailwind color of the same name. **Never hardcode a color** — if a hue
shifts, it must shift here and nowhere else.

## Neutrals — warm paper (light) / graphite (dark)

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--background` | `38 20% 97%` | `30 6% 8%` | App background |
| `--foreground` | `30 10% 12%` | `36 16% 92%` | Primary text |
| `--card` | `36 24% 98%` | `30 6% 10%` | Card surface (`bg-card`, `bg-card/40`) |
| `--popover` | `36 24% 98%` | `30 6% 10%` | Floating surfaces |
| `--muted` | `34 16% 92%` | `30 6% 14%` | Muted fills |
| `--muted-foreground` | `30 8% 36%` | `30 10% 62%` | Secondary text |
| `--subtle` | `34 20% 90%` | `30 6% 16%` | Subtle fills / hover |
| `--border` | `30 10% 86%` | `30 6% 18%` | Hairlines, borders |
| `--input` | `30 10% 86%` | `30 6% 18%` | Input borders |
| `--ring` | `25 70% 48%` | `25 80% 58%` | Focus ring |

## Ember — the single accent

| Token | Light | Dark |
|-------|-------|------|
| `--ember` | `25 80% 50%` | `25 90% 58%` |
| `--ember-foreground` | `40 40% 98%` | `30 6% 8%` |

Used for the primary action, the focus ring, selection highlight, and the
ember-tinted motion cues. It is the *only* warm accent — don't introduce a
second.

## Status

| Token | Light | Dark |
|-------|-------|------|
| `--success` | `120 45% 34%` | `120 45% 48%` |
| `--warning` | `38 90% 45%` | `38 90% 56%` |
| `--danger` | `0 60% 44%` | `0 60% 60%` |

## Sticky-note palette

Picked so dark ink reads on every fill without a theme-specific text color.

| Token | Light | Dark |
|-------|-------|------|
| `--sticky-sand` | `38 35% 78%` | `38 30% 64%` |
| `--sticky-blush` | `10 45% 80%` | `10 40% 66%` |
| `--sticky-sage` | `95 22% 72%` | `95 18% 58%` |
| `--sticky-sky` | `205 35% 78%` | `205 30% 64%` |
| `--sticky-lavender` | `265 28% 80%` | `265 23% 66%` |
| `--sticky-peach` | `25 55% 78%` | `25 50% 64%` |

## Radius & type

- `--radius: 0.5rem`; Tailwind `lg` = radius, `md` = radius − 2px, `sm` = radius − 4px.
- `--font-sans` Inter; `--font-mono` JetBrains Mono.
- `fontSize` overrides (`tailwind.config.ts`): `xs` = 0.75rem / 1rem / +0.01em;
  `sm` = 0.8125rem / 1.25rem.

## Density × text-size cascade

The root `font-size` scales every rem-based size. Driven by `<html>`
`data-density` / `data-textsize` (stamped at SSR by the root layout, kept in
sync by `AppearanceProvider`).

| density \ textsize | default | larger |
|--------------------|---------|--------|
| compact (default) | 16px | 18px |
| comfortable | 17px | 19px |

### Semantic role utilities

For sub-12px surfaces the Appearance preference should move:

- `.text-id` — issue IDs / mono identifiers (0.6875rem, mono)
- `.text-meta` — timestamps, secondary metadata (0.75rem)
- `.text-filename` — filename overlays (0.6875rem)
- `.text-subtitle` — topbar subtitles (0.75rem)

Leave true labels (badges, kbd hints, count bubbles, uppercase eyebrows)
hardcoded — those stay small regardless of Appearance.
