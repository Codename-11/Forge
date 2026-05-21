"use client";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { DropOverlay } from "@/components/attachments/drop-overlay";
import {
  isSlashInput,
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommandContext,
  type SlashCommand,
} from "@/lib/chat-slash-commands";
import type { AgentStatus } from "@prisma/client";

export interface ChatComposerAttachmentDraft {
  id: string;
  file: File;
  status: "pending" | "uploading" | "error";
  error?: string;
  includeInContext: boolean;
}

export interface MentionableAgent {
  profileKey: string;
  name: string;
  /** Optional presence — when supplied the popover shows the presence dot. */
  status?: AgentStatus;
  avatar?: string | null;
  lastHeartbeatAt?: Date | string | null;
}

export interface MentionablePerson {
  /** User handle (the canonical `@<handle>` token). */
  handle: string;
  name: string;
  image?: string | null;
  email?: string | null;
}

type MentionItem =
  | { kind: "agent"; agent: MentionableAgent }
  | { kind: "user"; person: MentionablePerson };

function mentionInsertKey(item: MentionItem): string {
  return item.kind === "agent" ? item.agent.profileKey : item.person.handle;
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
  /** Human-readable summary of route/entity context that will be attached to the dispatch payload. */
  contextSummary?: string[];
  /** Auto-focus the textarea on mount (used when Chat tab becomes active). */
  autoFocus?: boolean;
  /** Thread id — drafts are persisted to localStorage keyed by this id. */
  threadId?: string;
  /** Agent profileKeys available for @-mention autocomplete. */
  mentionableAgents?: MentionableAgent[];
  /** Workspace members available for @-mention autocomplete. */
  mentionablePeople?: MentionablePerson[];
  /** When the parent wants to fill the composer (e.g. from a suggestion chip), it bumps `fillRequest`. */
  fillRequest?: { body: string; nonce: number };
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

function draftStorageKey(threadId: string): string {
  return `forge.chat.draft.${threadId}`;
}

/**
 * Find the in-progress `@token` at the current caret. Returns `null`
 * unless the caret sits at the end of a `@token` that begins at the
 * start of the buffer or after whitespace. `token` excludes the `@`.
 */
function detectMentionToken(
  body: string,
  caret: number,
): { token: string; start: number } | null {
  if (caret <= 0) return null;
  let i = caret - 1;
  while (i >= 0 && /[A-Za-z0-9_-]/.test(body[i] ?? "")) i--;
  if (body[i] !== "@") return null;
  const prev = i === 0 ? " " : body[i - 1];
  if (prev !== undefined && prev !== " " && prev !== "\n" && prev !== "\t") {
    return null;
  }
  return { token: body.slice(i + 1, caret), start: i };
}

export function ChatComposer({
  onSend,
  disabled = false,
  isPending = false,
  placeholder = "Message agent…",
  banner,
  slashContext,
  contextSummary = [],
  autoFocus = false,
  threadId,
  mentionableAgents = [],
  mentionablePeople = [],
  fillRequest,
}: ChatComposerProps) {
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<ChatComposerAttachmentDraft[]>([]);
  const [isOver, setIsOver] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ---------- Slash-command popover state ----------
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverMatches, setPopoverMatches] = useState<SlashCommand[]>([]);
  const [popoverHighlight, setPopoverHighlight] = useState(0);

  // ---------- @-mention popover state ----------
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionMatches, setMentionMatches] = useState<MentionItem[]>([]);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const mentionStartRef = useRef<number | null>(null);

  // ---------- Draft persistence (localStorage, per-thread) ----------
  // Hydrate the draft when threadId changes. We use a ref to track which
  // threadId we've already hydrated so React-strict-mode double-mount
  // doesn't clobber a freshly-typed value.
  const hydratedThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId) return;
    if (hydratedThreadRef.current === threadId) return;
    hydratedThreadRef.current = threadId;
    try {
      const raw = window.localStorage.getItem(draftStorageKey(threadId));
      setBody(raw ?? "");
    } catch {
      setBody("");
    }
  }, [threadId]);

  // Persist on body change (debounced via rAF to keep keystrokes cheap).
  const persistRaf = useRef<number | null>(null);
  useEffect(() => {
    if (!threadId) return;
    if (persistRaf.current != null) cancelAnimationFrame(persistRaf.current);
    persistRaf.current = requestAnimationFrame(() => {
      try {
        if (body) {
          window.localStorage.setItem(draftStorageKey(threadId), body);
        } else {
          window.localStorage.removeItem(draftStorageKey(threadId));
        }
      } catch {
        /* ignore quota / private mode */
      }
    });
    return () => {
      if (persistRaf.current != null) cancelAnimationFrame(persistRaf.current);
    };
  }, [body, threadId]);

  // ---------- Auto-focus on mount / tab activation ----------
  useEffect(() => {
    if (!autoFocus) return;
    const ta = taRef.current;
    if (!ta) return;
    // Defer to next frame so the panel finishes mounting first.
    const id = requestAnimationFrame(() => {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // ---------- External fill (from suggested-prompt chips, etc.) ----------
  const lastFillNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!fillRequest) return;
    if (lastFillNonceRef.current === fillRequest.nonce) return;
    lastFillNonceRef.current = fillRequest.nonce;
    setBody(fillRequest.body);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    });
  }, [fillRequest]);

  // Auto-resize textarea up to 6 lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [body]);

  // Update slash-command popover whenever body changes.
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
        includeInContext: true,
      })),
    ]);
  }, []);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
    setPopoverMatches([]);
  }, []);

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionMatches([]);
    mentionStartRef.current = null;
  }, []);

  /** Recompute the @-mention popover based on the caret position. */
  const refreshMentionPopover = useCallback(
    (nextBody: string, caret: number) => {
      if (mentionableAgents.length === 0 && mentionablePeople.length === 0) {
        closeMention();
        return;
      }
      const detected = detectMentionToken(nextBody, caret);
      if (!detected) {
        closeMention();
        return;
      }
      const frag = detected.token.toLowerCase();
      const agentMatches: MentionItem[] = mentionableAgents
        .filter(
          (a) =>
            !frag ||
            a.profileKey.toLowerCase().startsWith(frag) ||
            a.name.toLowerCase().startsWith(frag),
        )
        .slice(0, 5)
        .map((agent) => ({ kind: "agent", agent }));
      const personMatches: MentionItem[] = mentionablePeople
        .filter(
          (p) =>
            !frag ||
            p.handle.toLowerCase().startsWith(frag) ||
            p.name.toLowerCase().startsWith(frag),
        )
        .slice(0, 5)
        .map((person) => ({ kind: "user", person }));
      const matches = [...agentMatches, ...personMatches];
      if (matches.length === 0) {
        closeMention();
        return;
      }
      mentionStartRef.current = detected.start;
      setMentionMatches(matches);
      setMentionHighlight(0);
      setMentionOpen(true);
    },
    [mentionableAgents, mentionablePeople, closeMention],
  );

  /** Accept a command from the slash popover. */
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

  /** Accept an @-mention from the popover. */
  const acceptMention = useCallback(
    (item: MentionItem) => {
      const ta = taRef.current;
      const start = mentionStartRef.current;
      if (start == null || !ta) {
        closeMention();
        return;
      }
      const caret = ta.selectionEnd ?? body.length;
      const replacement = `@${mentionInsertKey(item)} `;
      const next = body.slice(0, start) + replacement + body.slice(caret);
      setBody(next);
      closeMention();
      requestAnimationFrame(() => {
        const t = taRef.current;
        if (!t) return;
        const pos = start + replacement.length;
        t.focus();
        t.setSelectionRange(pos, pos);
      });
    },
    [body, closeMention],
  );

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    const files = attachments.filter((a) => a.includeInContext).map((a) => a.file);
    if ((!trimmed && files.length === 0) || disabled) return;

    // Try to intercept as a slash command first when no files are attached.
    if (attachments.length === 0 && slashContext && isSlashInput(trimmed)) {
      const parsed = parseSlashCommand(trimmed);
      if (parsed) {
        parsed.command.run(parsed.args, slashContext);
        setBody("");
        closePopover();
        return;
      }
    }

    setAttachments((prev) =>
      prev.map((a) => ({ ...a, status: a.includeInContext ? "uploading" : "pending" })),
    );
    try {
      await onSend(trimmed, files);
      setBody("");
      setAttachments([]);
      closePopover();
      closeMention();
      if (threadId) {
        try {
          window.localStorage.removeItem(draftStorageKey(threadId));
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setAttachments((prev) => prev.map((a) => ({ ...a, status: "error", error: message })));
    }
  }, [body, attachments, disabled, slashContext, onSend, closePopover, closeMention, threadId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionOpen && mentionMatches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionHighlight((h) => (h + 1) % mentionMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionHighlight((h) => (h - 1 + mentionMatches.length) % mentionMatches.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const item = mentionMatches[mentionHighlight];
          if (item) acceptMention(item);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMention();
          return;
        }
      }

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
    [
      mentionOpen,
      mentionMatches,
      mentionHighlight,
      acceptMention,
      closeMention,
      popoverOpen,
      popoverMatches,
      popoverHighlight,
      acceptCommand,
      closePopover,
      submit,
    ],
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

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setBody(next);
      refreshMentionPopover(next, e.target.selectionEnd ?? next.length);
    },
    [refreshMentionPopover],
  );

  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;
      refreshMentionPopover(ta.value, ta.selectionEnd ?? ta.value.length);
    },
    [refreshMentionPopover],
  );

  const busy = disabled || isPending;
  const hasMentionables =
    mentionableAgents.length > 0 || mentionablePeople.length > 0;

  const popoverNode = useMemo(() => {
    if (popoverOpen && popoverMatches.length > 0) {
      return (
        <div className="relative mx-2 mb-1" data-testid="chat-slash-popover">
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
      );
    }
    if (mentionOpen && mentionMatches.length > 0) {
      // Locate the first user row so we can drop in an "Agents / People"
      // group divider — keeps the popover scannable when both kinds are
      // present (same shape as MentionInput's dropdown).
      const firstUserIdx = mentionMatches.findIndex((m) => m.kind === "user");
      const hasAgents = mentionMatches[0]?.kind === "agent";
      return (
        <div className="relative mx-2 mb-1" data-testid="chat-mention-popover">
          <div className="absolute bottom-0 left-0 right-0 z-50 overflow-hidden rounded-md border border-border bg-card/95 shadow-md backdrop-blur">
            {hasAgents && (
              <div className="px-2.5 pb-0.5 pt-1 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                Agents
              </div>
            )}
            {!hasAgents && firstUserIdx === 0 && (
              <div className="px-2.5 pb-0.5 pt-1 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                People
              </div>
            )}
            {mentionMatches.map((m, idx) => {
              const showPeopleHeader = hasAgents && firstUserIdx === idx;
              const selected = idx === mentionHighlight;
              const insertKey = mentionInsertKey(m);
              return (
                <div key={`${m.kind}-${insertKey}`}>
                  {showPeopleHeader && (
                    <div className="px-2.5 pb-0.5 pt-1 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                      People
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(m);
                    }}
                    onMouseEnter={() => setMentionHighlight(idx)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
                      selected
                        ? "bg-ember/10 text-foreground"
                        : "text-foreground/85 hover:bg-subtle/40",
                    )}
                  >
                    {m.kind === "agent" ? (
                      <span className="relative inline-flex shrink-0 items-center">
                        <span className="flex h-5 w-5 items-center justify-center rounded-md border border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
                          <Bot className="h-3 w-3" />
                        </span>
                        {m.agent.status && (
                          <span className="absolute -bottom-0.5 -right-0.5">
                            <AgentPresenceDot
                              status={m.agent.status}
                              lastHeartbeatAt={m.agent.lastHeartbeatAt ?? null}
                              size="sm"
                            />
                          </span>
                        )}
                      </span>
                    ) : (
                      <Avatar
                        name={m.person.name}
                        image={m.person.image ?? null}
                        size={20}
                        className="shrink-0"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium">
                          {m.kind === "agent" ? m.agent.name : m.person.name}
                        </span>
                        <span className="text-id text-muted-foreground">
                          @{insertKey}
                        </span>
                      </span>
                      {m.kind === "user" && m.person.email && (
                        <span className="mt-0.5 block truncate text-meta text-muted-foreground">
                          {m.person.email}
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    return null;
  }, [
    popoverOpen,
    popoverMatches,
    popoverHighlight,
    acceptCommand,
    mentionOpen,
    mentionMatches,
    mentionHighlight,
    acceptMention,
  ]);

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
        <div className="text-meta bg-subtle/60 px-3 py-1.5 text-muted-foreground">{banner}</div>
      )}

      {(contextSummary.length > 0 || attachments.length > 0) && (
        <div className="text-meta border-b border-border/50 bg-card/25 px-3 py-1.5 text-muted-foreground">
          <button
            type="button"
            onClick={() => setContextOpen((v) => !v)}
            className="flex items-center gap-1 text-left hover:text-foreground"
          >
            {contextOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Context to send
            <span className="text-muted-foreground/70">
              · {contextSummary.length} page item{contextSummary.length === 1 ? "" : "s"},{" "}
              {attachments.filter((a) => a.includeInContext).length}/{attachments.length} file
              {attachments.length === 1 ? "" : "s"}
            </span>
          </button>
          {contextOpen && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {contextSummary.map((item) => (
                <span
                  key={item}
                  className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5 font-mono text-[0.625rem]"
                >
                  {item}
                </span>
              ))}
              {attachments.map((draft) => (
                <span
                  key={draft.id}
                  className={cn(
                    "rounded border px-1.5 py-0.5 font-mono text-[0.625rem]",
                    draft.includeInContext
                      ? "border-emerald-500/30 bg-emerald-500/10"
                      : "border-border bg-subtle/40 line-through opacity-70",
                  )}
                >
                  {draft.includeInContext ? "file" : "excluded"}: {draft.file.name || "attachment"}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {popoverNode}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2" data-testid="chat-attachment-drafts">
          {attachments.map((draft) => {
            const Icon = fileIcon(draft.file);
            return (
              <span
                key={draft.id}
                className={cn(
                  "text-meta inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card/60 px-1.5 py-1",
                  draft.status === "error" && "border-red-500/40 bg-red-500/10",
                )}
                title={draft.error ?? draft.file.name}
              >
                {draft.status === "uploading" ? (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                ) : (
                  <Icon className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="max-w-[11rem] truncate font-mono text-foreground/90">
                  {draft.file.name || "attachment"}
                </span>
                <span className="text-muted-foreground">{prettyBytes(draft.file.size)}</span>
                <button
                  type="button"
                  aria-label={`${draft.includeInContext ? "Exclude" : "Include"} ${draft.file.name || "attachment"} from context`}
                  onClick={() =>
                    setAttachments((prev) =>
                      prev.map((a) =>
                        a.id === draft.id ? { ...a, includeInContext: !a.includeInContext } : a,
                      ),
                    )
                  }
                  disabled={busy}
                  className={cn(
                    "rounded border px-1 py-0.5 text-[0.5625rem] uppercase tracking-wider disabled:opacity-50",
                    draft.includeInContext
                      ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {draft.includeInContext ? "include" : "excluded"}
                </button>
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
          onChange={handleChange}
          onSelect={handleSelect}
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
          disabled={busy || (!body.trim() && attachments.every((a) => !a.includeInContext))}
          className={cn(
            "mb-0.5 rounded-md p-1.5 transition-colors",
            body.trim() || attachments.some((a) => a.includeInContext)
              ? "bg-ember text-white hover:bg-ember/90"
              : "bg-subtle text-muted-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={isPending ? "Sending…" : "Send"}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {isPending ? (
        <div className="text-meta px-3 pb-1.5 text-muted-foreground">sending…</div>
      ) : (
        // Discoverability hint — mirrors the issue composer so @-mentions
        // and / commands read as available everywhere. Shown only while
        // the composer is empty so it never competes with typed content,
        // and each segment is gated to what's actually wired up.
        !body.trim() &&
        attachments.length === 0 &&
        (hasMentionables || !!slashContext) && (
          <div className="text-meta flex flex-wrap items-center gap-1.5 px-3 pb-1.5 text-muted-foreground/80">
            {hasMentionables && (
              <>
                <span className="font-mono">@</span>
                <span>mention</span>
              </>
            )}
            {hasMentionables && slashContext && (
              <span className="text-muted-foreground/40">·</span>
            )}
            {slashContext && (
              <>
                <span className="font-mono">/</span>
                <span>commands</span>
              </>
            )}
            <span className="text-muted-foreground/40">·</span>
            <span className="font-mono">↵</span>
            <span>send</span>
          </div>
        )
      )}
    </div>
  );
}

const SLASH_COMMANDS_WITH_ARGS = new Set(["assign", "status", "comment", "transition"]);
