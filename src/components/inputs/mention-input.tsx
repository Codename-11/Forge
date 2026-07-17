"use client";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Bot } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { parseAgentRequestTokensFromBody } from "@/lib/agent-request-parser";
import { parseLine } from "@/lib/slash-commands";
import type { AgentStatus } from "@prisma/client";

/**
 * `MentionInput` is the shared text-entry primitive for surfaces that
 * accept @-mentions (issue description, comment composer, chat
 * composer). The component owns:
 *
 *   - the underlying <textarea> / <input>
 *   - caret-aware `@` trigger detection
 *   - the floating dropdown of matching agents + workspace members
 *   - keyboard nav (↑/↓/Enter/Tab/Esc)
 *   - insertion of the canonical token `@<key>` (agent profileKey or
 *     user handle) followed by a space
 *
 * The token emitted matches `attachment-renderer.tsx`'s `REF_RE`
 * (lowercased `[a-z0-9][a-z0-9_-]*` after the `@`), so the renderer
 * picks them up as inline `mention` segments. The renderer currently
 * only chips agents (indigo) — human mentions render as plain text,
 * which is fine: they still serve as discoverable @-tags.
 *
 * The component is intentionally NOT a contenteditable rich editor.
 * Body remains a plain string; we just splice tokens into it.
 *
 * Caret positioning uses a tiny "mirror" technique: clone the textarea
 * into a hidden div, copy its styles, place a span at the caret offset,
 * then measure the span's bounding box. ~50 LoC, no deps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MentionInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  /** Render as a <textarea> (default true) vs a single-line <input>. */
  multiline?: boolean;
  /** Textarea row hint. Ignored when `multiline=false`. */
  rows?: number;
  /** Fired on Cmd/Ctrl+Enter. Lets the parent submit without intercepting Enter directly. */
  onSubmit?: () => void;
  /**
   * Fired whenever the @-mention dropdown opens or closes. Lets a
   * parent that ALSO renders a sibling autocomplete (e.g. the issue
   * comment composer's slash picker) keep the two mutually exclusive —
   * suppress the slash picker while the mention list owns the caret.
   */
  onMentionOpenChange?: (open: boolean) => void;
  /**
   * Pass-throughs for parent-owned event handlers. Typed against
   * `HTMLTextAreaElement` (the common case) since paste-upload helpers,
   * slash autocomplete `bind` handlers, etc. all target textareas in
   * practice. When `multiline=false` the events fire on an <input> at
   * runtime — handlers that only read DOM properties shared between the
   * two element types still work; the cast is internal.
   */
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Passthrough caret-tracking handlers (e.g. parent-owned slash autocomplete `bind`). */
  onKeyUp?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onClick?: (event: React.MouseEvent<HTMLTextAreaElement>) => void;
  onSelect?: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onFocus?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
  /** Forwarded to the underlying element. */
  autoFocus?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  /** Optional id for label/htmlFor wiring. */
  id?: string;
  /** Optional render of a slot above/below the input (e.g. an existing slash autocomplete). */
  children?: ReactNode;
  /**
   * Inline token highlighting. When set, a backdrop layer behind the
   * textarea tints `@mentions` (indigo) and/or recognised `/command`
   * lines (ember) live as the operator types — so tokens are visible
   * before submit, the same language as the new-issue overlay's chips.
   * Off by default; the chat composer uses a different command vocabulary
   * so it opts in to mentions only. Only wired for `multiline`.
   */
  highlightMentions?: boolean;
  highlightCommands?: boolean;
}

