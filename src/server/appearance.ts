import "server-only";
import { cookies } from "next/headers";

export const APPEARANCE_COOKIE = "forge.appearance";

export type AppearanceDensity = "compact" | "comfortable";
export type AppearanceTextSize = "default" | "larger";
export interface AppearancePrefs {
  density: AppearanceDensity;
  textSize: AppearanceTextSize;
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  density: "compact",
  textSize: "default",
};

/**
 * Read the operator's appearance preferences from the cookie bridge so
 * the root layout can stamp `data-density` and `data-textsize` on
 * `<html>` at SSR — avoiding the FOUC where AppearanceProvider only
 * sets the attrs after hydration and the trpc.user.me query resolves.
 *
 * The cookie is written by the appearance settings page and by the
 * provider's catch-up effect when `trpc.user.me` resolves.
 */
export async function readAppearance(): Promise<AppearancePrefs> {
  try {
    const store = await cookies();
    const c = store.get(APPEARANCE_COOKIE);
    if (!c) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(decodeURIComponent(c.value)) as Partial<AppearancePrefs>;
    return {
      density: parsed.density === "comfortable" ? "comfortable" : "compact",
      textSize: parsed.textSize === "larger" ? "larger" : "default",
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}
