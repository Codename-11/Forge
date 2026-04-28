"use client";
import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatComposerProps {
  onSend: (body: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** When provided, shows a contextual banner above the composer. */
  banner?: string;
}

export function ChatComposer({
  onSend,
  disabled = false,
  placeholder = "Message agent…",
  banner,
}: ChatComposerProps) {
  const [body, setBody] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize textarea up to 6 lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [body]);

  const submit = () => {
    const trimmed = body.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setBody("");
  };

  return (
    <div className="border-t border-border/70">
      {banner && (
        <div className="bg-subtle/60 px-3 py-1.5 text-meta text-muted-foreground">
          {banner}
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
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter or plain Enter (without shift) sends.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className={cn(
            "max-h-[120px] min-h-[28px] flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-[0.75rem] text-foreground placeholder:text-muted-foreground focus:border-ember/50 focus:outline-none",
            disabled && "opacity-50",
          )}
          disabled={disabled}
        />
        <button
          type="submit"
          disabled={disabled || !body.trim()}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-ember/15 text-ember hover:bg-ember/25 disabled:opacity-40"
          title="Send (Enter)"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}
