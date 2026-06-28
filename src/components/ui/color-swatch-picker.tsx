"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Suggested label palette. Shared by the labels settings page and the inline
 * "create label" modal so swatches stay consistent across surfaces.
 */
export const DEFAULT_LABEL_COLORS = [
  "#d97706",
  "#ca8a04",
  "#65a30d",
  "#0ea5e9",
  "#7c3aed",
  "#be185d",
  "#78716c",
];

/**
 * Normalize freeform hex input to `#rrggbb` (lowercase), or `null` if it isn't
 * a valid hex color. Accepts an optional leading `#`, 3- or 6-digit hex, and
 * surrounding whitespace.
 */
export function normalizeHexColor(input: string): string | null {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return "#" + raw.split("").map((c) => c + c).join("");
  }
  if (/^[0-9a-f]{6}$/.test(raw)) {
    return "#" + raw;
  }
  return null;
}

/**
 * Themed color chooser — preset swatches plus a freeform hex field. Replaces
 * the native `<input type="color">` so every surface stays in-app. The hex
 * field accepts any valid hex (3- or 6-digit, with or without `#`).
 */
export function ColorSwatchPicker({
  value,
  onChange,
  swatches = DEFAULT_LABEL_COLORS,
  name,
  className,
}: {
  value: string;
  onChange: (hex: string) => void;
  swatches?: string[];
  /** When set, mirrors the committed value into a hidden input for FormData. */
  name?: string;
  className?: string;
}) {
  // Local text state lets the user type a partial hex without it being snapped
  // back mid-keystroke; we only lift to `onChange` once it normalizes.
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);

  const normalized = normalizeHexColor(text);
  const invalid = text.trim().length > 0 && normalized === null;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {swatches.map((c) => {
          const active = value.toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              type="button"
              onClick={() => {
                onChange(c);
                setText(c);
              }}
              aria-label={c}
              aria-pressed={active}
              className={cn(
                "focus-ring h-6 w-6 rounded-md border border-border transition-transform hover:scale-110",
                active && "ring-2 ring-ember ring-offset-1 ring-offset-card",
              )}
              style={{ backgroundColor: c }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span
          className="h-7 w-7 shrink-0 rounded-md border border-border"
          style={{ backgroundColor: normalized ?? "transparent" }}
          aria-hidden
        />
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const norm = normalizeHexColor(e.target.value);
            if (norm) onChange(norm);
          }}
          onBlur={() => setText(normalized ?? value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="#7c3aed"
          aria-invalid={invalid}
          aria-label="Hex color"
          className={cn(
            "focus-ring h-8 w-28 rounded-md border bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground",
            invalid ? "border-danger" : "border-input",
          )}
        />
        {name && <input type="hidden" name={name} value={value} readOnly />}
      </div>
    </div>
  );
}
