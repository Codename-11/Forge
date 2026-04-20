"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type View = "list" | "board";

export function useViewPref(scope: string, fallback: View = "list") {
  const key = `forge:view:${scope}`;
  const [view, setView] = useState<View>(fallback);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === "list" || stored === "board") setView(stored);
    } catch {}
  }, [key]);
  const update = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(key, v);
    } catch {}
  };
  return [view, update] as const;
}

export function ViewToggle({
  value,
  onChange,
}: {
  value: View;
  onChange: (v: View) => void;
}) {
  return (
    <div className="flex h-7 items-center rounded-md border border-border p-0.5 text-xs">
      {(["list", "board"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "focus-ring rounded-sm px-2 py-0.5 capitalize transition-colors",
            value === v
              ? "bg-subtle text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "board" ? "Kanban" : "List"}
        </button>
      ))}
    </div>
  );
}
