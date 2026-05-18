"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { FileText, Image as ImageIcon, Loader2, Paperclip, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropOverlay } from "@/components/attachments/drop-overlay";
import {
  isSlashInput,
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommandContext,
  type SlashCommand,
} from "@/lib/chat-slash-commands";

export interface ChatComposerAttachmentDraft {
  id: string;
  file: File;
  status: "pending" | "uploading" | "error";
  error?: string;
}

interface ChatComposerProps {
  onSend: (body: string, files: File[]) => Promise<void> | void;
  disabled?: boolean;
  /** True while the send mutation is in-flight — shows a "sending…" hint. */
  isPending?: boolean;
  placeholder?: string;
  /** When provided, shows a contextual banner above the composer. */
  banner?: string;
  /** Slash-command execution context. When provided, enables slash commands. */
  slashContext?: SlashCommandContext;
}

function fileIcon(file: File) {
  return file.type.startsWith("image/") ? ImageIcon : FileText;
}

function prettyBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function filesFromList(list: FileList | null | undefined): File[] {
  return list ? Array.from(list).filter((f) => f.size > 0) : [];
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
  const [attachments, setAttachments] = useState<ChatComposerAttachmentDraft[]>([]);
  const [isOver, setIsOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
    if (isSlashInput(body) && !body.includes(" ") && attachments.length === 0) {
      const matches = matchSlashCommands(body);
      setPopoverMatches(matches);
      setPopoverOpen(matches.length > 0);
      setPopoverHighlight(0);
    } else {
      setPopoverOpen(false);
    }
  }, [body, slashContext, attachments.length]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setAttachments((prev) => [
      ...prev,
      ...files.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        file,
        status: "pending" as const,
      })),
    ]);
  }, []);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
    setPopoverMatches([]);
  }, []);

  /** Accept a command from the popover. */
  const acceptCommand = useCallback(
    (cmd: SlashCommand) => {
      closePopover();
      if (cmd.promptDispatch || SLASH_COMMANDS_WITH_ARGS.has(cmd.name)) {
        const filled = `/${cmd.name} `;
        setBody(filled);
        requestAnimationFrame(() => {
          const ta = taRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(filled.length, filled.length);
        });
      } else {
        if (slashContext) {
          cmd.run("", slashContext);
        }
        setBody("");
      }
    },
    [closePopover, slashContext],
  );

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    const files = attachments.map((a) => a.file);
    if ((!trimmed && files.length === 0) || disabled) return;

    // Try to intercept as a slash command first when no files are attached.
    if (files.length === 0 && slashContext && isSlashInput(trimmed)) {
      const parsed = parseSlashCommand(trimmed);
      if (parsed) {
        parsed.command.run(parsed.args, slashContext);
        setBody("");
        closePopover();
        return;
      }
    }

    setAttachments((prev) => prev.map((a) => ({ ...a, status: "uploading" })));
    try {
      await onSend(trimmed, files);
      setBody("");
      setAttachments([]);
      closePopover();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setAttachments((prev) => prev.map((a) => ({ ...a, status: "error", error: message })));
    }
  }, [body, attachments, disabled, slashContext, onSend, closePopover]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (popoverOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setPopoverHighlight((h) => (h + 1) % popoverMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setPopoverHighlight((h) => (h - 1 + popoverMatches.length) % popoverMatches.length);
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

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [popoverOpen, popoverMatches, popoverHighlight, acceptCommand, closePopover, submit],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = filesFromList(e.clipboardData.files);
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsOver(false);
      addFiles(filesFromList(e.dataTransfer.files));
    },
    [addFiles],
  );

  const busy = disabled || isPending;

  return (
    <div
      className="relative border-t border-border/70"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setIsOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsOver(false);
      }}
      onDrop={handleDrop}
      data-testid="chat-composer"
    >
      <DropOverlay active={isOver} label="Drop files into chat" />
      {banner && (
        <div className="bg-subtle/60 px-3 py-1.5 text-meta text-muted-foreground">
          {banner}
        </div>
      )}

      {popoverOpen && popoverMatches.length > 0 && (
        <div className="relative mx-2 mb-1">
          <div className="absolute bottom-0 left-0 right-0 z-50 rounded-md border border-border bg-card/95 shadow-md backdrop-blur">
            {popoverMatches.map((cmd, idx) => (
              <button
                key={cmd.name}
                type="button"
                onMouseDown={(e) => {
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
                <span className="text-meta font-mono text-foreground">/{cmd.name}</span>
                {cmd.aliases && cmd.aliases.length > 0 && (
                  <span className="text-meta font-mono text-muted-foreground/70">
                    ({cmd.aliases.map((a) => `/${a}`).join(", ")})
                  </span>
                )}
                <span className="text-meta ml-auto text-muted-foreground">{cmd.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2" data-testid="chat-attachment-drafts">
          {attachments.map((draft) => {
            const Icon = fileIcon(draft.file);
            return (
              <span
                key={draft.id}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card/60 px-1.5 py-1 text-meta",
                  draft.status === "error" && "border-red-500/40 bg-red-500/10",
                )}
                title={draft.error ?? draft.file.name}
              >
                {draft.status === "uploading" ? (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                ) : (
                  <Icon className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="max-w-[11rem] truncate font-mono text-foreground/90">{draft.file.name || "attachment"}</span>
                <span className="text-muted-foreground">{prettyBytes(draft.file.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${draft.file.name || "attachment"}`}
                  onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== draft.id))}
                  disabled={busy}
                  className="rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-2 p-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(filesFromList(e.currentTarget.files));
            e.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Attach files"
          className="mb-0.5 rounded-md p-1.5 text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <textarea
          ref={taRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={busy}
          rows={1}
          className="min-h-[2rem] flex-1 resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[0.75rem] outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ember/50 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || (!body.trim() && attachments.length === 0)}
          className={cn(
            "mb-0.5 rounded-md p-1.5 transition-colors",
            body.trim() || attachments.length > 0
              ? "bg-ember text-white hover:bg-ember/90"
              : "bg-subtle text-muted-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={isPending ? "Sending…" : "Send"}
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </div>
      {isPending && (
        <div className="px-3 pb-1.5 text-meta text-muted-foreground">sending…</div>
      )}
    </div>
  );
}

const SLASH_COMMANDS_WITH_ARGS = new Set(["assign", "status", "comment", "transition"]);
