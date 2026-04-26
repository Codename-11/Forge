import DocsViewer from "../docs-viewer";

/**
 * In-app docs viewer — `/w/{slug}/docs` and `/w/{slug}/docs/<path...>`.
 *
 * Renders an iframe that embeds the Forge VitePress site at `/docs/`.
 * The iframe drops chrome via `?embed=dashboard` (honoured by
 * `docs/.vitepress/theme/index.ts`, which sets
 * `document.documentElement.dataset.embed = "dashboard"` on boot;
 * matching CSS lives in `docs/.vitepress/theme/style.css` under
 * `html[data-embed="dashboard"]`).
 *
 * Pattern matches Lucid: VitePress is built once with `base: "/docs/"`
 * and the resulting `dist/` is served at `/docs/` from the same origin
 * as the app shell. In dev, `pnpm dev:all` runs the VitePress dev
 * server on :5181 and the iframe points at it; in prod (`pnpm build`),
 * the built dist is copied into `public/docs/` and served by Next
 * directly.
 *
 * The optional catch-all (`[[...path]]`) captures both the bare
 * `/docs` URL and any deep link like `/docs/guide/welcome`. We don't
 * server-render the iframe content — `DocsViewer` is a client component
 * that resolves the right `src` from `usePathname()` so back/forward
 * inside the iframe stays in sync with the Forge URL bar (best-effort;
 * VitePress does its own SPA nav inside the frame).
 */
export default async function DocsCatchAllPage({
  params,
}: {
  params: Promise<{ slug: string; path?: string[] }>;
}) {
  const { path } = await params;
  const initialPath = path?.join("/") ?? "";
  return <DocsViewer initialPath={initialPath} />;
}
