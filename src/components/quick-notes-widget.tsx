"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FilePlus,
  Pin,
  Plus,
  StickyNote,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { useHotkey } from "@/lib/keyboard";
import { cn, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";

/**
 * Quick Notes — per-user markdown scratchpad surfaced on the dashboard.
 *
 * Single collapsible card sitting between GreetingBar and OnboardingCard.
 * Notes are personal (server-side, per-(workspace, user)). Pinned notes
 * float; archived notes drop out of the default list. Convert-to-issue
 * spawns a real Issue without removing the source note.
 *
 * Hotkey: `n` focuses the inline add row when the dashboard is mounted.
 * Suppressed when the cursor is in an input/textarea (per `useHotkey`).
 */
export function QuickNotesWidget() {
  const ws = useWorkspace();
  const router = useRouter();
  const utils = trpc.useUtils();

  const [collapsed, setCollapsed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const addRef = useRef<HTMLTextAreaElement | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const listQ = trpc.note.list.useQuery(
    { archived: showArchived, limit: 30 },
    { staleTime: 30_000 },
  );

  const create = trpc.note.create.useMutation({
    onSuccess: () => {
      setDraft("");
      setDraftTitle("");
      utils.note.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.note.update.useMutation({
    onSuccess: () => utils.note.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.note.archive.useMutation({
    onSuccess: () => utils.note.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const unarchive = trpc.note.unarchive.useMutation({
    onSuccess: () => utils.note.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.note.delete.useMutation({
    onSuccess: () => utils.note.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const convert = trpc.note.convertToIssue.useMutation({
    onSuccess: ({ issueId, number }) => {
      toast.success(`Converted to issue #${number}`);
      utils.issue.list.invalidate();
      router.push(`/w/${ws.slug}/issues/${issueId}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const focusAdd = useCallback(() => {
    setCollapsed(false);
    setTimeout(() => addRef.current?.focus(), 0);
  }, []);

  useHotkey("n", focusAdd, []);

  const items = listQ.data?.items ?? [];
  const count = items.length;

  const submitDraft = useCallback(() => {
    const body = draft.trim();
    if (!body) return;
    create.mutate({
      body,
      title: draftTitle.trim() || undefined,
      pinned: false,
    });
  }, [draft, draftTitle, create]);

  // Auto-grow the add textarea.
  useEffect(() => {
    const el = addRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [draft]);

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <header
        className={cn(
          "flex items-center gap-2 px-4 py-2.5",
          collapsed ? "" : "border-b border-border",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="focus-ring flex items-center gap-2 rounded text-sm font-medium hover:text-foreground"
          title={collapsed ? "Expand notes" : "Collapse notes"}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Notes</span>
          {count > 0 && (
            <span className="rounded-full bg-subtle px-1.5 font-mono text-[0.6875rem] text-muted-foreground">
              {count}
            </span>
          )}
        </button>
        {!collapsed && (
          <>
            <button
              type="button"
              onClick={focusAdd}
              className="focus-ring ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-meta text-muted-foreground hover:border-ember/40 hover:text-foreground"
              title="Add a quick note (n)"
            >
              <Plus className="h-3 w-3" />
              <span>Add</span>
            </button>
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className={cn(
                "focus-ring inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta",
                showArchived
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={
                showArchived
                  ? "Show active notes"
                  : "Show archived notes"
              }
            >
              <Archive className="h-3 w-3" />
              <span>{showArchived ? "Active" : "Archived"}</span>
            </button>
          </>
        )}
      </header>

      {!collapsed && (
        <div className="flex flex-col">
          {/* Inline add row */}
          {!showArchived && (
            <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Title (optional)"
                className="focus-ring w-full bg-transparent text-sm placeholder:text-muted-foreground/60 focus:outline-none"
              />
              <textarea
                ref={addRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitDraft();
                  } else if (e.key === "Enter" && !e.shiftKey && draft.trim() && !draftTitle) {
                    // Single-line quick capture: bare Enter creates when no title.
                    e.preventDefault();
                    submitDraft();
                  } else if (e.key === "Escape") {
                    setDraft("");
                    setDraftTitle("");
                    addRef.current?.blur();
                  }
                }}
                rows={1}
                placeholder="Quick thought? Press N — Enter to save, Esc to cancel."
                className="focus-ring min-h-[2rem] w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground/60 focus:outline-none"
              />
              {draft.trim() && (
                <div className="flex items-center gap-2 text-meta text-muted-foreground">
                  <span>Enter to save · Esc to cancel</span>
                  <button
                    type="button"
                    onClick={submitDraft}
                    disabled={create.isPending}
                    className="focus-ring ml-auto inline-flex items-center gap-1 rounded-md border border-ember/40 bg-ember/10 px-2 py-0.5 text-ember hover:bg-ember/15"
                  >
                    <Plus className="h-3 w-3" />
                    Save
                  </button>
                </div>
              )}
            </div>
          )}

          {/* List */}
          {listQ.isLoading ? (
            <ul className="flex flex-col gap-1 p-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <li
                  key={i}
                  className="h-8 animate-pulse rounded bg-subtle/60"
                />
              ))}
            </ul>
          ) : items.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {showArchived
                ? "No archived notes."
                : "Quick thought? Press N."}
            </div>
          ) : (
            <ul className="flex flex-col">
              {items.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  expanded={expandedId === n.id}
                  editing={editingId === n.id}
                  editingValue={editingValue}
                  onExpand={() =>
                    setExpandedId((id) => (id === n.id ? null : n.id))
                  }
                  onStartEdit={() => {
                    setEditingId(n.id);
                    setEditingValue(n.title ?? "");
                  }}
                  onCancelEdit={() => {
                    setEditingId(null);
                    setEditingValue("");
                  }}
                  onCommitEdit={(title) => {
                    update.mutate({ id: n.id, title: title || null });
                    setEditingId(null);
                    setEditingValue("");
                  }}
                  onEditingChange={setEditingValue}
                  onTogglePin={() =>
                    update.mutate({ id: n.id, pinned: !n.pinned })
                  }
                  onArchive={() => archive.mutate({ id: n.id })}
                  onUnarchive={() => unarchive.mutate({ id: n.id })}
                  onDelete={() => del.mutate({ id: n.id })}
                  onConvert={() => convert.mutate({ id: n.id })}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

type NoteRowProps = {
  note: {
    id: string;
    title: string | null;
    body: string;
    pinned: boolean;
    archivedAt: Date | string | null;
    updatedAt: Date | string;
  };
  expanded: boolean;
  editing: boolean;
  editingValue: string;
  onExpand: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCommitEdit: (title: string) => void;
  onEditingChange: (v: string) => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onConvert: () => void;
};

function NoteRow({
  note,
  expanded,
  editing,
  editingValue,
  onExpand,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onEditingChange,
  onTogglePin,
  onArchive,
  onUnarchive,
  onDelete,
  onConvert,
}: NoteRowProps) {
  const archived = !!note.archivedAt;
  const excerpt = useMemo(() => {
    if (note.title) return note.body;
    const firstLine = note.body.split("\n")[0] ?? "";
    return note.body.length > firstLine.length
      ? note.body
      : firstLine;
  }, [note.body, note.title]);
  const displayTitle = note.title?.trim() || note.body.split("\n")[0]?.trim() || "Untitled";

  return (
    <li className="group border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-2 px-4 py-2">
        <button
          type="button"
          onClick={onTogglePin}
          className={cn(
            "focus-ring mt-1 shrink-0 rounded p-0.5",
            note.pinned
              ? "text-ember"
              : "text-muted-foreground/60 hover:text-foreground",
          )}
          title={note.pinned ? "Unpin" : "Pin to top"}
        >
          {note.pinned ? (
            <Pin className="h-3 w-3 fill-current" />
          ) : (
            <Pin className="h-3 w-3" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={editingValue}
              onChange={(e) => onEditingChange(e.target.value)}
              onBlur={() => onCommitEdit(editingValue.trim())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCommitEdit(editingValue.trim());
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit();
                }
              }}
              autoFocus
              placeholder="Title"
              className="focus-ring w-full bg-transparent text-sm focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={onStartEdit}
              className="focus-ring max-w-full truncate text-left text-sm font-medium hover:text-foreground"
              title="Edit title"
            >
              {displayTitle}
            </button>
          )}
          <button
            type="button"
            onClick={onExpand}
            className="block w-full text-left"
          >
            {expanded ? (
              <div className="mt-1 rounded-md border border-border bg-background/40 p-2">
                <MarkdownWithAttachments
                  body={note.body}
                  className="text-xs"
                />
              </div>
            ) : (
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {excerpt.slice(0, 200)}
                {excerpt.length > 200 ? "…" : ""}
              </div>
            )}
          </button>
          <div className="mt-1 flex items-center gap-2 text-meta text-muted-foreground">
            <span>{relativeTime(note.updatedAt)}</span>
            {archived && (
              <span className="rounded bg-subtle/60 px-1 text-[0.6rem] uppercase tracking-wider">
                archived
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={onConvert}
            className="focus-ring rounded p-1 text-muted-foreground hover:bg-subtle hover:text-foreground"
            title="Convert to issue — opens the new issue with this note's body"
          >
            <FilePlus className="h-3.5 w-3.5" />
          </button>
          {archived ? (
            <button
              type="button"
              onClick={onUnarchive}
              className="focus-ring rounded p-1 text-muted-foreground hover:bg-subtle hover:text-foreground"
              title="Unarchive — restore to active list"
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onArchive}
              className="focus-ring rounded p-1 text-muted-foreground hover:bg-subtle hover:text-foreground"
              title="Archive — soft-hide this note"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
          {archived && (
            <button
              type="button"
              onClick={() => {
                if (
                  confirm(
                    "Permanently delete this note? Use Archive for the soft path.",
                  )
                )
                  onDelete();
              }}
              className="focus-ring rounded p-1 text-muted-foreground hover:bg-subtle hover:text-danger"
              title="Delete permanently"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
