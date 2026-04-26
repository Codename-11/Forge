/**
 * Central documentation registry for keyboard shortcuts.
 *
 * This module is a *documentation view* consumed by the keyboard-help overlay
 * (`src/components/keyboard-help.tsx`). It intentionally does NOT install any
 * runtime handlers — those still live next to the feature that owns them
 * (sidebar navigation, issue detail, cycles page, command palette, etc.).
 *
 * Keeping the list here makes it possible for a single `?` press to show a
 * consistent, up-to-date chord cheatsheet without hunting through the tree.
 * When a new chord is added anywhere in the app, add a matching entry here so
 * it surfaces in the overlay.
 *
 * Chord display conventions:
 *   - "g d"       = leader chord `g` then `d` (navigation chords).
 *   - "⇧C"        = shift + key (single press, no leader).
 *   - "⌘K"        = meta modifier (Ctrl on non-Mac); renderer translates.
 *   - "⌘\\"       = meta + backslash.
 *   - "esc", "⏎"  = literal keys.
 */

export type ShortcutCategory =
  | "Navigate"
  | "Create"
  | "Work"
  | "Views"
  | "Time"
  | "Pins"
  | "Shell"
  | "Other";

export type Shortcut = {
  /** Human-friendly chord string; see conventions above. */
  chord: string;
  /** Short action label shown to the user. */
  label: string;
  category: ShortcutCategory;
  /**
   * Optional hint about where the chord is active (e.g. "issue detail").
   * Empty = global.
   */
  scope?: string;
};

export const SHORTCUTS: readonly Shortcut[] = [
  // --- Navigate ------------------------------------------------------------
  { chord: "g i", label: "Go to Inbox (workspace landing)", category: "Navigate" },
  { chord: "g b", label: "Browse Inbox (alias)", category: "Navigate" },
  { chord: "g s", label: "Go to Issues", category: "Navigate" },
  { chord: "g p", label: "Go to Projects", category: "Navigate" },
  { chord: "g c", label: "Go to Sprints", category: "Navigate" },
  { chord: "g n", label: "New Initiative", category: "Navigate" },
  { chord: "g r", label: "Go to Roadmap", category: "Navigate" },
  { chord: "g u", label: "Go to Standup", category: "Navigate" },
  { chord: "g t", label: "Go to Time", category: "Navigate", scope: "time tracking enabled" },
  { chord: "g a", label: "Go to Analytics", category: "Navigate" },
  { chord: "g o", label: "Go to Agents (operational)", category: "Navigate" },
  { chord: "g e", label: "Go to Agent admin (CRUD)", category: "Navigate" },
  { chord: "g l", label: "Go to Plugins", category: "Navigate" },
  { chord: "g ,", label: "Go to Settings", category: "Navigate" },
  { chord: "g w", label: "Switch workspace", category: "Navigate" },

  // --- Shell ---------------------------------------------------------------
  { chord: "⌘K", label: "Command palette", category: "Shell" },
  { chord: "/", label: "Search", category: "Shell" },
  { chord: "?", label: "Show keyboard shortcuts", category: "Shell" },
  { chord: "⌘\\", label: "Toggle sidebar", category: "Shell" },
  { chord: "esc", label: "Close dialog / cancel", category: "Shell" },

  // --- Create --------------------------------------------------------------
  { chord: "⇧C", label: "Quick-create issue", category: "Create" },

  // --- Work ----------------------------------------------------------------
  // Bare "c" hotkey was removed (it ate Ctrl+C copy). Sprint nav via `g c`.
  { chord: "⇧A", label: "Assign agent", category: "Work", scope: "issue detail" },

  // --- Pins ----------------------------------------------------------------
  { chord: "p", label: "Toggle pin on issue", category: "Pins", scope: "issue detail" },

  // --- Time ----------------------------------------------------------------
  { chord: "t", label: "Toggle time tracker widget", category: "Time", scope: "time tracking enabled" },
  { chord: "⇧T", label: "Start / stop timer", category: "Time", scope: "issue detail" },
];

/** Stable category order for the overlay's grouped layout. */
export const SHORTCUT_CATEGORY_ORDER: readonly ShortcutCategory[] = [
  "Navigate",
  "Shell",
  "Create",
  "Work",
  "Views",
  "Pins",
  "Time",
  "Other",
];

/**
 * Group the flat shortcut list by category, preserving the canonical order.
 * Empty categories are dropped so the overlay only renders sections with
 * content.
 */
export function groupShortcuts(
  list: readonly Shortcut[] = SHORTCUTS,
): Array<{ category: ShortcutCategory; items: Shortcut[] }> {
  const byCat = new Map<ShortcutCategory, Shortcut[]>();
  for (const s of list) {
    const bucket = byCat.get(s.category) ?? [];
    bucket.push(s);
    byCat.set(s.category, bucket);
  }
  const out: Array<{ category: ShortcutCategory; items: Shortcut[] }> = [];
  for (const cat of SHORTCUT_CATEGORY_ORDER) {
    const items = byCat.get(cat);
    if (items && items.length > 0) out.push({ category: cat, items });
  }
  return out;
}
