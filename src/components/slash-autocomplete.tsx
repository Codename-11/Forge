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
import {
  AgentAvatar,
  type AgentAvatarIdentity,
} from "@/components/agents/agent-avatar";

/**
 * Slash-command autocomplete dropdown for issue / comment composers.
 *
 * Two stages:
 *  - KEYWORD: the caret line is `/pro` (no space yet) → suggest command
 *    keywords (`/project`, `/assign`, …) and, when `includeTemplates`,
 *    templates. Picking inserts the `/keyword ` stub (or expands a
 *    template).
 *  - VALUE: the line is `/project for` (keyword + space) and live
 *    `attributes` data was supplied → suggest real projects / agents /
 *    labels (plus priority levels and due presets, which need no data).
 *    Picking rewrites the line to `/project FRG ` so the command parses
 *    on submit. Without `attributes` the value stage is inert, so the
 *    hook degrades to keyword-only completion.
 *
 * Anchored under a single textarea (or single-line input) by sitting
 * inside a `relative` wrapper element supplied by the caller. The
 * dropdown is OPEN whenever the cursor's current line starts with `/`
 * (after optional leading whitespace) and isn't inside a fenced code
 * block.
 *
 * Mutual exclusion: the caller passes `suppressed` (true while the
 * sibling @-mention dropdown owns the caret). When suppressed the slash
 * picker stays closed and its `onKeyDown` is a no-op, so exactly one
 * dropdown is ever active and only it owns Arrow/Enter/Tab/Esc.
 *
 * Keyboard:
 *   ↓ / ↑       — move active selection
 *   Enter / Tab — insert the active suggestion
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

// Live data the value stage matches against. All optional — omit one and
// that command simply yields no value suggestions.
export interface SlashAttributeData {
  projects?: { id: string; name: string; key: string; color?: string | null }[];
  agents?: {
    name: string | null;
    profileKey: string | null;
    avatar: string | null;
  }[];
  labels?: { name: string; color: string }[];
}

// A single dropdown row — either a command/template keyword, or a
// resolved attribute value.
export type SlashSuggestion =
  | { kind: "command"; keyword: string; example: string }
  | {
      kind: "value";
      /** Text spliced after `/keyword ` (e.g. `FRG`, `@victor`, `high`). */
      insert: string;
      label: string;
      secondary?: string;
      color?: string | null;
      avatar?: AgentAvatarIdentity;
    };

const VALUE_COMMANDS = new Set([
  "assign",
  "project",
  "label",
  "priority",
  "p",
  "due",
]);

const PRIORITY_LEVELS: ReadonlyArray<{ label: string; insert: string }> = [
  { label: "Urgent", insert: "urgent" },
  { label: "High", insert: "high" },
  { label: "Medium", insert: "medium" },
  { label: "Low", insert: "low" },
];

// Presets use expressions `parseDateExpression` (slash-commands.ts) accepts.
const DUE_PRESETS: ReadonlyArray<{ label: string; insert: string }> = [
  { label: "Today", insert: "today" },
  { label: "Tomorrow", insert: "tomorrow" },
  { label: "In 3 days", insert: "in 3 days" },
  { label: "In 1 week", insert: "in 1 week" },
];

