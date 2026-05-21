"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { SLASH_COMMAND_HELP } from "@/lib/slash-commands";
import {
  findTemplate,
  SLASH_TEMPLATE_HELP,
  type SlashTemplateSideEffect,
} from "@/lib/slash-templates";

/**
 * Slash-command autocomplete dropdown for issue / comment composers.
 *
 * Anchored under a single textarea (or single-line input) by sitting
 * inside a `relative` wrapper element supplied by the caller. The
 * dropdown is OPEN whenever the cursor's current line starts with `/`
 * AND the line lives in the top-of-body slash-command block — i.e.
 * line 0, or any line where every preceding non-blank line is also a
 * slash-prefixed line. (We approximate "recognised" cheaply: any line
 * starting with `/` counts. The parser still rejects unknown forms
 * server-side, so an over-eager open here is harmless.)
 *
 * Keyboard:
 *   ↓ / ↑       — move active selection
 *   Enter / Tab — insert the active command's stub (e.g. `/assign `)
 *   Escape      — dismiss without inserting
 *
 * Click also inserts. The hook owns all state and exposes:
 *   - `bind`: spread onto the textarea (cursor tracking)
 *   - `onKeyDown`: call from the textarea's onKeyDown BEFORE your own
 *     logic. Returns `true` when the event was consumed by the
 *     dropdown — caller should bail (skip submit, skip parent shortcut).
 *   - `<SlashAutocomplete {...dropdownProps} />`: render the dropdown.
 *
 * Pure CSS / Tailwind. No portal, no Radix dep.
 */

interface DropdownProps {
  matches: ReadonlyArray<{ keyword: string; example: string }>;
  active: number;
  setActive: (i: number) => void;
  onPick: (keyword: string) => void;
  className?: string;
}

