"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isSlashInput,
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommandContext,
  type SlashCommand,
} from "@/lib/chat-slash-commands";

interface ChatComposerProps {
  onSend: (body: string) => void;
  disabled?: boolean;
  /** True while the send mutation is in-flight — shows a "sending…" hint. */
  isPending?: boolean;
  placeholder?: string;
  /** When provided, shows a contextual banner above the composer. */
  banner?: string;
  /** Slash-command execution context. When provided, enables slash commands. */
  slashContext?: SlashCommandContext;
}

export function ChatComposer({
  onSend,
  disabled = false,
  isPending = false,
  placeholder = "Message agent…",
  banner,
  slashContext,
}: ChatComposerProps) {
  const [body, setBody] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // ---------- Slash-command popover state ----------
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverMatches, setPopoverMatches] = useState<SlashCommand[]>([]);
  const [popoverHighlight, setPopoverHighlight] = useState(0);

  // Auto-resize textarea up to 6 lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [body]);

  // Update popover whenever body changes.
  useEffect(() => {
    if (!slashContext) return;
    // Only show popover for bare "/..." with no space yet.
    if (isSlashInput(body) && !body.includes(" ")) {
      const matches = matchSlashCommands(body);
      setPopoverMatches(matches);
      setPopoverOpen(matches.length > 0);
      setPopoverHighlight(0);
    } else {
      setPopoverOpen(false);
    }
  }, [body, slashContext]);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
    setPopoverMatches([]);
  }, []);

  /** Accept a command from the popover. */
  const acceptCommand = useCallback(
    (cmd: SlashCommand) => {
      closePopover();
      if (cmd.promptDispatch || SLASH_COMMANDS_WITH_ARGS.has(cmd.name)) {
        // Needs args — fill the textarea.
        const filled = `/${cmd.name} `;
        setBody(filled);
        // Place cursor at end after react re-render.
        requestAnimationFrame(() => {
          const ta = taRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(filled.length, filled.length);
        });
      } else {
        // No args — execute immediately.
        if (slashContext) {
          cmd.run("", slashContext);
        }
        setBody("");
      }
    },
    [closePopover, slashContext],
  );

  const submit = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed || disabled) return;

    // Try to intercept as a slash command first.
    if (slashContext && isSlashInput(trimmed)) {
      const parsed = parseSlashCommand(trimmed);
      if (parsed) {
        parsed.command.run(parsed.args, slashContext);
        setBody("");
        closePopover();
        return;
      }
    }

    onSend(trimmed);
    setBody("");
    closePopover();
  }, [body, disabled, slashContext, onSend, closePopover]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Popover keyboard nav.
      if (popoverOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setPopoverHighlight((h) => (h + 1) % popoverMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setPopoverHighlight(
            (h) => (h - 1 + popoverMatches.length) % popoverMatches.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const cmd = popoverMatches[popoverHighlight];
          if (cmd) acceptCommand(cmd);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closePopover();
          return;
        }
      }

      // Normal send: Enter without shift.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [
      popoverOpen,
      popoverMatches,
      popoverHighlight,
      acceptCommand,
      closePopover,
      submit,
    ],
  );

  return (
    <div className="border-t border-border/70">
      {banner && (
        <div className="bg-subtle/60 px-3 py-1.5 text-meta text-muted-foreground">
          {banner}
        </div>
      )}

      {/* Slash-command popover — rendered above the form */}
      {popoverOpen && popoverMatches.length > 0 && (
        <div className="relative mx-2 mb-1">
          <div className="absolute bottom-0 left-0 right-0 z-50 rounded-md border border-border bg-card/95 shadow-md backdrop-blur">
            {popoverMatches.map((cmd, idx) => (
              <button
                key={cmd.name}
                type="button"
                onMouseDown={(e) => {
                  // Use onMouseDown so we fire before textarea blur.
                  e.preventDefault();
                  acceptCommand(cmd);
                }}
                onMouseEnter={() => setPopoverHighlight(idx)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
                  idx === popoverHighlight
                    ? "bg-ember/10 text-foreground"
                    : "text-muted-foreground hover:bg-subtle/40",
                  idx === 0 && "rounded-t-md",
                  idx === popoverMatches.length - 1 && "rounded-b-md",
                )}
              >
                <span className="text-meta font-mono text-foreground">
                  /{cmd.name}
                </span>
                {cmd.aliases && cmd.aliases.length > 0 && (
                  <span className="text-meta font-mono text-muted-foreground/70">
                    ({cmd.aliases.map((a) => `/${a}`).join(", ")})
                  </span>
                )}
                <span className="text-meta ml-auto text-muted-foreground">
                  {cmd.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-1.5 bg-card/80 p-2"
      >
        <textarea
          ref={taRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder}
          className={cn(
            "max-h-[120px] min-h-[28px] flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-[0.75rem] text-foreground placeholder:text-muted-foreground focus:border-ember/50 focus:outline-none",
            disabled && "opacity-50",
          )}
          disabled={disabled}
        />
        <div className="flex flex-col items-center gap-0.5">
          <button
            type="submit"
            disabled={disabled || !body.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-ember/15 text-ember hover:bg-ember/25 disabled:opacity-40"
            title="Send (Enter)"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
          {isPending && (
            <span className="text-meta text-muted-foreground/60">sending…</span>
          )}
        </div>
      </form>
    </div>
  );
}

// Commands that require typed args before executing (so we fill the textarea).
const SLASH_COMMANDS_WITH_ARGS = new Set(["issue"]);