export interface MentionInputHandle {
  focus: () => void;
  textarea: HTMLTextAreaElement | HTMLInputElement | null;
  /** Replace the current selection with `text`. Used by paste/drop helpers. */
  insertAtCursor: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  function MentionInput(
    {
      value,
      onChange,
      placeholder,
      className,
      multiline = true,
      rows = 4,
      onSubmit,
      onMentionOpenChange,
      onPaste,
      onKeyDown,
      onKeyUp,
      onClick,
      onSelect,
      onFocus,
      autoFocus,
      disabled,
      ariaLabel,
      id,
      children,
      highlightMentions = false,
      highlightCommands = false,
    },
    ref,
  ) {
    const elRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const backdropRef = useRef<HTMLDivElement | null>(null);
    const ws = useMaybeWorkspace();

    // Inline highlighting is only meaningful for the multiline composer
    // (the single-line input doesn't host `/command` lines).
    const highlightOn = multiline && (highlightMentions || highlightCommands);
    const highlightSegments = useMemo(
      () =>
        highlightOn
          ? buildHighlightSegments(value, {
              mentions: highlightMentions,
              commands: highlightCommands,
            })
          : null,
      [highlightOn, value, highlightMentions, highlightCommands],
    );

    // Re-render trigger keyed off cursor moves. We don't track caret in
    // state directly (Textarea owns it); we use `tick` to invalidate the
    // memos that depend on selectionStart.
    const [tick, setTick] = useState(0);
    const [forceClosed, setForceClosed] = useState(false);
    const [active, setActive] = useState(0);
    const [caretRect, setCaretRect] = useState<{ top: number; left: number } | null>(null);

    // ---- Mention trigger detection ----------------------------------------
    const trigger = useMemo(() => {
      const el = elRef.current;
      if (!el) return null;
      const caret = el.selectionStart ?? null;
      if (caret === null) return null;
      return detectMention(value, caret);
      // `tick` participates so a bare arrow-key caret move re-runs the
      // memo even when `value` is stable.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, tick]);

    // ---- Data sources ------------------------------------------------------
    // Mention candidates are picker-only data. Fetch them only after an `@`
    // trigger is active instead of for every closed composer on the page.
    const mentionOpen = Boolean(ws && trigger && !forceClosed);
    const agentsQ = trpc.agent.list.useQuery(
      { includeArchived: false },
      { enabled: mentionOpen, staleTime: 60_000 },
    );
    const membersQ = trpc.workspace.members.useQuery(undefined, {
      enabled: mentionOpen,
      staleTime: 60_000,
    });
    const queriesLoading = agentsQ.isLoading || membersQ.isLoading;

    // ---- Filtered candidates ----------------------------------------------
    const candidates = useMemo(() => {
      const q = (trigger?.token ?? "").toLowerCase();
      const agents = (agentsQ.data ?? []).map((a) => ({
        kind: "agent" as const,
        key: a.profileKey,
        name: a.name,
        avatar: a.avatar ?? null,
        status: (a.status as AgentStatus) ?? "OFFLINE",
        lastHeartbeatAt: a.lastHeartbeatAt ?? null,
        capabilities: a.capabilities ?? [],
        sortKey: rankMatch(q, a.profileKey, a.name, a.capabilities ?? []),
      }));
      const people = (membersQ.data ?? [])
        .filter((m) => m.user.handle)
        .map((m) => ({
          kind: "user" as const,
          key: (m.user.handle ?? "").toLowerCase(),
          name: m.user.name ?? m.user.email ?? m.user.handle ?? "user",
          handle: m.user.handle ?? "",
          image: m.user.image ?? null,
          email: m.user.email,
          sortKey: rankMatch(
            q,
            m.user.handle ?? "",
            m.user.name ?? "",
            m.user.email ? [m.user.email] : [],
          ),
        }));
      const filteredAgents = agents
        .filter((a) => a.sortKey >= 0)
        .sort((a, b) => a.sortKey - b.sortKey || a.name.localeCompare(b.name))
        .slice(0, 5);
      const filteredPeople = people
        .filter((p) => p.sortKey >= 0)
        .sort((a, b) => a.sortKey - b.sortKey || a.name.localeCompare(b.name))
        .slice(0, 5);
      return { agents: filteredAgents, people: filteredPeople };
    }, [agentsQ.data, membersQ.data, trigger?.token]);

    const flatItems = useMemo<FlatItem[]>(() => {
      return [
        ...candidates.agents.map<FlatItem>((a) => ({
          kind: "agent",
          key: a.key,
          insert: a.key,
          item: a,
        })),
        ...candidates.people.map<FlatItem>((p) => ({
          kind: "user",
          key: p.key,
          insert: p.handle.toLowerCase(),
          item: p,
        })),
      ];
    }, [candidates]);

    const visible =
      !!trigger && !forceClosed && !disabled && (flatItems.length > 0 || queriesLoading);

    // Whenever the trigger opens or the candidate list shifts, reset the
    // active index so the first row is selected.
    useEffect(() => {
      setActive(0);
    }, [trigger?.start, flatItems.length]);

    // Notify the parent when the mention dropdown opens / closes so it
    // can suppress a sibling autocomplete (slash picker) — keeps exactly
    // one dropdown active at the caret.
    useEffect(() => {
      onMentionOpenChange?.(visible);
    }, [visible, onMentionOpenChange]);

    // ---- Caret positioning ------------------------------------------------
    useLayoutEffect(() => {
      if (!visible) {
        setCaretRect(null);
        return;
      }
      const el = elRef.current;
      const container = containerRef.current;
      if (!el || !container) return;
      const caret = el.selectionStart ?? 0;
      const measured = measureCaret(el, caret);
      if (!measured) {
        setCaretRect(null);
        return;
      }
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setCaretRect({
        // Position relative to the container so the dropdown lives inside
        // the same stacking context as the input and any other slotted UI.
        top: elRect.top - containerRect.top + measured.top + measured.height + 4,
        left: elRect.left - containerRect.left + measured.left,
      });
    }, [visible, value, tick]);

    // ---- Token insertion --------------------------------------------------
    const insertMention = useCallback(
      (item: FlatItem) => {
        const el = elRef.current;
        if (!el || !trigger) return;
        const replacement = `@${item.insert} `;
        const next = value.slice(0, trigger.start) + replacement + value.slice(trigger.end);
        onChange(next);
        setForceClosed(false);
        // Restore caret immediately after the React commit.
        const pos = trigger.start + replacement.length;
        requestAnimationFrame(() => {
          const e2 = elRef.current;
          if (!e2) return;
          e2.focus();
          try {
            e2.setSelectionRange(pos, pos);
          } catch {
            /* range can throw on a fresh-mounted single-line input; safe to ignore */
          }
          setTick((t) => t + 1);
        });
      },
      [trigger, value, onChange],
    );

    // ---- Keyboard dispatch ------------------------------------------------
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLTextAreaElement> | KeyboardEvent<HTMLInputElement>) => {
        if (visible && flatItems.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((a) => (a + 1) % flatItems.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((a) => (a - 1 + flatItems.length) % flatItems.length);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            // Plain Enter / Tab inserts the mention. Shift+Enter still
            // produces a newline (browser default — we don't preventDefault).
            const pick = flatItems[active];
            if (pick && !event.shiftKey) {
              event.preventDefault();
              insertMention(pick);
              return;
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setForceClosed(true);
            return;
          }
        }
        // Cmd/Ctrl+Enter → submit. Plain Enter is intentionally NOT a
        // submit handler; parents that want that (chat) do their own
        // Enter handling via onKeyDown.
        if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit();
          return;
        }
        // Forward to the parent handler. Cast: see prop type comment —
        // parent handlers always target HTMLTextAreaElement (the common
        // case); when multiline=false they still work because the
        // properties they touch (key, value, selectionStart, etc.) exist
        // on both element types.
        onKeyDown?.(event as KeyboardEvent<HTMLTextAreaElement>);
      },
      [visible, flatItems, active, insertMention, onSubmit, onKeyDown],
    );

    // ---- Selection tracking ----------------------------------------------
    const bump = useCallback(() => setTick((t) => t + 1), []);

    // ---- Highlight backdrop scroll sync -----------------------------------
    // Keep the transparent backdrop scrolled in lockstep with the textarea
    // so token tints stay aligned once the body grows past the visible rows.
    const syncScroll = useCallback(() => {
      const el = elRef.current;
      const bd = backdropRef.current;
      if (!el || !bd) return;
      bd.scrollTop = el.scrollTop;
      bd.scrollLeft = el.scrollLeft;
    }, []);
    useLayoutEffect(() => {
      if (highlightOn) syncScroll();
    }, [highlightOn, value, tick, syncScroll]);

    // ---- Imperative handle for parents -----------------------------------
    useImperativeHandle(
      ref,
      () => ({
        focus: () => elRef.current?.focus(),
        get textarea() {
          return elRef.current;
        },
        insertAtCursor: (text: string) => {
          const el = elRef.current;
          if (!el) {
            onChange(value + text);
            return;
          }
          const start = el.selectionStart ?? value.length;
          const end = el.selectionEnd ?? value.length;
          const next = value.slice(0, start) + text + value.slice(end);
          onChange(next);
          const pos = start + text.length;
          requestAnimationFrame(() => {
            try {
              el.setSelectionRange(pos, pos);
            } catch {
              /* ignore */
            }
            setTick((t) => t + 1);
          });
        },
      }),
      [value, onChange],
    );

    // Shared change/paste/select handlers — assigned after we know the
    // element type so TypeScript narrows correctly. We funnel both
    // textarea/input through one onChange callback that just reads
    // event.currentTarget.value.
    const handleChange = (
      event: ChangeEvent<HTMLTextAreaElement> | ChangeEvent<HTMLInputElement>,
    ) => {
      onChange(event.currentTarget.value);
      setForceClosed(false);
    };

    const handlePaste = (
      event: ClipboardEvent<HTMLTextAreaElement> | ClipboardEvent<HTMLInputElement>,
    ) => {
      onPaste?.(event as ClipboardEvent<HTMLTextAreaElement>);
    };

    const composedKeyUp = (
      e: KeyboardEvent<HTMLTextAreaElement> | KeyboardEvent<HTMLInputElement>,
    ) => {
      bump();
      onKeyUp?.(e as KeyboardEvent<HTMLTextAreaElement>);
    };
    const composedClick = (
      e:
        | React.MouseEvent<HTMLTextAreaElement>
        | React.MouseEvent<HTMLInputElement>,
    ) => {
      bump();
      onClick?.(e as React.MouseEvent<HTMLTextAreaElement>);
    };
    const composedSelect = (
      e:
        | React.SyntheticEvent<HTMLTextAreaElement>
        | React.SyntheticEvent<HTMLInputElement>,
    ) => {
      bump();
      onSelect?.(e as React.SyntheticEvent<HTMLTextAreaElement>);
    };
    const composedFocus = (
      e:
        | React.FocusEvent<HTMLTextAreaElement>
        | React.FocusEvent<HTMLInputElement>,
    ) => {
      bump();
      onFocus?.(e as React.FocusEvent<HTMLTextAreaElement>);
    };

    const ariaControls = visible ? "mention-listbox" : undefined;

    return (
      <div
        ref={containerRef}
        className="relative"
        role="combobox"
        aria-label="Mention autocomplete"
        aria-haspopup="listbox"
        aria-expanded={visible}
        aria-controls={ariaControls}
      >
        {highlightOn && highlightSegments && (
          // Backdrop highlight layer: same box-model as the textarea
          // (identical `className`), text rendered transparent so only the
          // token background tints show — the real, editable text sits on
          // top via the transparent-bg textarea. Scroll is mirrored below.
          <div
            ref={backdropRef}
            aria-hidden
            className={cn(
              className,
              "pointer-events-none absolute inset-0 z-0 select-none overflow-hidden whitespace-pre-wrap break-words text-transparent",
            )}
          >
            {highlightSegments.map((s, i) =>
              s.type === "text" ? (
                <span key={i}>{s.text}</span>
              ) : (
                <span
                  key={i}
                  className={cn(
                    "rounded-[3px]",
                    s.type === "mention"
                      ? "bg-indigo-500/15"
                      : s.type === "agent-mode"
                        ? "bg-success/15"
                        : "bg-ember/15",
                  )}
                >
                  {s.text}
                </span>
              ),
            )}
            {"​"}
          </div>
        )}
        {multiline ? (
          <textarea
            id={id}
            aria-label={ariaLabel}
            aria-autocomplete="list"
            aria-controls={ariaControls}
            ref={(el) => {
              elRef.current = el;
            }}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            rows={rows}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onKeyUp={composedKeyUp}
            onClick={composedClick}
            onSelect={composedSelect}
            onFocus={composedFocus}
            onScroll={highlightOn ? syncScroll : undefined}
            className={cn(className, highlightOn && "relative z-[1] bg-transparent")}
          />
        ) : (
          <input
            id={id}
            aria-label={ariaLabel}
            aria-autocomplete="list"
            aria-controls={ariaControls}
            ref={(el) => {
              elRef.current = el;
            }}
            type="text"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onKeyUp={composedKeyUp}
            onClick={composedClick}
            onSelect={composedSelect}
            onFocus={composedFocus}
            className={className}
          />
        )}
        {children}
        {visible && (
          <MentionDropdown
            anchor={caretRect}
            agents={candidates.agents}
            people={candidates.people}
            loading={queriesLoading && flatItems.length === 0}
            active={active}
            setActive={setActive}
            onPick={insertMention}
            flatItems={flatItems}
          />
        )}
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

interface MentionTrigger {
  /** Index of the `@` in the buffer. */
  start: number;
  /** Caret position (exclusive end of the token). */
  end: number;
  /** The fragment typed after `@` (lowercased). */
  token: string;
}

/**
 * Walk backward from the caret until we hit a non-word character.
 * The character preceding the `@` must be start-of-buffer or whitespace/
 * punctuation — same shape as `attachment-renderer.tsx`'s `REF_RE`, so
 * `email@host` is correctly ignored.
 *
 * Returns `null` when the caret isn't inside an in-progress mention.
 */
export function detectMention(value: string, caret: number): MentionTrigger | null {
  if (caret <= 0) return null;
  let i = caret - 1;
  while (i >= 0 && /[A-Za-z0-9_-]/.test(value[i] ?? "")) i--;
  if (value[i] !== "@") return null;
  const before = i === 0 ? "" : value[i - 1] ?? "";
  if (before && !/[\s(,.;:!?]/.test(before)) return null;
  return { start: i, end: caret, token: value.slice(i + 1, caret).toLowerCase() };
}

// ---------------------------------------------------------------------------
// Inline highlight tokenizer
// ---------------------------------------------------------------------------

type HighlightSegment = {
  text: string;
  type: "text" | "mention" | "command" | "agent-mode";
};

/**
 * Split a composer body into highlight segments for the backdrop layer.
 * A whole line that parses as a recognised slash command becomes one
 * `command` segment; otherwise we reuse the agent-request tokenizer so
 * @mentions and their optional mode marker (`/review`, `execute`, …)
 * light up with the same dynamic boundaries the submit path persists.
 * Newlines are preserved as their own text segments so the backdrop wraps
 * identically to the textarea.
 */
function buildHighlightSegments(
  value: string,
  opts: { mentions: boolean; commands: boolean },
): HighlightSegment[] {
  const out: HighlightSegment[] = [];
  const now = new Date();
  const lines = value.split("\n");
  lines.forEach((line, li) => {
    const trimmed = line.trimStart();
    if (opts.commands && trimmed.startsWith("/") && parseLine(trimmed, now)) {
      out.push({ text: line, type: "command" });
    } else if (opts.mentions && line.includes("@")) {
      appendMentionHighlightSegments(out, line);
    } else {
      out.push({ text: line, type: "text" });
    }
    if (li < lines.length - 1) out.push({ text: "\n", type: "text" });
  });
  return out;
}

function appendMentionHighlightSegments(out: HighlightSegment[], line: string) {
  const tokens = parseAgentRequestTokensFromBody(line);
  if (tokens.length === 0) {
    out.push({ text: line, type: "text" });
    return;
  }

  let last = 0;
  for (const token of tokens) {
    if (token.mentionStart < last) continue;
    if (token.mentionStart > last) {
      out.push({ text: line.slice(last, token.mentionStart), type: "text" });
    }
    out.push({ text: line.slice(token.mentionStart, token.mentionEnd), type: "mention" });
    last = token.mentionEnd;

    if (token.modeStart != null && token.modeEnd != null && token.modeStart >= last) {
      if (token.modeStart > last) {
        out.push({ text: line.slice(last, token.modeStart), type: "text" });
      }
      out.push({ text: line.slice(token.modeStart, token.modeEnd), type: "agent-mode" });
      last = token.modeEnd;
    }
  }
  if (last < line.length) out.push({ text: line.slice(last), type: "text" });
}

// ---------------------------------------------------------------------------
// Match ranking
// ---------------------------------------------------------------------------

/**
 * Lower numbers rank higher. Returns -1 when nothing about the
 * candidate matches the query (caller filters out -1).
 *
 *   0 — empty query → everything matches
 *   1 — key (profileKey / handle) starts with the query
 *   2 — name word starts with the query
 *   3 — capability word starts with the query
 *  -1 — no match
 */
function rankMatch(query: string, key: string, name: string, tags: string[]): number {
  if (!query) return 0;
  const k = key.toLowerCase();
  const n = name.toLowerCase();
  if (k.startsWith(query)) return 1;
  if (n.split(/\s+/).some((p) => p.startsWith(query))) return 2;
  if (tags.some((t) => t.toLowerCase().startsWith(query))) return 3;
  return -1;
}

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

type AgentRow = {
  kind: "agent";
  key: string;
  name: string;
  avatar: string | null;
  status: AgentStatus;
  lastHeartbeatAt: Date | string | null;
  capabilities: string[];
};

type PersonRow = {
  kind: "user";
  key: string;
  name: string;
  handle: string;
  image: string | null;
  email: string;
};

type FlatItem =
  | { kind: "agent"; key: string; insert: string; item: AgentRow }
  | { kind: "user"; key: string; insert: string; item: PersonRow };

function MentionDropdown({
  anchor,
  agents,
  people,
  loading,
  active,
  setActive,
  onPick,
  flatItems,
}: {
  anchor: { top: number; left: number } | null;
  agents: AgentRow[];
  people: PersonRow[];
  loading: boolean;
  active: number;
  setActive: (i: number) => void;
  onPick: (item: FlatItem) => void;
  flatItems: FlatItem[];
}) {
  const style: CSSProperties = anchor
    ? { top: anchor.top, left: anchor.left }
    : { top: "100%", left: 0, marginTop: 4 };

  return (
    <div
      role="listbox"
      id="mention-listbox"
      aria-label="Mention suggestions"
      style={style}
      className={cn(
        "absolute z-40 min-w-[15rem] max-w-[22rem] overflow-hidden rounded-md border border-border",
        "bg-popover text-popover-foreground shadow-lg",
      )}
    >
      {loading ? (
        <div className="px-2.5 py-2 text-meta text-muted-foreground">Loading…</div>
      ) : flatItems.length === 0 ? (
        <div className="px-2.5 py-2 text-meta text-muted-foreground">No matches</div>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {agents.length > 0 && (
            <li
              aria-hidden
              className="px-2.5 pb-0.5 pt-1 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70"
            >
              Agents
            </li>
          )}
          {agents.map((a, idx) => {
            const flatIdx = idx;
            const selected = flatIdx === active;
            return (
              <li key={`agent-${a.key}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(flatItems[flatIdx])}
                  onMouseEnter={() => setActive(flatIdx)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                    selected ? "bg-subtle text-foreground" : "text-foreground/85 hover:bg-subtle/60",
                  )}
                >
                  <span className="relative inline-flex shrink-0 items-center">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md border border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
                      <Bot className="h-3 w-3" />
                    </span>
                    <span className="absolute -bottom-0.5 -right-0.5">
                      <AgentPresenceDot
                        status={a.status}
                        lastHeartbeatAt={a.lastHeartbeatAt}
                        size="sm"
                      />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{a.name}</span>
                      <span className="text-id text-muted-foreground">@{a.key}</span>
                    </span>
                    {a.capabilities.length > 0 && (
                      <span className="mt-0.5 block truncate text-meta text-muted-foreground">
                        {a.capabilities.slice(0, 4).join(" · ")}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {people.length > 0 && (
            <li
              aria-hidden
              className="px-2.5 pb-0.5 pt-1 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70"
            >
              People
            </li>
          )}
          {people.map((p, idx) => {
            const flatIdx = agents.length + idx;
            const selected = flatIdx === active;
            return (
              <li key={`user-${p.key}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(flatItems[flatIdx])}
                  onMouseEnter={() => setActive(flatIdx)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                    selected ? "bg-subtle text-foreground" : "text-foreground/85 hover:bg-subtle/60",
                  )}
                >
                  <Avatar name={p.name} image={p.image} size={20} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="text-id text-muted-foreground">@{p.handle}</span>
                    </span>
                    {p.email && (
                      <span className="mt-0.5 block truncate text-meta text-muted-foreground">
                        {p.email}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Caret measurement (mirror technique)
// ---------------------------------------------------------------------------

/**
 * Measure the on-screen position of the caret inside a textarea / input.
 * Returns the offset (in pixels) of the caret relative to the input
 * itself: `{ top, left, height }`. Returns `null` if measurement fails
 * (e.g. SSR or detached node).
 *
 * Technique: create a hidden mirror div with the same typography +
 * box-model as the input, write everything before the caret into it,
 * then anchor a 0-width span at the cursor position and read its
 * bounding rect.
 *
 * The mirror is created once per call and removed immediately —
 * negligible cost (no observable layout thrash in practice).
 */
function measureCaret(
  el: HTMLTextAreaElement | HTMLInputElement,
  caret: number,
): { top: number; left: number; height: number } | null {
  if (typeof window === "undefined") return null;
  const isInput = el.tagName === "INPUT";
  const cs = window.getComputedStyle(el);

  const mirror = document.createElement("div");
  const style = mirror.style;
  // Copy the style properties that affect text wrapping + box-model.
  const props = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderStyle",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontSizeAdjust",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "letterSpacing",
    "wordSpacing",
    "tabSize",
  ] as const;
  for (const p of props) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (style as any)[p] = (cs as any)[p];
  }
  style.position = "absolute";
  style.visibility = "hidden";
  style.whiteSpace = isInput ? "nowrap" : "pre-wrap";
  style.wordWrap = isInput ? "normal" : "break-word";
  style.top = "0";
  style.left = "-9999px";

  const before = el.value.slice(0, caret).replace(/\n$/, "\n​");
  mirror.textContent = before;

  const marker = document.createElement("span");
  marker.textContent = "​"; // zero-width space anchors the caret
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  try {
    // Account for the scroll offset of the textarea so the mirror's
    // local coordinates map cleanly back onto the input.
    const top = marker.offsetTop - el.scrollTop;
    const left = marker.offsetLeft - el.scrollLeft;
    const height = parseInt(cs.lineHeight, 10) || el.clientHeight;
    return { top, left, height };
  } catch {
    return null;
  } finally {
    document.body.removeChild(mirror);
  }
}
