# Forge Design System

> Reference for Forge's visual language. **Canonical source is the code**
> — `src/app/globals.css` (tokens + motion) and `tailwind.config.ts`
> (scale + keyframes). These docs describe it; when they disagree with the
> code, the code wins. Origin: Claude Design audit (handoff bundle), applied
> to the app in `docs/plans/primitives-canvas-design-system.md`.

## Contents

- **[principles.md](./principles.md)** — the ten rules the system follows.
- **[tokens.md](./tokens.md)** — every CSS variable, light + dark.
- **[components.md](./components.md)** — the `@/components/ui` primitives.
- **[motion.md](./motion.md)** — the ambient motion layer (M1–M10).

## The one-paragraph version

Nothing-inspired minimalism blended with Anthropic warm-earthy: high
contrast, zero ornament, generous whitespace, small precise type, monospace
for identifiers. Never pure white or pure black — warm paper (light) and
graphite (dark). A single accent, **ember** (warm amber). Color is only ever
applied through tokens. Motion is ambient and restrained, always degradable
to static.
