"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { useConfirm } from "@/components/ui/modal";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { NoteStatus } from "@prisma/client";
import {
  Archive,
  ArchiveRestore,
  NotebookPen,
  ChevronDown,
  ChevronRight,
  FilePlus,
  Folder,
  Pin,
  Plus,
  Rocket,
  Sparkles,
  StickyNote,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useHotkey } from "@/lib/keyboard";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
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
type StatusFilter = "ALL" | NoteStatus;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "IDEA", label: "Ideas" },
  { key: "SOMEDAY", label: "Someday" },
  { key: "ACTIVE", label: "Active" },
  { key: "ARCHIVED", label: "Archived" },
];

export function QuickNotesWidget() {
  const utils = trpc.useUtils();
  const router = useRouter();
  const ws = useMaybeWorkspace();
  const slug = ws?.slug ?? null;
  const workspaceKey = ws?.key ?? "";

  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<"notes" | "journal">("notes");
  const [showArchived, setShowArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [draft, setDraft] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const addRef = useRef<HTMLTextAreaElement | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  // Listing pulls the full slice (no server-side status filter) so the
  // chip row can show counts per status without N queries. The active
  // chip narrows the rendered set client-side.
  const listQ = trpc.note.list.useQuery(
    { archived: showArchived, limit: 100 },
    { staleTime: 30_000, enabled: tab === "notes" },
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
  const setStatus = trpc.note.setStatus.useMutation({
    onSuccess: () => utils.note.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const promote = trpc.note.promote.useMutation({
    onSuccess: (res) => {
      utils.note.list.invalidate();
      if (!slug) {
        toast.success(`Promoted note to ${res.target.kind}.`);
        return;
      }
      const t = res.target;
      let href: string | null = null;
      let label = "";
      if (t.kind === "issue") {
        href = `/w/${slug}/issues/${t.id}`;
        label = `Created ${t.key}`;
      } else if (t.kind === "project") {
        href = `/w/${slug}/projects/${t.id}`;
        label = `Created project ${t.key}`;
      } else {
        href = `/w/${slug}/initiatives/${t.id}`;
        label = `Created initiative ${t.title}`;
      }
      toast.success(label);
      if (href) router.push(href);
    },
    onError: (e) => toast.error(e.message),
  });
  // The headless convert proc still exists for agent / programmatic
  // callers, but the dashboard widget routes through the QuickCreate
  // dialog so the operator can edit title/description and decide
  // whether to archive the source note before submitting. Dispatched
  // via a `forge:quick-create` CustomEvent — QuickCreate listens.
  const convertViaQuickCreate = useCallback(
    (note: { id: string; title: string | null; body: string }) => {
      const firstLine = note.body.split("\n").find((l) => l.trim()) ?? "";
      const seedTitle = (note.title?.trim() || firstLine.trim()).slice(0, 300);
      window.dispatchEvent(
        new CustomEvent("forge:quick-create", {
          detail: {
            title: seedTitle,
            body: note.body,
            archiveNoteId: note.id,
          },
        }),
      );
    },
    [],
  );

  const focusAdd = useCallback(() => {
    setCollapsed(false);
    setTab("notes");
    setTimeout(() => addRef.current?.focus(), 0);
  }, []);

  useHotkey("n", focusAdd, []);

  // Journal tab — get-or-create today's entry, list past entries.
  const journalTodayM = trpc.note.todayJournal.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const journalListQ = trpc.note.listJournal.useQuery(
    { limit: 30 },
    { staleTime: 30_000, enabled: tab === "journal" },
  );

  const [journalDraft, setJournalDraft] = useState<{ id: string; body: string } | null>(null);
  const [todayJournalId, setTodayJournalId] = useState<string | null>(null);

  // Auto-create today's journal on tab focus.
  useEffect(() => {
    if (tab !== "journal") return;
    if (todayJournalId) return;
    journalTodayM
      .mutateAsync(undefined as unknown as void)
      .then((row) => {
        setTodayJournalId(row.id);
        setJournalDraft({ id: row.id, body: row.body });
        void utils.note.listJournal.invalidate();
      })
      .catch(() => {});
    // Run once per tab activation; subsequent dependencies handled inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const journalUpdate = trpc.note.update.useMutation({
    onSuccess: () => utils.note.listJournal.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  // Build today's heading. Uses Intl.DateTimeFormat in the user's
  // browser locale — picks up timezone from the user's environment.
  const todayHeading = useMemo(() => {
    const now = new Date();
    return now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, []);

  const items = useMemo(() => listQ.data?.items ?? [], [listQ.data]);
  const count = items.length;
  const statusCounts = useMemo(() => {
    const c: Record<NoteStatus, number> = {
      IDEA: 0,
      SOMEDAY: 0,
      ACTIVE: 0,
      ARCHIVED: 0,
    };
    for (const n of items) c[n.status as NoteStatus] += 1;
    return c;
  }, [items]);
  const filteredItems = useMemo(() => {
    if (statusFilter === "ALL") return items;
    return items.filter((n) => n.status === statusFilter);
  }, [items, statusFilter]);

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
    <section className="min-w-0 rounded-lg border border-border bg-card/40">
      <header
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-2 px-4 py-2.5",
          collapsed ? "" : "border-b border-border",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="focus-ring flex min-w-0 items-center gap-2 rounded text-sm font-medium hover:text-foreground"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {tab === "notes" ? (
            <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <NotebookPen className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span>{tab === "notes" ? "Notes" : "Journal"}</span>
          {tab === "notes" && count > 0 && (
            <span className="rounded-full bg-subtle px-1.5 font-mono text-[0.6875rem] text-muted-foreground">
              {count}
            </span>
          )}
          {tab === "journal" && (
            <span className="text-meta font-mono normal-case tracking-normal text-muted-foreground/80">
              {todayHeading}
            </span>
          )}
        </button>
        {!collapsed && (
          <>
            {/* Tab switch */}
            <div className="ml-2 inline-flex shrink-0 overflow-hidden rounded-md border border-border bg-card/40 text-[0.6875rem]">
              <button
                type="button"
                onClick={() => setTab("notes")}
                className={cn(
                  "focus-ring px-2 py-0.5 font-mono uppercase tracking-wider",
                  tab === "notes"
                    ? "bg-subtle text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="Personal notes — quick scratchpad"
              >
                Notes
              </button>
              <button
                type="button"
                onClick={() => setTab("journal")}
                className={cn(
                  "focus-ring border-l border-border px-2 py-0.5 font-mono uppercase tracking-wider",
                  tab === "journal"
                    ? "bg-subtle text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="Daily journal — one entry per day"
              >
                Journal
              </button>
            </div>
            {tab === "notes" && (
              <button
                type="button"
                onClick={focusAdd}
                className="focus-ring text-meta ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-muted-foreground hover:border-ember/40 hover:text-foreground"
                title="Add a quick note (n)"
              >
                <Plus className="h-3 w-3" />
                <span>Add</span>
              </button>
            )}
            {tab === "notes" && (
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className={cn(
                  "focus-ring text-meta inline-flex items-center gap-1 rounded-md px-1.5 py-0.5",
                  showArchived ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                title={showArchived ? "Show active notes" : "Show archived notes"}
              >
                <Archive className="h-3 w-3" />
                <span>{showArchived ? "Active" : "Archived"}</span>
              </button>
            )}
          </>
        )}
      </header>

      {!collapsed && tab === "journal" && (
        <JournalBody
          today={
            todayJournalId
              ? (journalListQ.data?.items.find((n) => n.id === todayJournalId) ??
                (journalDraft
                  ? {
                      id: journalDraft.id,
                      title: null,
                      body: journalDraft.body,
                      pinned: false,
                      kind: "JOURNAL" as const,
                      journalDate: new Date(),
                      archivedAt: null,
                      updatedAt: new Date(),
                    }
                  : null))
              : null
          }
          todayHeading={todayHeading}
          past={(journalListQ.data?.items ?? []).filter(
            (n) => !todayJournalId || n.id !== todayJournalId,
          )}
          loading={journalListQ.isLoading}
          onSaveBody={(body) => {
            if (!todayJournalId) return;
            journalUpdate.mutate({ id: todayJournalId, body });
            setJournalDraft({ id: todayJournalId, body });
          }}
        />
      )}

      {!collapsed && tab === "notes" && (
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
                <div className="text-meta flex items-center gap-2 text-muted-foreground">
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

          {/* Status filter chip row */}
          {!showArchived && items.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2">
              {STATUS_FILTERS.map((f) => {
                const n = f.key === "ALL" ? items.length : statusCounts[f.key as NoteStatus];
                const active = statusFilter === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStatusFilter(f.key)}
                    className={cn(
                      "focus-ring text-meta inline-flex items-center gap-1 rounded-full border px-2 py-0.5 uppercase tracking-wider transition-colors",
                      active
                        ? "border-ember/40 bg-ember/10 text-ember"
                        : "border-border bg-card/40 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span>{f.label}</span>
                    <span
                      className={cn(
                        "rounded-full px-1 font-mono normal-case tracking-normal",
                        active ? "bg-ember/15" : "bg-subtle/70",
                      )}
                    >
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* List */}
          {listQ.isLoading ? (
            <ul className="flex flex-col gap-1 p-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <li key={i} className="h-8 animate-pulse rounded bg-subtle/60" />
              ))}
            </ul>
          ) : filteredItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {showArchived
                ? "No archived notes."
                : statusFilter !== "ALL"
                  ? `No notes with status ${statusFilter.toLowerCase()}.`
                  : "Quick thought? Press N."}
            </div>
          ) : (
            <ul className="flex flex-col">
              {filteredItems.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  workspaceKey={workspaceKey}
                  slug={slug}
                  expanded={expandedId === n.id}
                  editing={editingId === n.id}
                  editingValue={editingValue}
                  onExpand={() => setExpandedId((id) => (id === n.id ? null : n.id))}
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
                  onTogglePin={() => update.mutate({ id: n.id, pinned: !n.pinned })}
                  onArchive={() => archive.mutate({ id: n.id })}
                  onUnarchive={() => unarchive.mutate({ id: n.id })}
                  onDelete={() => del.mutate({ id: n.id })}
                  onConvert={() => convertViaQuickCreate(n)}
                  onSetStatus={(status) => setStatus.mutate({ noteId: n.id, status })}
                  onPromote={(kind) => promote.mutate({ noteId: n.id, kind })}
                  promoting={promote.isPending}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Journal body — today's entry as an editable card, past entries below.
// ---------------------------------------------------------------------------

type JournalRow = {
  id: string;
  title: string | null;
  body: string;
  pinned: boolean;
  kind: "JOURNAL" | "NOTE";
  journalDate: Date | string | null;
  archivedAt: Date | string | null;
  updatedAt: Date | string;
};

function JournalBody({
  today,
  todayHeading,
  past,
  loading,
  onSaveBody,
}: {
  today: JournalRow | null;
  todayHeading: string;
  past: JournalRow[];
  loading: boolean;
  onSaveBody: (body: string) => void;
}) {
  // Local controlled body so typing isn't a round-trip per keystroke.
  // Persisted on blur or ⌘⏎ via `onSaveBody`.
  const [body, setBody] = useState(today?.body ?? "");
  const lastIdRef = useRef<string | null>(null);

  // Sync local state when today's row hydrates / changes.
  useEffect(() => {
    if (!today) return;
    if (lastIdRef.current === today.id) return;
    lastIdRef.current = today.id;
    setBody(today.body);
  }, [today]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback(
    (next: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onSaveBody(next);
      }, 800);
    },
    [onSaveBody],
  );

  return (
    <div className="flex flex-col">
      {/* Today's entry */}
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="text-meta flex items-center gap-2 text-muted-foreground">
          <NotebookPen className="h-3 w-3" />
          <span className="font-mono uppercase tracking-wider">Today</span>
          <span className="text-muted-foreground/80">·</span>
          <span>{todayHeading}</span>
        </div>
        {today ? (
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              scheduleSave(e.target.value);
            }}
            onBlur={() => {
              if (debounceRef.current) clearTimeout(debounceRef.current);
              if (today && body !== today.body) onSaveBody(body);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (debounceRef.current) clearTimeout(debounceRef.current);
                onSaveBody(body);
              }
            }}
            placeholder="What happened today? Wins, blockers, decisions, follow-ups…"
            rows={4}
            className="focus-ring w-full resize-y rounded-md border border-input bg-background/40 p-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none"
          />
        ) : (
          <div className="text-meta text-muted-foreground">Loading today&apos;s entry…</div>
        )}
        <div className="text-meta text-muted-foreground">Auto-saves on blur · ⌘⏎ to save now</div>
      </div>

      {/* Past entries */}
      <div className="flex flex-col">
        {loading ? (
          <ul className="flex flex-col gap-1 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="h-8 animate-pulse rounded bg-subtle/60" />
            ))}
          </ul>
        ) : past.length === 0 ? (
          <div className="px-4 py-4 text-center text-xs text-muted-foreground">
            No past entries yet — they&apos;ll appear here as the days roll on.
          </div>
        ) : (
          <ul className="flex flex-col">
            {past.map((n) => (
              <JournalPastRow key={n.id} note={n} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function JournalPastRow({ note }: { note: JournalRow }) {
  const [open, setOpen] = useState(false);
  const dateLabel = useMemo(() => {
    if (!note.journalDate) return "—";
    const d = new Date(note.journalDate);
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }, [note.journalDate]);
  const firstLine = useMemo(
    () =>
      note.body
        .split("\n")
        .find((l) => l.trim().length > 0)
        ?.trim() ?? "",
    [note.body],
  );

  return (
    <li className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-subtle/40"
      >
        <span className="text-id shrink-0 font-mono text-muted-foreground">{dateLabel}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {firstLine || <span className="italic text-muted-foreground">empty</span>}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-3">
          <div className="rounded-md border border-border bg-background/40 p-2">
            <MarkdownWithAttachments body={note.body || "_(empty)_"} className="text-xs" />
          </div>
        </div>
      )}
    </li>
  );
}

type NoteRowProps = {
  note: {
    id: string;
    title: string | null;
    body: string;
    pinned: boolean;
    status: NoteStatus;
    promotedToType: string | null;
    promotedToId: string | null;
    archivedAt: Date | string | null;
    updatedAt: Date | string;
  };
  workspaceKey: string;
  slug: string | null;
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
  onSetStatus: (status: NoteStatus) => void;
  onPromote: (kind: "issue" | "project" | "initiative") => void;
  promoting: boolean;
};

function NoteRow({
  note,
  workspaceKey,
  slug,
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
  onSetStatus,
  onPromote,
  promoting,
}: NoteRowProps) {
  const { confirm, confirmElement } = useConfirm();
  const archived = !!note.archivedAt;
  const [convertOpen, setConvertOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const statusBtnRef = useRef<HTMLButtonElement | null>(null);
  const convertBtnRef = useRef<HTMLButtonElement | null>(null);
  const excerpt = useMemo(() => {
    if (note.title) return note.body;
    const firstLine = note.body.split("\n")[0] ?? "";
    return note.body.length > firstLine.length ? note.body : firstLine;
  }, [note.body, note.title]);
  const displayTitle = note.title?.trim() || note.body.split("\n")[0]?.trim() || "Untitled";
  const alreadyPromoted = !!note.promotedToId && !!note.promotedToType;

  return (
    <li className="group border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-2 px-4 py-2">
        <button
          type="button"
          onClick={onTogglePin}
          className={cn(
            "focus-ring mt-1 shrink-0 rounded p-0.5",
            note.pinned ? "text-ember" : "text-muted-foreground/60 hover:text-foreground",
          )}
          title={note.pinned ? "Unpin" : "Pin to top"}
        >
          {note.pinned ? <Pin className="h-3 w-3 fill-current" /> : <Pin className="h-3 w-3" />}
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
          <button type="button" onClick={onExpand} className="block w-full text-left">
            {expanded ? (
              <div className="mt-1 rounded-md border border-border bg-background/40 p-2">
                <MarkdownWithAttachments body={note.body} className="text-xs" />
              </div>
            ) : (
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {excerpt.slice(0, 200)}
                {excerpt.length > 200 ? "…" : ""}
              </div>
            )}
          </button>
          <div className="text-meta mt-1 flex items-center gap-2 text-muted-foreground">
            <span>{relativeTime(note.updatedAt)}</span>
            <span className="relative inline-flex">
              <button
                ref={statusBtnRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setStatusOpen((v) => !v);
                  setConvertOpen(false);
                }}
                className="focus-ring"
                title="Change lifecycle status"
              >
                <NoteStatusChip status={note.status} />
              </button>
              <AnchoredPopover
                anchorRef={statusBtnRef}
                open={statusOpen}
                onClose={() => setStatusOpen(false)}
                align="left"
                role="menu"
                className="flex flex-col rounded-md border border-border bg-card py-1 shadow-md"
              >
                {(["IDEA", "SOMEDAY", "ACTIVE", "ARCHIVED"] as NoteStatus[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      onSetStatus(s);
                      setStatusOpen(false);
                    }}
                    className={cn(
                      "focus-ring flex items-center gap-2 px-2 py-1 text-left text-xs hover:bg-subtle/60",
                      s === note.status && "text-foreground",
                    )}
                  >
                    <NoteStatusChip status={s} />
                  </button>
                ))}
              </AnchoredPopover>
            </span>
            {alreadyPromoted && (
              <PromotedBadge note={note} slug={slug} workspaceKey={workspaceKey} />
            )}
            {archived && (
              <span className="rounded bg-subtle/60 px-1 text-[0.6rem] uppercase tracking-wider">
                archived
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="relative">
            <button
              ref={convertBtnRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConvertOpen((v) => !v);
                setStatusOpen(false);
              }}
              disabled={promoting || alreadyPromoted}
              className={cn(
                "focus-ring rounded p-1 text-muted-foreground hover:bg-subtle hover:text-foreground",
                (promoting || alreadyPromoted) && "opacity-40",
              )}
              title={
                alreadyPromoted
                  ? `Already promoted to ${note.promotedToType}`
                  : "Convert this note to an issue, project, or initiative"
              }
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
            <AnchoredPopover
              anchorRef={convertBtnRef}
              open={convertOpen && !alreadyPromoted}
              onClose={() => setConvertOpen(false)}
              align="right"
              role="menu"
              className="flex w-44 flex-col rounded-md border border-border bg-card py-1 shadow-md"
            >
              <button
                type="button"
                onClick={() => {
                  onPromote("issue");
                  setConvertOpen(false);
                }}
                className="focus-ring flex items-center gap-2 px-2 py-1 text-left text-xs hover:bg-subtle/60"
              >
                <FilePlus className="h-3 w-3 text-muted-foreground" />
                <span>Convert to Issue</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onPromote("project");
                  setConvertOpen(false);
                }}
                className="focus-ring flex items-center gap-2 px-2 py-1 text-left text-xs hover:bg-subtle/60"
              >
                <Folder className="h-3 w-3 text-muted-foreground" />
                <span>Convert to Project</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onPromote("initiative");
                  setConvertOpen(false);
                }}
                className="focus-ring flex items-center gap-2 px-2 py-1 text-left text-xs hover:bg-subtle/60"
              >
                <Rocket className="h-3 w-3 text-muted-foreground" />
                <span>Convert to Initiative</span>
              </button>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={() => {
                  onConvert();
                  setConvertOpen(false);
                }}
                className="focus-ring flex items-center gap-2 px-2 py-1 text-left text-xs hover:bg-subtle/60"
                title="Open the quick-create dialog so you can tweak title and description"
              >
                <FilePlus className="h-3 w-3 text-muted-foreground" />
                <span>Open in Quick Create…</span>
              </button>
            </AnchoredPopover>
          </div>
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
              onClick={async () => {
                if (
                  await confirm({
                    title: "Delete this note?",
                    description: "This can't be undone — use Archive for the soft path.",
                    primaryLabel: "Delete",
                    variant: "destructive",
                  })
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
      {confirmElement}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Status chip + promoted-target badge — warm-earthy tokenized colors.
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<NoteStatus, string> = {
  IDEA: "border-ember/40 bg-ember/10 text-ember",
  SOMEDAY: "border-border bg-subtle/70 text-muted-foreground",
  ACTIVE: "border-success/40 bg-success/10 text-success",
  ARCHIVED: "border-border bg-subtle/40 text-muted-foreground/80",
};

function NoteStatusChip({ status }: { status: NoteStatus }) {
  return (
    <span
      className={cn(
        "text-meta inline-flex items-center rounded-full border px-1.5 uppercase tracking-wider",
        STATUS_STYLES[status],
      )}
    >
      {status.toLowerCase()}
    </span>
  );
}

function PromotedBadge({
  note,
  slug,
  workspaceKey,
}: {
  note: { promotedToType: string | null; promotedToId: string | null };
  slug: string | null;
  workspaceKey: string;
}) {
  const targetInfo = usePromotedTarget(note.promotedToType, note.promotedToId);
  if (!note.promotedToType || !note.promotedToId) return null;
  let href: string | null = null;
  let label = "";
  if (note.promotedToType === "issue") {
    href = slug ? `/w/${slug}/issues/${note.promotedToId}` : null;
    label = targetInfo?.number ? `→ ${formatIssueId(workspaceKey, targetInfo.number)}` : "→ issue";
  } else if (note.promotedToType === "project") {
    href = slug ? `/w/${slug}/projects/${note.promotedToId}` : null;
    label = targetInfo?.key ? `→ ${targetInfo.key}` : "→ project";
  } else if (note.promotedToType === "initiative") {
    href = slug ? `/w/${slug}/initiatives/${note.promotedToId}` : null;
    label = targetInfo?.name ? `→ ${targetInfo.name}` : "→ initiative";
  }
  const className =
    "inline-flex items-center rounded border border-border bg-subtle/60 px-1.5 text-meta font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground";
  if (!href) {
    return <span className={className}>{label}</span>;
  }
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className={className}
      title={`Promoted to ${note.promotedToType}`}
    >
      {label}
    </Link>
  );
}

function usePromotedTarget(
  type: string | null,
  id: string | null,
): { number?: number; key?: string; name?: string } | null {
  const issueQ = trpc.issue.byId.useQuery(
    { id: id ?? "" },
    { enabled: type === "issue" && !!id, staleTime: 60_000 },
  );
  const projectQ = trpc.project.byId.useQuery(
    { id: id ?? "" },
    { enabled: type === "project" && !!id, staleTime: 60_000 },
  );
  const initiativeQ = trpc.initiative.get.useQuery(
    { id: id ?? "" },
    { enabled: type === "initiative" && !!id, staleTime: 60_000 },
  );
  if (type === "issue" && issueQ.data) {
    return { number: issueQ.data.number };
  }
  if (type === "project" && projectQ.data) {
    return { key: projectQ.data.key };
  }
  if (type === "initiative" && initiativeQ.data) {
    return { name: initiativeQ.data.name };
  }
  return null;
}
