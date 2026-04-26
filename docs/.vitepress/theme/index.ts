import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "./style.css";

/**
 * Forge docs theme entry.
 *
 * Honors the `?embed=dashboard` URL param so the docs render chromeless
 * when iframed inside the Forge app (the workspace `/docs` route in
 * `src/app/(app)/w/[slug]/docs/`). The `data-embed="dashboard"` rules in
 * `style.css` hide the top nav, local nav, and adjust content padding so
 * the docs sit flush in the iframe.
 *
 * Mirrors Lucid's pattern (its dashboard iframes the VitePress build at
 * `/docs/`, dropping chrome via the same `data-embed` attribute).
 */
function applyEmbedFlag() {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    const embed = params.get("embed");
    if (embed) {
      document.documentElement.dataset.embed = embed;
    }
  } catch {
    /* no-op — SSR or sandboxed iframe without query access */
  }
}

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp() {
    // Runs once on the client when the VitePress app mounts. Subsequent
    // SPA-style nav inside the docs preserves the URL query, so we only
    // need to set the flag once at boot.
    applyEmbedFlag();
  },
};

export default theme;
