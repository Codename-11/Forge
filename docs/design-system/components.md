# Components

The shared primitives in `src/components/ui/`, re-exported from
`@/components/ui`. Import from there — one canonical path per primitive.
Every primitive consumes tokens only.

## Button — `button.tsx`
`cva`-based. **Variants:** `default` (foreground/background), `subtle`,
`ghost`, `ember` (primary action), `outline`, `danger`. **Sizes:** `sm`
(h-7), `default` (h-9), `lg` (h-10), `icon` (h-9 w-9). Always includes
`focus-ring`; transitions colors only. Consumes `--foreground`,
`--background`, `--subtle`, `--ember`, `--ember-foreground`, `--border`,
`--danger`.

## Badge — `badge.tsx`
Small rounded pill. Default is `bg-subtle`/`text-foreground`. Pass a `color`
(hex, usually a DB label/status/project color) to tint background at ~12%
alpha + a leading dot. Note: the design spec showed *named tones* — the real
component is intentionally **color-driven** so DB-assigned label colors flow
through.

## Card — `card.tsx`
`Card` + `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`.
Variants: `default` (border + `bg-card`), `subtle` (border + `bg-card/40`,
translucent — the default export), `outlined` (border only, for nested cards).

## EmptyState — `empty-state.tsx`
Variants `page` / `section` / `card` (decreasing icon + type scale). Optional
`icon`, `title`, `description`, `action`; `as="li"` to slot into list cards.

## Input — `input.tsx`
Token-bordered text field; `focus-ring` for the ember focus halo.

## Kbd / Chord — `kbd.tsx`
`Kbd` renders a single key cap (`.kbd`); `Chord` composes a sequence (e.g.
`g` then `d`). Hardcoded small — a true label, not body content.

## Section / SectionHeader / SectionDivider — `section.tsx`
Heading row (small semibold title + muted hint + right actions) over a body.
`SectionDivider` is the **M9** hairline — a 1px border line that runs a slow
ember sweep when motion is on (static otherwise). Marginless; let the
surrounding `space-y-*` stack space it.

## Skeleton family — `skeleton.tsx`
`Skeleton`, `SkeletonText`, `SkeletonRow`, `SkeletonList`, `SkeletonCard`.
All built on `.ui-shimmer` (reduced-motion aware).

## Spinner — `spinner.tsx`
Token-colored loading spinner; sizes sm/md/lg.

## Toast — `toast.tsx`
`ToastProvider` + `toast()` + `useToast()`. Variants render a left stripe per
tone: default = ember, success, warning, error = danger.

## Modal family — `modal/`
Typed primitives above the legacy `Dialog`: `Confirm`, `QuickForm`,
`SidePanel`, `Picker`, `Drawer`, plus `useModalBehavior` and draft helpers
(`saveDraft`/`readDraft`/`clearDraft`). Prefer these over raw `<Dialog>`.

## Avatar — `avatar.tsx`
Initials/image avatar; sized in px. Used in assignee chips and pickers.

## AgentPresenceDot — `agent-presence-dot.tsx`
Status dot: ONLINE → `--success`, BUSY → `--warning`, OFFLINE →
`--muted-foreground`. `pulse` adds the **M10** ember/success "breath" — ONLINE
only; BUSY/OFFLINE stay flat.

## Tooltip — `ui/tooltip.tsx` + global delegate
`Tooltip` wraps a child and shows a themed floating label. The app also mounts
a global `NativeTooltips` delegate that intercepts every `title` attribute
app-wide — it suppresses the browser's native tooltip and renders the themed
one instead (restoring `title` at rest for accessibility). **Net effect: no
browser tooltips anywhere.** New code can use either a `title` or `<Tooltip>`.

## CountUp / useCountUp — `lib/use-count-up.ts`
The **M6** metric tween: counts 0 → value once on scroll-into-view (rAF,
reduced-motion aware, once-per-mount).
