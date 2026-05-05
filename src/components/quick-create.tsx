"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { Kbd } from "@/components/ui/kbd";
import { useHotkey } from "@/lib/keyboard";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { clearDraft, readDraft, saveDraft } from "@/components/ui/modal/draft";
import { NewCycleDialog } from "@/components/cycles/new-cycle-dialog";
import { NewInitiativeDialog } from "@/components/initiatives/new-initiative-dialog";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";
import {
  parseSlashCommands,
  SLASH_COMMAND_HELP,
} from "@/lib/slash-commands";
import {
  SlashAutocomplete,
  useSlashAutocomplete,
} from "@/components/slash-autocomplete";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

type Mode =
  | { kind: "issue" }
  | { kind: "cycle" }
  | { kind: "initiative" }
  | { kind: "project" }
  | { kind: "issue-context"; issueId: string; intent: "comment" | "sub-issue" };

const DRAFT_KEY = "quickCreate";

type DraftShape = {
  text: string;
  mode?: Mode["kind"];
};

/**
 * Context-aware quick-create. `⇧C` opens a Linear-style floating input at
 * the top of the viewport — single line, fast, keyboard-first. The
 * container is NOT a modal: it doesn't dim the page, and clicking outside
 * simply closes.
 *
 * Pathname determines the *initial* mode (set when the overlay opens). On
 * pages that aren't issue-context, the mode chip becomes a dropdown so the
 * user can switch to issue / sprint / project / initiative without
 * navigating first.
 *
 *   /w/*\/cycles           → "cycle"       (⏎ create · ⌘⏎ full form)
 *   /w/*\/initiatives      → "initiative"  (⏎ create · ⌘⏎ full form)
 *   /w/*\/projects         → "project"     (⏎ create · ⌘⏎ full form)
 *   /w/*\/issues/:id       → "issue-context" (comment | sub-issue tabs)
 *   anywhere else          → "issue"       (⏎ create · ⌘⏎ create + open)
 *
 * Draft behavior: if the user has typed anything and dismisses with `⎋`,
 * the text is persisted under `forge.draft.quickCreate` for 24h. The next
 * `⇧C` open restores it with a small "Restored" pill.
 *
 * For modes where a single line isn't enough (initiative wants slug +
 * description + color, project wants key + color), `⌘⏎` escalates to the
 * existing full-form dialog with the typed value pre-filled as the name.
 */
