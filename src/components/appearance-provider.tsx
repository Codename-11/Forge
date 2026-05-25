"use client";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { writeAppearanceCookie } from "@/lib/appearance-cookie";

/**
 * AppearanceProvider
 *
 * Reflects the current user's saved `density` + `textSize` prefs onto
 * the <html> element so the CSS utilities in `globals.css` (`.text-id`,
 * `.text-meta`, `.text-filename`, `.text-subtitle`) cascade correctly.
 *
 * First paint is handled by the root server layout, which reads the
 * `forge.appearance` cookie and stamps `data-density` / `data-textsize`
 * before any HTML is sent — no flash on reload. This provider keeps
 * the in-session DOM + cookie in sync once `trpc.user.me` resolves so
 * a new device with a stale cookie self-heals on the first load.
 */
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { data } = trpc.user.me.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!data) return;
    const html = document.documentElement;
    const density = data.density === "comfortable" ? "comfortable" : "compact";
    const textSize = data.textSize === "larger" ? "larger" : "default";
    const motion = data.motion === "reduced" ? "reduced" : "full";
    const background =
      data.backgroundStyle === "glow" ||
      data.backgroundStyle === "dots" ||
      data.backgroundStyle === "none"
        ? data.backgroundStyle
        : "grid";
    html.setAttribute("data-density", density);
    html.setAttribute("data-textsize", textSize);
    html.setAttribute("data-motion", motion === "reduced" ? "off" : "on");
    html.setAttribute("data-bg", background);
    writeAppearanceCookie({ density, textSize, motion, background });
  }, [data?.density, data?.textSize, data?.motion, data?.backgroundStyle, data]);

  return <>{children}</>;
}
