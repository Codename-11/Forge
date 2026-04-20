"use client";
import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useHotkey } from "@/lib/keyboard";
import { useIsMac } from "@/lib/platform";
import { groupShortcuts, SHORTCUTS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const SHORTCUT_COUNT = SHORTCUTS.length;

/**
 * Global keyboard shortcut cheatsheet.
 *
 * Activated by pressing `?` (shift + /) anywhere outside a text input, or by
 * dispatching the `forge:open-keyboard-help` window event (used by the top
 * bar's `?` button). Closes on `esc` or backdrop click.
 *
 * Content is pulled from `src/lib/shortcuts.ts` — a documentation registry
 * that's kept in sync by hand with the chord handlers elsewhere in the app.
 */
export function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  const isMac = useIsMac();

  useHotkey("shift+?", () => setOpen(true));
  // Many keyboard layouts deliver `?` as shift+/ with `e.key === "?"`; match
  // the raw key too so we catch both bindings cleanly.
  useHotkey("?", () => setOpen(true));

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("forge:open-keyboard-help", handler);
    return () => window.removeEventListener("forge:open-keyboard-help", handler);
  }, []);

  const groups = groupShortcuts();

  return (
    <Dialog open={open} onClose={() => setOpen(false)} className="max-w-2xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Keyboard className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <div className="text-sm font-semibold tracking-tight">Keyboard shortcuts</div>
          <div className="text-[11px] text-muted-foreground">
            Forge is keyboard-first. Press any chord outside a text field.
          </div>
        </div>
        <span className="kbd">esc</span>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-4 py-3">
        <div className="grid gap-5 md:grid-cols-2">
          {groups.map((g) => (
            <section key={g.category} className="space-y-1.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g.category}
              </h3>
              <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card/40">
                {g.items.map((s) => (
                  <li
                    key={`${g.category}:${s.chord}:${s.label}`}
                    className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground">{s.label}</div>
                      {s.scope && (
                        <div className="truncate text-[10px] text-muted-foreground">
                          {s.scope}
                        </div>
                      )}
                    </div>
                    <ChordDisplay chord={s.chord} isMac={isMac} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span>
          Total: <span className="font-mono">{SHORTCUT_COUNT}</span> chords
        </span>
        <span>
          Press <span className="kbd">?</span> anywhere to re-open
        </span>
      </div>
    </Dialog>
  );
}

function ChordDisplay({ chord, isMac }: { chord: string; isMac: boolean }) {
  // Render a chord string as kbd-styled pills. Spaces separate keys in a
  // chord sequence (`g d` → two pills). `⌘` renders as "Ctrl" on non-Mac.
  const tokens = chord.trim().split(/\s+/);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {tokens.map((tok, idx) => (
        <span
          key={idx}
          className={cn(
            "kbd",
            // Bump up chord leader visibility slightly vs the secondary key.
            tokens.length > 1 && idx === 0 && "bg-subtle text-foreground",
          )}
        >
          {renderToken(tok, isMac)}
        </span>
      ))}
    </div>
  );
}

function renderToken(tok: string, isMac: boolean): string {
  // Normalize platform-specific meta rendering.
  if (!isMac) {
    return tok.replace(/⌘/g, "Ctrl+");
  }
  return tok;
}
