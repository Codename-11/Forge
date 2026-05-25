export const APPEARANCE_COOKIE = "forge.appearance";

export type AppearanceDensity = "compact" | "comfortable";
export type AppearanceTextSize = "default" | "larger";
export type AppearanceMotion = "full" | "reduced";
export type AppearanceBackground =
  | "grid"
  | "glow"
  | "dots"
  | "reactive"
  | "particles"
  | "none";
export interface AppearancePrefs {
  density: AppearanceDensity;
  textSize: AppearanceTextSize;
  motion: AppearanceMotion;
  background: AppearanceBackground;
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Mirror the operator's appearance preferences into a non-httpOnly
 * cookie so the next SSR pass on the root layout can stamp `<html>`
 * with the right `data-density` / `data-textsize` before first paint.
 *
 * Called both eagerly from the appearance toggles (so the cookie is
 * updated even before the trpc mutation resolves) and from the
 * AppearanceProvider's catch-up effect (so a new device with a stale
 * cookie self-heals on first authenticated load).
 */
export function writeAppearanceCookie(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const value = encodeURIComponent(JSON.stringify(prefs));
  document.cookie = `${APPEARANCE_COOKIE}=${value}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}
