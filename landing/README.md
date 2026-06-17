# Forge — Landing Site

The public marketing site for [Forge](https://github.com/Codename-11/forge). A
**standalone** Next.js app, fully decoupled from the main application: it has
its own `package.json`, its own dependencies, and emits a **static site** you
can host anywhere.

It was implemented from the `Forge Landing Site` design (Claude Design handoff
bundle) and recreates that design pixel-for-pixel using the same Forge token
system (`globals.css` mirrors `src/app/globals.css` from the main repo).

## Stack

Next.js 15 (App Router, `output: "export"`) · React 19 · TypeScript ·
Tailwind 3 (wired to the Forge token CSS vars) · `next/font` (Inter +
JetBrains Mono) · `next-themes` (light/dark).

## Develop

```bash
cd landing
pnpm install          # standalone; resolves from the repo's pnpm store
pnpm dev              # binds 0.0.0.0:3200 — http://localhost:3200 (and over the LAN)
```

> Port `3100` is taken by the `mission-control` container, so dev/start/serve
> default to **`3200`** on `0.0.0.0` (reachable from other machines on the LAN).
> Change the port in `package.json` if `3200` is occupied.

## Build & deploy

```bash
pnpm build            # static export → ./out
pnpm serve            # preview the exported site locally (npx serve)
```

`out/` is a plain static bundle. Drop it on GitHub Pages, S3/CloudFront,
Netlify, Vercel, or behind the same reverse proxy as the app. No Node server
is required. (If you later need server features, remove `output: "export"`
in `next.config.ts` and run `pnpm start`.)

Set the canonical URL via `NEXT_PUBLIC_SITE_URL` at build time (used for
metadata / Open Graph). Defaults to `https://forge.axiom-labs.dev`.

## Live data

**Version + changelog** are read from the repo **at build time** (`lib/releases.ts`):
the version comes from `../package.json` and the release list is parsed from the
real `../CHANGELOG.md` — so the site stays accurate on every rebuild, with a
baked-in real fallback if those files aren't found. No hard-coded version or
changelog copy to drift.

**Star count is live at runtime.** `components/github-stars.tsx` is a client
component that fetches `stargazers_count` from the public GitHub REST API (no
token; CORS-open) and renders a `★ N` badge in the nav + footer. It renders
nothing while loading or on error, dedupes concurrent mounts via a module-level
in-flight promise, and caches the count in `localStorage` for 1h to stay well
under the unauthenticated rate limit. Repo identity lives in the Node-free
`lib/repo.ts` so the client bundle never pulls `lib/releases.ts`'s build-time
`fs` reads.

## Layout

```
landing/
  app/
    layout.tsx           # fonts, theme provider, metadata
    page.tsx             # the landing page (composes the sections below)
    releases/page.tsx    # /releases — full changelog
    docs/page.tsx        # /docs — docs index
    globals.css          # Forge tokens + motion + responsive layer
  components/
    icon.tsx             # Forge icon set (stroke-1.6 lucide-style)
    logo.tsx             # the Forge brand mark (inline SVG)
    primitives.tsx       # Eyebrow, GhostButton, SectionShell
    theme-toggle.tsx     # nav light/dark toggle (client)
    github-stars.tsx     # live GitHub star badge (client; runtime fetch)
    nav.tsx hero.tsx pillars.tsx runtimes.tsx product-strip.tsx
    planning.tsx self-host.tsx releases-section.tsx footer.tsx docs-content.tsx
  lib/
    repo.ts              # repo identity + GitHub endpoints (Node-free)
    releases.ts          # build-time version + changelog (../package.json, ../CHANGELOG.md)
```

## Design fidelity

The section components are inline-styled with `hsl(var(--token))` exactly as the
prototype. Production-only additions over the prototype:

- The canvas/tweaks shell is dropped; the page renders directly and **reflows
  responsively** (the prototype shipped fixed desktop/mobile artboards).
- Responsive behaviour is layered via marker classes (`.lnd-cols-*`,
  `.lnd-pad`, `.lnd-hero-grid`, `.lnd-nav*`, `.lnd-footer*`) in `globals.css`.
- Prototype hover handlers (`onMouseEnter`/`onMouseLeave`) became CSS `:hover`
  classes so the components can stay server-rendered.
- A real light/dark **theme toggle** in the nav (the prototype's lived in the
  design-canvas panel).
