"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, BookOpen } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";

/**
 * In-app VitePress docs iframe.
 *
 * Resolves the right embed URL based on environment:
 *   - dev (NODE_ENV !== "production"): iframe points at the VitePress
 *     dev server (default `http://localhost:5181/docs/`). Override via
 *     `NEXT_PUBLIC_DOCS_DEV_URL` if you're running the docs on a
 *     different port. If the dev server isn't up, the iframe shows
 *     VitePress's normal connection error — that's expected; run
 *     `pnpm dev:all` to launch both the app and docs together.
 *   - prod: same-origin `/docs/`. The built VitePress dist is copied
 *     into `public/docs/` by `pnpm build` (see `package.json`). Same
 *     origin avoids CORS and keeps the `X-Frame-Options: SAMEORIGIN`
 *     header working (set per-path in `next.config.ts`).
 *
 * The `?embed=dashboard` query param triggers
 * `document.documentElement.dataset.embed = "dashboard"` inside the
 * iframe (see `docs/.vitepress/theme/index.ts`), which the theme CSS
 * uses to hide VitePress's top nav and tighten the layout. The
 * sidebar/toc inside the docs is left intact — the iframe content
 * still has its own navigation.
 *
 * Note on deep-link sync: when you click around inside the iframe,
 * VitePress does SPA navigation and we don't try to mirror the path
 * back into Forge's URL bar (cross-origin frame access is blocked in
 * dev because the dev server is on a different port; same-origin in
 * prod, but mirroring would require message-passing from the docs
 * theme, which adds complexity for little gain). The reverse direction
 * — landing on `/w/{slug}/docs/guide/welcome` — is supported via the
 * catch-all route, which sets the iframe's initial `src`.
 */

const DEFAULT_DEV_URL = "http://localhost:5181/docs/";

function resolveBase(): string {
  // Build-time env (Next inlines NEXT_PUBLIC_* into client bundles).
  if (process.env.NODE_ENV !== "production") {
    return process.env.NEXT_PUBLIC_DOCS_DEV_URL || DEFAULT_DEV_URL;
  }
  // Same-origin in prod. Static files served by Next from public/docs/.
  return "/docs/";
}

function buildSrc(base: string, initialPath: string): string {
  // Strip a leading slash from initialPath so we don't double-up on `//`.
  const trimmed = initialPath.replace(/^\/+/, "");
  // VitePress with `cleanUrls: false` (our setting) ships `.html` for
  // every page. Append `.html` only if the user hit a deep link without
  // an extension and didn't ask for the index. Same heuristic Lucid's
  // dashboard uses.
  const looksLikeFile = /\.[a-z0-9]+$/i.test(trimmed);
  const path =
    trimmed.length > 0 && !looksLikeFile && !trimmed.endsWith("/")
      ? `${trimmed}.html`
      : trimmed;
  // Always set ?embed=dashboard so the docs theme hides chrome.
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${path}${sep}embed=dashboard`;
}

export default function DocsViewer({ initialPath }: { initialPath: string }) {
  const base = useMemo(resolveBase, []);
  const src = useMemo(() => buildSrc(base, initialPath), [base, initialPath]);

  // Track whether the iframe has loaded; show a thin progress hint until
  // it does. Errors (dev server down) just fall through to the iframe's
  // own error state — we don't try to detect those.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [src]);

  const openExternal = () => {
    // Open the docs in a new tab, full chrome. Strip ?embed=dashboard.
    const externalUrl = src.replace(/[?&]embed=dashboard\b/, "");
    window.open(externalUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <>
      <Topbar
        title={
          <span className="inline-flex items-center gap-2">
            <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
            Docs
          </span>
        }
        subtitle="Forge guide, concepts, agents, automation, and reference."
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={openExternal}
            title="Open in a new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="ml-1.5">Open in new tab</span>
          </Button>
        }
      />
      <div className="relative min-h-0 flex-1 bg-background">
        {!loaded && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
            <div className="h-full w-1/3 animate-pulse bg-ember/60" />
          </div>
        )}
        <iframe
          ref={iframeRef}
          // `key`-on-src forces a fresh mount when the deep-link path
          // changes via Forge nav (clicking the sidebar's Docs entry
          // again, or a future router-driven param change).
          key={src}
          src={src}
          title="Forge documentation"
          className="h-full w-full border-0 bg-background"
          // Sandbox flags: same-origin lets the iframe load assets and
          // stylesheets normally; allow-scripts is required for the
          // VitePress SPA. We omit allow-top-navigation so the docs
          // can't bust out of the frame.
          // (We don't set `sandbox` at all in same-origin prod because
          // `allow-same-origin` + a literal same-origin URL is the
          // VitePress default contract; setting sandbox can break
          // localStorage-backed theme persistence. Dev runs on a
          // different port so it's already cross-origin from the app.)
          onLoad={() => setLoaded(true)}
        />
      </div>
    </>
  );
}