function valueSuggestions(
  keyword: string,
  arg: string,
  attributes: SlashAttributeData | undefined,
): SlashSuggestion[] {
  if (!VALUE_COMMANDS.has(keyword)) return [];
  const q = arg.trim().toLowerCase();
  switch (keyword) {
    case "project":
      return (attributes?.projects ?? [])
        .filter(
          (p) =>
            !q ||
            p.name.toLowerCase().includes(q) ||
            p.key.toLowerCase().includes(q),
        )
        .slice(0, 8)
        .map((p) => ({
          kind: "value" as const,
          insert: p.key,
          label: p.name,
          secondary: p.key,
          color: p.color ?? null,
        }));
    case "assign":
      return (attributes?.agents ?? [])
        .filter(
          (a) =>
            !q ||
            a.name?.toLowerCase().includes(q) ||
            a.profileKey?.toLowerCase().includes(q),
        )
        .slice(0, 8)
        .map((a) => ({
          kind: "value" as const,
          insert: `@${a.profileKey ?? ""}`,
          label: a.name ?? a.profileKey ?? "agent",
          secondary: a.profileKey ? `@${a.profileKey}` : undefined,
          avatar: a,
        }));
    case "label":
      return (attributes?.labels ?? [])
        .filter((l) => !q || l.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((l) => ({
          kind: "value" as const,
          insert: l.name,
          label: l.name,
          color: l.color,
        }));
    case "priority":
    case "p":
      return PRIORITY_LEVELS.filter(
        (p) => !q || p.insert.startsWith(q),
      ).map((p) => ({ kind: "value" as const, insert: p.insert, label: p.label }));
    case "due":
      return DUE_PRESETS.filter(
        (d) => !q || d.label.toLowerCase().includes(q),
      ).map((d) => ({ kind: "value" as const, insert: d.insert, label: d.label }));
    default:
      return [];
  }
}

interface DropdownProps {
  matches: ReadonlyArray<SlashSuggestion>;
  active: number;
  setActive: (i: number) => void;
  onPick: (index: number) => void;
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
            <li key={suggestionKey(m)}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => {
                  // Prevent the textarea blur that would otherwise
                  // close the dropdown before onClick fires.
                  e.preventDefault();
                }}
                onClick={() => onPick(i)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                  selected
                    ? "bg-subtle text-foreground"
                    : "text-muted-foreground hover:bg-subtle/70",
                )}
              >
                <SuggestionRow suggestion={m} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function suggestionKey(s: SlashSuggestion): string {
  return s.kind === "command" ? `c:${s.keyword}` : `v:${s.insert}:${s.label}`;
}

function SuggestionRow({ suggestion: s }: { suggestion: SlashSuggestion }) {
  if (s.kind === "command") {
    return (
      <>
        <span className="font-mono text-foreground">{s.keyword}</span>
        <span className="ml-auto truncate text-meta text-muted-foreground">
          {s.example}
        </span>
      </>
    );
  }
  return (
    <>
      {s.avatar ? (
        <AgentAvatar agent={s.avatar} size="xs" title={null} />
      ) : s.color !== undefined ? (
        <span
          className="h-2 w-2 shrink-0 rounded-sm"
          style={{ backgroundColor: s.color ?? "transparent" }}
          aria-hidden
        />
      ) : null}
      <span className="flex-1 truncate text-foreground">{s.label}</span>
      {s.secondary && (
        <span className="text-id ml-auto font-mono text-muted-foreground">
          {s.secondary}
        </span>
      )}
    </>
  );
}

