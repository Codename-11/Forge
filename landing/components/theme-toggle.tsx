"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Icon } from "@/components/icon";

/**
 * Light/dark toggle for the nav. Renders a stable placeholder until
 * mounted so SSR markup matches the first client paint (next-themes
 * can't know the resolved theme on the server).
 */
export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";
  const next = isDark ? "light" : "dark";

  return (
    <button
      type="button"
      aria-label={mounted ? `Switch to ${next} theme` : "Toggle theme"}
      onClick={() => setTheme(next)}
      style={{
        width: 32,
        height: 32,
        display: "grid",
        placeItems: "center",
        border: "1px solid hsl(var(--border))",
        borderRadius: "calc(var(--radius) - 2px)",
        background: "hsl(var(--card) / 0.6)",
        color: "hsl(var(--foreground))",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {/* Render Moon before mount to match the dark-friendly default. */}
      <Icon name={mounted && !isDark ? "Sun" : "Moon"} size={15} />
    </button>
  );
}