export function SlashAutocomplete({
  matches,
  active,
  setActive,
  onPick,
  className,
}: DropdownProps) {
  if (matches.length === 0) return null;
  return (
    <div
      className={cn(
        "absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover shadow-md",
        className,
      )}
      role="listbox"
      aria-label="Slash command suggestions"
    >
      <ul className="py-1">
        {matches.map((m, i) => {
          const selected = i === active;
          return (
            <li key={m.keyword}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => {
                  // Prevent the textarea blur that would otherwise
                  // close the dropdown before onClick fires.
                  e.preventDefault();
                }}
                onClick={() => onPick(m.keyword)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs",
                  selected
                    ? "bg-subtle text-foreground"
                    : "text-muted-foreground hover:bg-subtle/70",
                )}
              >
                <span className="font-mono text-foreground">{m.keyword}</span>
                <span className="ml-auto truncate text-meta text-muted-foreground">
                  {m.example}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Hook: wires up cursor tracking, line resolution, top-of-body block
 * detection, filtering, keyboard navigation, and insertion splice.
 *
 * Splicing on insert: replaces the cursor's current LINE with the
 * stub (e.g. "/a" → "/assign "). Cursor lands at the end of the
 * inserted stub.
 */
export function useSlashAutocomplete<
  T extends HTMLTextAreaElement | HTMLInputElement,
>(args: {
  value: string;
  onChange: (next: string) => void;
  textareaRef: RefObject<T | null>;
  /**
   * When true, the autocomplete also surfaces TEMPLATES from
   * `slash-templates.ts` (`/status`, `/blocked`, `/approve`,
   * `/handoff`). Picking a template REPLACES the line with the
   * expanded body and (optionally) fires `onTemplateSideEffect`.
   * Defaults to `false` — QuickCreate (where the body becomes the
   * issue title) is unaffected.
   */
  includeTemplates?: boolean;
  /**
   * Fired when the operator picks a template that carries a non-`none`
   * side-effect. The composer is responsible for dispatching the
   * follow-up mutation (e.g. opening an action-request for `/blocked`).
   */
  onTemplateSideEffect?: (sideEffect: SlashTemplateSideEffect) => void;
}) {
  const {
    value,
    onChange,
    textareaRef,
    includeTemplates = false,
    onTemplateSideEffect,
  } = args;
  const [cursor, setCursor] = useState<number | null>(null);
  const [forceClosed, setForceClosed] = useState(false);
  const [active, setActive] = useState(0);

  // Resolve the cursor's current line.
  const lineCtx = useMemo(() => {
    if (cursor === null) return null;
    const before = value.slice(0, cursor);
    const lineStart = before.lastIndexOf("\n") + 1;
    const afterIdx = value.indexOf("\n", cursor);
    const lineEnd = afterIdx === -1 ? value.length : afterIdx;
    const line = value.slice(lineStart, lineEnd);
    return { line, lineStart, lineEnd };
  }, [value, cursor]);

  // Top-of-body block: every preceding non-blank line must also start
  // with `/`.
  const inTopOfBodyBlock = useMemo(() => {
    if (!lineCtx) return false;
    const lines = value.slice(0, lineCtx.lineStart).split("\n");
    for (const l of lines) {
      const t = l.trim();
      if (t === "") continue;
      if (!t.startsWith("/")) return false;
    }
    return true;
  }, [value, lineCtx]);

  // Filter the help list against the typed text after `/`. Templates
  // are appended after the structured commands so the seven
  // "set a field" commands stay first; templates layer on as quick
  // comment expanders when the caller opts in.
  const matches = useMemo(() => {
    if (!lineCtx) return [];
    const trimmed = lineCtx.line.trimStart();
    if (!trimmed.startsWith("/")) return [];
    const keywordOnly = trimmed.split(/\s+/, 1)[0]; // includes leading "/"
    const q = keywordOnly.slice(1).toLowerCase();
    const pool = includeTemplates
      ? [...SLASH_COMMAND_HELP, ...SLASH_TEMPLATE_HELP]
      : [...SLASH_COMMAND_HELP];
    if (q.length === 0) return pool;
    return pool.filter((c) =>
      c.keyword.slice(1).toLowerCase().startsWith(q),
    );
  }, [lineCtx, includeTemplates]);

  // Reset the active selection when the candidate list shifts.
  useEffect(() => {
    setActive(0);
  }, [matches.length]);

  const visible =
    !forceClosed &&
    !!lineCtx &&
    inTopOfBodyBlock &&
    lineCtx.line.trimStart().startsWith("/") &&
    matches.length > 0;

  // Cursor-recording hook for the textarea.
  const recordCursor = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    setCursor(el.selectionStart ?? null);
    setForceClosed(false);
  }, [textareaRef]);

  // Insert the stub OR expand a template by replacing the current
  // line. Commands (`/assign`, `/due`, …) get the cheap stub treatment
  // — `${keyword} ` spliced in for the operator to type the arg.
  // Templates (`/status`, `/blocked`, `/approve`, `/handoff`) expand
  // to their full body when their args are satisfied; otherwise fall
  // through to the stub so the operator can keep typing in-place.
  const insert = useCallback(
    (keyword: string) => {
      if (!lineCtx) return;
      const template = includeTemplates ? findTemplate(keyword) : null;
      if (template) {
        const typedArgs = lineCtx.line.trimStart().slice(keyword.length).trim();
        const expansion = template.expand(typedArgs);
        // `/handoff` without an `@handle` returns null — fall through
        // to the stub so the autocomplete stays open while the user
        // types the agent.
        if (expansion && !(template.args === "agent" && typedArgs.length === 0)) {
          const next =
            value.slice(0, lineCtx.lineStart) +
            expansion.body +
            value.slice(lineCtx.lineEnd);
          onChange(next);
          const newCursor = lineCtx.lineStart + expansion.caretOffset;
          if (expansion.sideEffect.kind !== "none") {
            onTemplateSideEffect?.(expansion.sideEffect);
          }
          setTimeout(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(newCursor, newCursor);
            setCursor(newCursor);
          }, 0);
          return;
        }
      }

      const stub = `${keyword} `;
      const next =
        value.slice(0, lineCtx.lineStart) + stub + value.slice(lineCtx.lineEnd);
      onChange(next);
      const newCursor = lineCtx.lineStart + stub.length;
      // Restore focus + caret on the next tick so React commits first.
      setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(newCursor, newCursor);
        setCursor(newCursor);
      }, 0);
    },
    [
      lineCtx,
      value,
      onChange,
      textareaRef,
      includeTemplates,
      onTemplateSideEffect,
    ],
  );

  // The keyboard dispatcher caller invokes from their own onKeyDown.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!visible) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = matches[active];
        if (pick) insert(pick.keyword);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setForceClosed(true);
        return true;
      }
      return false;
    },
    [visible, matches, active, insert],
  );

  // Force-close (e.g. from the parent on submit).
  const close = useCallback(() => setForceClosed(true), []);

  // We track the input on `keyup`, `click`, and `select` so caret moves
  // via arrow keys / mouse all flip the dropdown. We avoid `blur` —
  // mousedown on dropdown items is preventDefaulted, so clicking
  // doesn't blur, and we still want the dropdown alive.
  const bind = {
    onKeyUp: recordCursor,
    onClick: recordCursor,
    onSelect: recordCursor,
    onFocus: recordCursor,
  };

  const dropdownProps: DropdownProps = {
    matches: visible ? matches : [],
    active,
    setActive,
    onPick: (keyword: string) => insert(keyword),
  };

  return {
    onKeyDown,
    bind,
    dropdownProps,
    visible,
    close,
  };
}