/**
 * Hook: wires up cursor tracking, line resolution, stage detection,
 * filtering, keyboard navigation, and insertion splice.
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
   */
  includeTemplates?: boolean;
  /**
   * Live data for the VALUE stage. Supply projects / agents / labels so
   * `/project`, `/assign`, `/label` autocomplete against real entities.
   * Omit to keep keyword-only completion.
   */
  attributes?: SlashAttributeData;
  /**
   * Fired when the operator picks a template that carries a non-`none`
   * side-effect. The composer dispatches the follow-up mutation.
   */
  onTemplateSideEffect?: (sideEffect: SlashTemplateSideEffect) => void;
  /**
   * When true the slash picker is force-closed and its keyboard handler
   * is a no-op (sibling @-mention list owns the caret).
   */
  suppressed?: boolean;
}) {
  const {
    value,
    onChange,
    textareaRef,
    includeTemplates = false,
    attributes,
    onTemplateSideEffect,
    suppressed = false,
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

  // Don't trigger inside a fenced code block — a `/` there is code, not
  // a command.
  const inFencedBlock = useMemo(() => {
    if (!lineCtx) return false;
    const linesBefore = value.slice(0, lineCtx.lineStart).split("\n");
    let fences = 0;
    for (const l of linesBefore) {
      if (l.trim().startsWith("```")) fences += 1;
    }
    return fences % 2 === 1;
  }, [value, lineCtx]);

  // Which stage the caret line is in: keyword (`/pro`) or value
  // (`/project for`). Null when the line isn't a slash command.
  const lineInfo = useMemo(() => {
    if (!lineCtx) return null;
    const trimmed = lineCtx.line.trimStart();
    if (!trimmed.startsWith("/")) return null;
    const withSpace = trimmed.match(/^\/(\w*)\s+([\s\S]*)$/);
    if (withSpace) {
      return {
        stage: "value" as const,
        keyword: withSpace[1].toLowerCase(),
        arg: withSpace[2],
      };
    }
    return { stage: "keyword" as const, keyword: trimmed.slice(1).toLowerCase() };
  }, [lineCtx]);

  // Filter the candidate list for the current stage.
  const matches = useMemo<SlashSuggestion[]>(() => {
    if (!lineInfo || inFencedBlock) return [];
    if (lineInfo.stage === "keyword") {
      const q = lineInfo.keyword;
      const pool = includeTemplates
        ? [...SLASH_COMMAND_HELP, ...SLASH_TEMPLATE_HELP]
        : [...SLASH_COMMAND_HELP];
      const filtered =
        q.length === 0
          ? pool
          : pool.filter((c) => c.keyword.slice(1).toLowerCase().startsWith(q));
      return filtered.map((c) => ({
        kind: "command" as const,
        keyword: c.keyword,
        example: c.example,
      }));
    }
    return valueSuggestions(lineInfo.keyword, lineInfo.arg, attributes);
  }, [lineInfo, inFencedBlock, includeTemplates, attributes]);

  // Reset the active selection when the candidate list shifts.
  useEffect(() => {
    setActive(0);
  }, [matches.length]);

  const visible =
    !suppressed &&
    !forceClosed &&
    !!lineCtx &&
    !inFencedBlock &&
    !!lineInfo &&
    matches.length > 0;

  // Cursor-recording hook for the textarea.
  const recordCursor = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    setCursor(el.selectionStart ?? null);
    setForceClosed(false);
  }, [textareaRef]);

  // Insert a command stub OR expand a template by replacing the current
  // line. (Value picks are handled in `applySuggestion`.)
  const insertCommand = useCallback(
    (keyword: string) => {
      if (!lineCtx) return;
      const template = includeTemplates ? findTemplate(keyword) : null;
      if (template) {
        const typedArgs = lineCtx.line.trimStart().slice(keyword.length).trim();
        const expansion = template.expand(typedArgs);
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

  // Apply a chosen suggestion. Value picks rewrite the line to
  // `/keyword <insert> ` so the command parses on submit; command picks
  // delegate to the stub/template path above.
  const applySuggestion = useCallback(
    (s: SlashSuggestion) => {
      if (!lineCtx) return;
      if (s.kind === "command") {
        insertCommand(s.keyword);
        return;
      }
      const keyword = lineInfo?.stage === "value" ? lineInfo.keyword : "";
      const newLine = `/${keyword} ${s.insert} `;
      const next =
        value.slice(0, lineCtx.lineStart) + newLine + value.slice(lineCtx.lineEnd);
      onChange(next);
      const newCursor = lineCtx.lineStart + newLine.length;
      setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(newCursor, newCursor);
        setCursor(newCursor);
      }, 0);
    },
    [lineCtx, lineInfo, value, onChange, textareaRef, insertCommand],
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
        if (pick) applySuggestion(pick);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setForceClosed(true);
        return true;
      }
      return false;
    },
    [visible, matches, active, applySuggestion],
  );

  // Force-close (e.g. from the parent on submit).
  const close = useCallback(() => setForceClosed(true), []);

  // Track the input on `keyup`, `click`, `select`, `focus`.
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
    onPick: (index: number) => {
      const s = matches[index];
      if (s) applySuggestion(s);
    },
  };

  return {
    onKeyDown,
    bind,
    dropdownProps,
    visible,
    close,
  };
}
