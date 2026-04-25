"use client";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";

/**
 * AppearanceProvider
 *
 * Reflects the current user's saved `density` + `textSize` prefs onto
 * the <html> element so the CSS utilities in `globals.css` (`.text-id`,
 * `.text-meta`, `.text-filename`, `.text-subtitle`) cascade correctly.
 *
 * Defaults to compact / default until the query resolves so SSR markup
 * is stable across renders. Mounted inside the workspace shell layout
 * so it sits behind the auth gate.
 *
 * The `apply-density` agent owns swapping ad-hoc `text-[10px]` etc.
 * across components for the named utility classes; this provider is
 * the single source of truth that wires the preference to the DOM.
 */
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { data } = trpc.user.me.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const density = data?.density === "comfortable" ? "comfortable" : "compact";
    const textSize = data?.textSize === "larger" ? "larger" : "default";
    html.setAttribute("data-density", density);
    html.setAttribute("data-textsize", textSize);
  }, [data?.density, data?.textSize]);

  return <>{children}</>;
}