export function QuickCreate() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "issue" });
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<Priority>("NONE");
  const [projectId, setProjectId] = useState<string>("");
  const [restored, setRestored] = useState(false);

  // External seeding: when QuickCreate is opened via a `forge:quick-create`
  // event with `title` + `body` (e.g. from "Convert to issue" on a Quick
  // Note), we surface a description textarea and pre-fill it. The
  // optional `archiveNoteId` lives alongside so the success path can
  // archive the source note when the operator opts in.
  const [seedDescription, setSeedDescription] = useState<string>("");
  const [showDescription, setShowDescription] = useState(false);
  const [archiveNoteId, setArchiveNoteId] = useState<string | null>(null);
  const [archiveOnCreate, setArchiveOnCreate] = useState(true);

  // Escalation: when ⌘⏎ is hit on a mode that has a richer full form,
  // we route to the matching NewXDialog with a seeded name.
  const [fullForm, setFullForm] =
    useState<null | { kind: "cycle" | "initiative" | "project"; name: string }>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const router = useRouter();
  const pathname = usePathname();
  const ws = useMaybeWorkspace();
  const utils = trpc.useUtils();

  // Only fetch projects for issue mode — the chip picker in the secondary
  // row uses it.
  const { data: projects } = trpc.project.list.useQuery(
    { archived: false, limit: 100 },
    { enabled: open && mode.kind === "issue" },
  );

  // Parent issue context (for inheriting its project on sub-issue).
  const contextIssueId =
    mode.kind === "issue-context" ? mode.issueId : undefined;
  const { data: contextIssue } = trpc.issue.byId.useQuery(
    { id: contextIssueId ?? "" },
    { enabled: open && !!contextIssueId },
  );

  // ----- mutations --------------------------------------------------

  const createIssue = trpc.issue.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const createComment = trpc.comment.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const createCycle = trpc.cycle.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const createInitiative = trpc.initiative.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const createProject = trpc.project.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  // Optional follow-up: when QuickCreate was seeded from a note's
  // "Convert to issue" action and the operator left the archive
  // checkbox checked, archive the source note after the issue is
  // persisted. Best-effort — failure toasts but doesn't block the
  // create success path.
  const archiveNote = trpc.note.archive.useMutation({
    onError: (err) => toast.error(`Issue created — note archive failed: ${err.message}`),
    onSuccess: () => {
      void utils.note.list.invalidate();
    },
  });

  const busy =
    createIssue.isPending ||
    createComment.isPending ||
    createCycle.isPending ||
    createInitiative.isPending ||
    createProject.isPending;

  // ----- open/close lifecycle --------------------------------------

  const modeForPath = useCallback((path: string | null): Mode => {
    if (!path) return { kind: "issue" };
    const tail = path.replace(/^\/w\/[^/]+/, "");
    const issueMatch = tail.match(/^\/issues\/([^/?#]+)/);
    if (issueMatch) {
      return {
        kind: "issue-context",
        issueId: issueMatch[1],
        intent: "comment",
      };
    }
    if (tail === "/cycles" || tail.startsWith("/cycles?")) return { kind: "cycle" };
    if (tail === "/initiatives" || tail.startsWith("/initiatives?"))
      return { kind: "initiative" };
    if (tail === "/projects" || tail.startsWith("/projects?"))
      return { kind: "project" };
    return { kind: "issue" };
  }, []);

  const close = useCallback(
    (persistDraft: boolean) => {
      // Don't persist the draft when we were seeded from an external
      // event (note convert) — the user's intent was a one-shot, and
      // restoring "From note: …" later would be confusing.
      if (persistDraft && text.trim().length > 0 && !archiveNoteId) {
        saveDraft<DraftShape>(DRAFT_KEY, { text, mode: mode.kind });
      }
      setOpen(false);
      setText("");
      setPriority("NONE");
      setProjectId("");
      setRestored(false);
      setSeedDescription("");
      setShowDescription(false);
      setArchiveNoteId(null);
      setArchiveOnCreate(true);
    },
    [text, mode.kind, archiveNoteId],
  );

  const openFor = useCallback(
    (override?: {
      projectId?: string;
      title?: string;
      body?: string;
      archiveNoteId?: string;
    }) => {
      const next = modeForPath(pathname);
      // Force issue mode when seeded with a title/body (e.g. note
      // convert) — picking that on a `/cycles` page should still go to
      // an issue.
      const seeded = !!(override?.title || override?.body);
      const effectiveMode: Mode = seeded ? { kind: "issue" } : next;
      setMode(effectiveMode);
      if (override?.projectId) setProjectId(override.projectId);

      if (seeded) {
        setText(override.title ?? "");
        setSeedDescription(override.body ?? "");
        setShowDescription(true);
        setArchiveNoteId(override.archiveNoteId ?? null);
        setArchiveOnCreate(true);
        setRestored(false);
      } else {
        // Hydrate a draft if present + mode matches.
        const draft = readDraft<DraftShape>(DRAFT_KEY);
        if (draft && draft.text) {
          if (!draft.mode || draft.mode === effectiveMode.kind) {
            setText(draft.text);
            setRestored(true);
          } else {
            setRestored(false);
          }
        } else {
          setRestored(false);
        }
      }
      setOpen(true);
    },
    [modeForPath, pathname],
  );

  // Hotkey: ⇧C (does not fire inside editable fields unless the leader
  // modifier matches — which it doesn't here, so typing ⇧C in a textarea
  // naturally inserts a capital C).
  useHotkey("shift+c", () => openFor(), [pathname]);

  // Legacy hooks: [data-quick-create] clicks + window event.
  useEffect(() => {
    const clickHandler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest(
        "[data-quick-create]",
      ) as HTMLElement | null;
      if (!el) return;
      const pid = el.dataset.quickCreateProject;
      openFor(pid ? { projectId: pid } : undefined);
    };
    document.addEventListener("click", clickHandler);
    const evtHandler = (e: Event) => {
      const detail =
        (e as CustomEvent<{
          projectId?: string;
          title?: string;
          body?: string;
          archiveNoteId?: string;
        }>).detail ?? {};
      openFor(detail);
    };
    window.addEventListener("forge:quick-create", evtHandler);
    return () => {
      document.removeEventListener("click", clickHandler);
      window.removeEventListener("forge:quick-create", evtHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Global Escape: close the floating input. Clicks outside also close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        close(true);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDocClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [open, close]);

  // Autofocus input when we open.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, mode.kind]);

  // ----- mode metadata ---------------------------------------------

  const modeLabel = useMemo(() => {
    switch (mode.kind) {
      case "issue":
        return "Issue";
      case "cycle":
        return "Sprint";
      case "initiative":
        return "Initiative";
      case "project":
        return "Project";
      case "issue-context":
        return mode.intent === "comment" ? "Comment" : "Sub-issue";
    }
  }, [mode]);

  const placeholder = useMemo(() => {
    switch (mode.kind) {
      case "issue":
        return "Issue title… (⌘⏎ create + open)";
      case "cycle":
        return "Sprint name… (⌘⏎ more options)";
      case "initiative":
        return "Initiative name… (⌘⏎ more options)";
      case "project":
        return "Project name… (⌘⏎ more options)";
      case "issue-context":
        return mode.intent === "comment"
          ? "Write a comment… (⏎ post)"
          : "Sub-issue title… (⏎ create)";
    }
  }, [mode]);

  // Some modes escalate on ⌘⏎; others have a real secondary action.
  const hasEscalation =
    mode.kind === "cycle" ||
    mode.kind === "initiative" ||
    mode.kind === "project";
  const secondaryHint = hasEscalation
    ? "⌘⏎ more options"
    : mode.kind === "issue"
    ? "⌘⏎ create + open"
    : null;

  // ----- submit ----------------------------------------------------

  async function submit(secondary: boolean) {
    const value = text.trim();
    if (!value) return;
    if (busy) return;

    // Shared success: toast + close + clear draft + invalidate.
    const done = (msg: string) => {
      toast.success(msg);
      clearDraft(DRAFT_KEY);
      close(false);
    };

    try {
      switch (mode.kind) {
        case "issue": {
          // Pull leading slash commands out of the value. For the
          // single-line QuickCreate input, this lets users type
          // "/priority high\nFix the bug" or just put commands at the
          // start of the title field. The stripped tail becomes the
          // title; if the tail is empty (only commands typed) we
          // bail with a clear toast.
          const { strippedBody, commands } = parseSlashCommands(value);
          const finalTitle = strippedBody.trim();
          if (!finalTitle) {
            toast.error("Title required after slash commands.");
            return;
          }
          const applyCommands = commands.length > 0 ? commands : undefined;
          // Seed description (note → issue path). If empty after trim,
          // stay omitted so we don't write blank descriptions.
          const seededDesc = seedDescription.trim() || undefined;
          // Capture the archive intent before close() resets state.
          const archiveTargetNoteId =
            archiveNoteId && archiveOnCreate ? archiveNoteId : null;
          if (secondary) {
            // Create + open: same as primary but route to the new issue.
            const issue = await createIssue.mutateAsync({
              title: finalTitle,
              description: seededDesc,
              projectId: projectId || undefined,
              priority,
              labelIds: [],
              applyCommands,
            });
            await utils.issue.list.invalidate();
            if (archiveTargetNoteId) {
              archiveNote.mutate({ id: archiveTargetNoteId });
            }
            done(`Created #${issue.number}`);
            const base = ws ? `/w/${ws.slug}` : "";
            router.push(`${base}/issues/${issue.id}`);
          } else {
            const issue = await createIssue.mutateAsync({
              title: finalTitle,
              description: seededDesc,
              projectId: projectId || undefined,
              priority,
              labelIds: [],
              applyCommands,
            });
            await utils.issue.list.invalidate();
            if (archiveTargetNoteId) {
              archiveNote.mutate({ id: archiveTargetNoteId });
            }
            done(`Created #${issue.number}`);
          }
          return;
        }
        case "cycle": {
          if (secondary) {
            // Escalate: open full form with name seeded.
            setFullForm({ kind: "cycle", name: value });
            setOpen(false);
            return;
          }
          await createCycle.mutateAsync({ name: value });
          await utils.cycle.list.invalidate();
          done("Sprint created.");
          return;
        }
        case "initiative": {
          if (secondary) {
            setFullForm({ kind: "initiative", name: value });
            setOpen(false);
            return;
          }
          await createInitiative.mutateAsync({ name: value });
          await utils.initiative.list.invalidate();
          done("Initiative created.");
          return;
        }
        case "project": {
          if (secondary) {
            setFullForm({ kind: "project", name: value });
            setOpen(false);
            return;
          }
          // Derive a reasonable project key from the name (same logic as
          // NewProjectDialog's suggestion).
          const suggestedKey = value
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 3)
            .map((w) => w[0]?.toUpperCase() ?? "")
            .join("")
            .slice(0, 6);
          const key = suggestedKey.length >= 2 ? suggestedKey : value
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 4) || "PRJ";
          await createProject.mutateAsync({ name: value, key });
          await utils.project.list.invalidate();
          done("Project created.");
          return;
        }
        case "issue-context": {
          if (mode.intent === "comment") {
            await createComment.mutateAsync({
              issueId: mode.issueId,
              body: value,
            });
            await utils.issue.byId.invalidate({ id: mode.issueId });
            await utils.issue.activity.invalidate({ issueId: mode.issueId });
            done("Comment added.");
          } else {
            const { strippedBody, commands } = parseSlashCommands(value);
            const finalTitle = strippedBody.trim();
            if (!finalTitle) {
              toast.error("Title required after slash commands.");
              return;
            }
            const issue = await createIssue.mutateAsync({
              title: finalTitle,
              projectId: contextIssue?.projectId ?? undefined,
              parentId: mode.issueId,
              priority,
              labelIds: [],
              applyCommands: commands.length > 0 ? commands : undefined,
            });
            await utils.issue.list.invalidate();
            done(`Created sub-issue #${issue.number}`);
          }
          return;
        }
      }
    } catch {
      // mutation's onError already surfaced a toast
    }
  }

  // Slash autocomplete for issue / sub-issue modes. When the user types
  // a top-of-body slash command, surface the dropdown so they can pick
  // by keyword. Only enabled where commands actually parse.
  const slashEnabled =
    mode.kind === "issue" ||
    (mode.kind === "issue-context" && mode.intent === "sub-issue");
  const slash = useSlashAutocomplete({
    value: text,
    onChange: (next) => setText(next),
    textareaRef: inputRef,
  });

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Let the autocomplete consume nav / Enter / Tab / Escape first
    // when it's open. When it returns true, we bail before running the
    // QuickCreate Enter-to-submit shortcut so users can pick items
    // without firing a create.
    if (slashEnabled && slash.onKeyDown(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const secondary = e.metaKey || e.ctrlKey;
      void submit(secondary);
    }
  }

  // ----- render ----------------------------------------------------

  // Full-form escalation takes over when open.
  if (fullForm) {
    if (fullForm.kind === "cycle") {
      return (
        <NewCycleDialog
          open={true}
          onClose={() => setFullForm(null)}
        />
      );
    }
    if (fullForm.kind === "initiative") {
      return (
        <NewInitiativeDialog
          open={true}
          onClose={() => setFullForm(null)}
        />
      );
    }
    if (fullForm.kind === "project") {
      return (
        <NewProjectDialog
          open={true}
          onClose={() => setFullForm(null)}
        />
      );
    }
  }

  if (!open) return null;

  return (
    <div
      // Wrap the floating bar so it anchors to the top of the viewport
      // without capturing clicks on the surrounding page (the bar itself
      // handles outside-click close via the mousedown listener above).
      className="pointer-events-none fixed inset-x-0 top-[18vh] z-40 flex justify-center px-4"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-label={`Quick-create ${modeLabel}`}
        className={cn(
          "pointer-events-auto w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-card/95 shadow-xl backdrop-blur",
          MOTION.slideInTop,
        )}
      >
        {/* Top row: mode chip + input + hint */}
        <div className="flex items-center gap-2 px-3 py-3">
          <ModeChip
            mode={mode}
            onToggleIntent={() => {
              if (mode.kind !== "issue-context") return;
              setMode({
                ...mode,
                intent: mode.intent === "comment" ? "sub-issue" : "comment",
              });
            }}
            onSwitch={(kind) => {
              // Switching modes resets per-mode pickers (priority + project)
              // so a stale priority chip doesn't follow you from issue → sprint.
              if (mode.kind === "issue-context") return;
              setMode({ kind } as Mode);
              setPriority("NONE");
              setProjectId("");
            }}
          />
          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              {...(slashEnabled ? slash.bind : {})}
              placeholder={placeholder}
              aria-label={`Quick-create ${modeLabel}`}
              autoComplete="off"
              className="focus-ring w-full bg-transparent px-1 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {slashEnabled && slash.visible && (
              <SlashAutocomplete {...slash.dropdownProps} />
            )}
          </div>
          {restored && (
            <span className="hidden shrink-0 rounded-md border border-ember/30 bg-ember/10 px-1.5 py-0.5 font-mono text-[0.6875rem] uppercase tracking-wider text-ember sm:inline">
              Restored
            </span>
          )}
          {secondaryHint && (
            <span className="hidden shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground sm:inline-flex">
              <Kbd>⌘⏎</Kbd>
              <span>{secondaryHint.replace("⌘⏎ ", "")}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={!text.trim() || busy}
            className={cn(
              "focus-ring inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-ember px-2.5 py-1 text-xs font-medium text-ember-foreground hover:bg-ember/90 disabled:pointer-events-none disabled:opacity-40",
              MOTION.fast,
            )}
          >
            {busy ? "…" : "Create"}
            <Kbd className="border-ember-foreground/30 bg-ember-foreground/10 text-ember-foreground/80">
              ⏎
            </Kbd>
          </button>
        </div>

        {/* Slash hint — render only for issue / sub-issue (commands
            don't apply to plain comments or to cycles/projects). */}
        {(mode.kind === "issue" ||
          (mode.kind === "issue-context" && mode.intent === "sub-issue")) && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-card/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
            <span className="font-mono uppercase tracking-wider opacity-70">
              slash
            </span>
            {SLASH_COMMAND_HELP.slice(0, 6).map((c) => (
              <span
                key={c.keyword}
                className="rounded bg-subtle/50 px-1.5 py-0.5 font-mono"
                title={`Example: ${c.example}`}
              >
                {c.keyword}
              </span>
            ))}
          </div>
        )}

        {/* Seeded description — shown when QuickCreate was opened with
            an external `forge:quick-create` event carrying `body` (e.g.
            note → issue convert). The textarea is editable so the
            operator can trim before submitting. */}
        {showDescription && mode.kind === "issue" && (
          <div className="border-t border-border/60 bg-card/30 px-3 py-2">
            <label className="block">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                Description
              </span>
              <textarea
                value={seedDescription}
                onChange={(e) => setSeedDescription(e.target.value)}
                rows={4}
                className="focus-ring mt-1 w-full resize-y rounded-md border border-input bg-background/40 p-2 text-[0.8125rem] placeholder:text-muted-foreground/60 focus:outline-none"
                placeholder="Description (markdown ok)…"
              />
            </label>
            {archiveNoteId && (
              <label className="mt-1.5 inline-flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={archiveOnCreate}
                  onChange={(e) => setArchiveOnCreate(e.target.checked)}
                  className="h-3 w-3 rounded border-border"
                />
                <span>Archive source note after creating issue</span>
              </label>
            )}
          </div>
        )}

        {/* Secondary row: priority chips (issue) / intent tabs (issue-context) */}
        {(mode.kind === "issue" ||
          mode.kind === "issue-context") && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-card/50 px-3 py-2 text-[0.6875rem]">
            {mode.kind === "issue-context" && (
              <>
                <IntentChip
                  selected={mode.intent === "comment"}
                  onClick={() =>
                    setMode({ ...mode, intent: "comment" })
                  }
                  label="Comment"
                />
                <IntentChip
                  selected={mode.intent === "sub-issue"}
                  onClick={() =>
                    setMode({ ...mode, intent: "sub-issue" })
                  }
                  label="Sub-issue"
                />
                {mode.intent === "sub-issue" && contextIssue && (
                  <span className="ml-1 truncate text-muted-foreground">
                    parent:{" "}
                    <span className="font-mono text-foreground">
                      {contextIssue.title}
                    </span>
                  </span>
                )}
              </>
            )}

            {mode.kind === "issue" && (
              <>
                {PRIORITIES.map((p) => (
                  <PriorityChip
                    key={p}
                    selected={priority === p}
                    label={p}
                    onClick={() => setPriority(p)}
                  />
                ))}
                {projects && projects.items.length > 0 && (
                  <>
                    <span className="mx-1 h-3 w-px bg-border" aria-hidden />
                    <select
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      aria-label="Project"
                      className="focus-ring h-6 max-w-[180px] truncate rounded-md border border-border bg-background px-1.5 text-[0.6875rem] text-foreground"
                    >
                      <option value="">No project</option>
                      {projects.items.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </>
            )}

            <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
              <Kbd>⎋</Kbd> close
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

type SwitchableMode = "issue" | "cycle" | "project" | "initiative";

const SWITCHABLE_MODES: { kind: SwitchableMode; label: string }[] = [
  { kind: "issue", label: "Issue" },
  { kind: "cycle", label: "Sprint" },
  { kind: "project", label: "Project" },
  { kind: "initiative", label: "Initiative" },
];

function ModeChip({
  mode,
  onToggleIntent,
  onSwitch,
}: {
  mode: Mode;
  onToggleIntent: () => void;
  onSwitch: (kind: SwitchableMode) => void;
}) {
  const label =
    mode.kind === "issue"
      ? "Issue"
      : mode.kind === "cycle"
      ? "Sprint"
      : mode.kind === "initiative"
      ? "Initiative"
      : mode.kind === "project"
      ? "Project"
      : mode.intent === "comment"
      ? "Comment"
      : "Sub-issue";

  const isIssueContext = mode.kind === "issue-context";
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click. The parent's outside-click handler closes the
  // overlay entirely; stopping propagation on dropdown clicks keeps that
  // behavior from firing while the dropdown is open.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Issue-context mode: chip toggles comment ↔ sub-issue (legacy behavior).
  if (isIssueContext) {
    return (
      <button
        type="button"
        onClick={onToggleIntent}
        aria-label="Toggle comment / sub-issue"
        className="focus-ring shrink-0 cursor-pointer rounded-md border border-border/70 bg-subtle/70 px-2 py-1 font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground hover:bg-subtle"
      >
        {label}
      </button>
    );
  }

  // Switchable: real dropdown listing the four creation modes.
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch what to create"
        className="focus-ring inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-subtle/70 px-2 py-1 font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground hover:bg-subtle"
      >
        <span>{label}</span>
        <ChevronDown className="h-2.5 w-2.5 opacity-70" aria-hidden />
      </button>
      {open && (
        <div
          // Stop the parent's mousedown-outside from closing the overlay
          // when the user clicks an item in the popover.
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute left-0 top-[calc(100%+4px)] z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover shadow-sm"
        >
          <ul role="listbox" className="py-1">
            {SWITCHABLE_MODES.map((opt) => {
              const selected = mode.kind === opt.kind;
              return (
                <li key={opt.kind}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setOpen(false);
                      if (!selected) onSwitch(opt.kind);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-subtle",
                      selected && "bg-subtle/60 text-foreground",
                    )}
                  >
                    <span className="flex-1 truncate">{opt.label}</span>
                    {selected && <span className="text-ember">✓</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function PriorityChip({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "focus-ring rounded px-1.5 py-0.5 font-mono text-[0.6875rem] uppercase tracking-wider transition-colors",
        selected
          ? "bg-ember/15 text-ember"
          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function IntentChip({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "focus-ring rounded px-2 py-0.5 transition-colors",
        selected
          ? "bg-subtle text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
