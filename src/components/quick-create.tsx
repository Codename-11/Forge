"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Check, ChevronDown, CornerDownLeft, X } from "lucide-react";
import { toast } from "sonner";
import { ArtifactType, NotificationSeverity } from "@prisma/client";
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
  matchTrailingCommand,
  parseSlashCommands,
  SLASH_COMMAND_HELP,
  type SlashCommand,
} from "@/lib/slash-commands";
import {
  SlashAutocomplete,
  useSlashAutocomplete,
} from "@/components/slash-autocomplete";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

const SEVERITIES = [
  NotificationSeverity.INFO,
  NotificationSeverity.WARNING,
  NotificationSeverity.ERROR,
  NotificationSeverity.CRITICAL,
] as const;

// Map a slash `/priority <level>` token onto the native priority chip value.
const LEVEL_TO_PRIORITY: Record<string, Priority> = {
  urgent: "URGENT",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  none: "NONE",
};

// Short, human label for a committed slash command rendered as a chip.
function commandChipLabel(c: SlashCommand): string {
  switch (c.kind) {
    case "assign":
      return `@${c.handle}`;
    case "due":
      return `due ${c.date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`;
    case "label":
      return c.name;
    case "project":
      return c.key;
    case "watch":
      return "watching";
    case "unwatch":
      return "unwatch";
    case "priority":
      return `!${c.level}`;
  }
}

// Stable identity for a committed command — used both as a React key and
// to remove a specific chip. Labels are de-duped on insert, so the
// (kind,label) pair is unique within `committed`.
function commandKey(c: SlashCommand): string {
  return `${c.kind}:${commandChipLabel(c)}`;
}

type Mode =
  | { kind: "issue" }
  | { kind: "cycle" }
  | { kind: "initiative" }
  | { kind: "project" }
  | { kind: "note" }
  | { kind: "artifact" }
  | { kind: "action-request" }
  | { kind: "issue-context"; issueId: string; intent: "comment" | "sub-issue" };

const DRAFT_KEY = "quickCreate";

// Cyclable mode order for Tab / Shift+Tab / ⌘1..⌘7 mode jumping.
// Ordered by how often operators reach for each capture target —
// issue first, then notes, then the planning surfaces, then artifacts
// and action-requests. `issue-context` is excluded because it's
// driven by the current URL, not by user choice.
type CyclableMode = "issue" | "note" | "project" | "initiative" | "cycle" | "artifact" | "action-request";
const CYCLABLE_MODES: readonly CyclableMode[] = [
  "issue",
  "note",
  "project",
  "initiative",
  "cycle",
  "artifact",
  "action-request",
] as const;
const CYCLABLE_MODE_LABEL: Record<CyclableMode, string> = {
  issue: "issue",
  note: "note",
  project: "project",
  initiative: "initiative",
  cycle: "sprint",
  artifact: "artifact",
  "action-request": "ask",
};

type DraftShape = {
  text: string;
  mode?: Mode["kind"];
};

/**
 * Context-aware capture. `⇧C` opens a Linear-style floating input at the
 * top of the viewport — single line, fast, keyboard-first. The container
 * is NOT a modal: it doesn't dim the page, and clicking outside simply
 * closes. The mode dropdown spans the full agentic-work-OS surface so any
 * intent (issue / sprint / project / initiative / note / artifact /
 * action request) can be captured without navigating first.
 *
 * Pathname determines the *initial* mode (set when the overlay opens):
 *
 *   /w/*\/cycles           → "cycle"          (⏎ create · ⌘⏎ full form)
 *   /w/*\/initiatives      → "initiative"     (⏎ create · ⌘⏎ full form)
 *   /w/*\/projects         → "project"        (⏎ create · ⌘⏎ full form)
 *   /w/*\/artifacts        → "artifact"       (⏎ create · ⌘⏎ create + open)
 *   /w/*\/issues/:id       → "issue-context"  (comment | sub-issue tabs)
 *   anywhere else          → "issue"          (⏎ create · ⌘⏎ create + open)
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
  // Slash commands the operator has "committed" into chips: assign / due /
  // label / watch / unwatch (and any /project whose key didn't resolve to a
  // loaded project). Priority + a resolved project sync onto the native
  // controls instead, so the visible pickers always reflect the command.
  const [committed, setCommitted] = useState<SlashCommand[]>([]);
  const [restored, setRestored] = useState(false);
  // Per-mode extras for the new agentic-OS destinations.
  const [artifactType, setArtifactType] = useState<ArtifactType>(
    ArtifactType.DOCUMENT,
  );
  const [severity, setSeverity] = useState<NotificationSeverity>(
    NotificationSeverity.INFO,
  );

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
  const createNote = trpc.note.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const createArtifact = trpc.artifact.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const createActionRequest = trpc.actionRequest.create.useMutation({
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
    createProject.isPending ||
    createNote.isPending ||
    createArtifact.isPending ||
    createActionRequest.isPending;

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
    if (tail === "/artifacts" || tail.startsWith("/artifacts?") || tail.startsWith("/artifacts/"))
      return { kind: "artifact" };
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
      setCommitted([]);
      setRestored(false);
      setSeedDescription("");
      setShowDescription(false);
      setArchiveNoteId(null);
      setArchiveOnCreate(true);
      setArtifactType(ArtifactType.DOCUMENT);
      setSeverity(NotificationSeverity.INFO);
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
      case "note":
        return "Note";
      case "artifact":
        return "Artifact";
      case "action-request":
        return "Action request";
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
      case "note":
        return "Note (one-liner; ⌘⏎ to add description)";
      case "artifact":
        return "Artifact title… (⌘⏎ create + open)";
      case "action-request":
        return "What do you need from someone? (⌘⏎ add description)";
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
    : mode.kind === "issue" || mode.kind === "artifact"
    ? "⌘⏎ create + open"
    : mode.kind === "note" || mode.kind === "action-request"
    ? "⌘⏎ add description"
    : null;

  // Compose the final issue input from the raw title + committed chips +
  // any command still trailing in the title. Returns the cleaned title,
  // the merged `applyCommands` list, and the resolved priority / project
  // (a /priority or resolvable /project syncs onto these rather than
  // riding along as a command).
  function resolveIssueComposition(raw: string): {
    finalTitle: string;
    applyCommands: SlashCommand[] | undefined;
    priorityValue: Priority;
    projectIdValue: string;
  } {
    let working = raw;
    let priorityValue = priority;
    let projectIdValue = projectId;
    const flushed: SlashCommand[] = [];
    const trailing = matchTrailingCommand(working);
    if (trailing) {
      working = working.slice(0, trailing.start).replace(/\s+$/, "");
      const c = trailing.command;
      if (c.kind === "priority") {
        priorityValue = LEVEL_TO_PRIORITY[c.level] ?? priorityValue;
      } else if (c.kind === "project") {
        const match = projects?.items.find(
          (p) => p.key.toUpperCase() === c.key.toUpperCase(),
        );
        if (match) projectIdValue = match.id;
        else flushed.push(c);
      } else {
        flushed.push(c);
      }
    }
    const { strippedBody, commands: leadingCommands } =
      parseSlashCommands(working);
    const all = [...committed, ...leadingCommands, ...flushed];
    return {
      finalTitle: strippedBody.trim(),
      applyCommands: all.length > 0 ? all : undefined,
      priorityValue,
      projectIdValue,
    };
  }

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
          // Resolve title + commands. Most commands have already been
          // committed into chips (priority/project synced onto the native
          // pickers, the rest in `committed`), but the operator may have a
          // trailing command still in the title (clicked Create / hit ⌘⏎
          // before pressing ⏎ to commit it) — flush it here. Any
          // leading-line command is also extracted for safety. If the
          // title is empty after stripping, bail with a clear toast.
          const resolved = resolveIssueComposition(value);
          if (!resolved.finalTitle) {
            toast.error("Title required after slash commands.");
            return;
          }
          const { finalTitle, applyCommands, priorityValue, projectIdValue } =
            resolved;
          // Seed description (note → issue path). If empty after trim,
          // stay omitted so we don't write blank descriptions.
          const seededDesc = seedDescription.trim() || undefined;
          // Capture the archive intent before close() resets state.
          const archiveTargetNoteId =
            archiveNoteId && archiveOnCreate ? archiveNoteId : null;
          const issue = await createIssue.mutateAsync({
            title: finalTitle,
            description: seededDesc,
            projectId: projectIdValue || undefined,
            priority: priorityValue,
            labelIds: [],
            applyCommands,
          });
          await utils.issue.list.invalidate();
          if (archiveTargetNoteId) {
            archiveNote.mutate({ id: archiveTargetNoteId });
          }
          done(`Created #${issue.number}`);
          if (secondary) {
            const base = ws ? `/w/${ws.slug}` : "";
            router.push(`${base}/issues/${issue.id}`);
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
        case "note": {
          // Single-line text becomes body; if a description was
          // expanded via ⌘⏎ we use that as body and keep `value` as
          // the title (matches the note router's nullable title).
          if (secondary && !showDescription) {
            setShowDescription(true);
            return;
          }
          const titleVal = showDescription ? value : null;
          const bodyVal = showDescription
            ? seedDescription.trim()
            : value;
          if (!bodyVal) {
            toast.error("Note body required.");
            return;
          }
          await createNote.mutateAsync({
            title: titleVal ?? undefined,
            body: bodyVal,
          });
          await utils.note.list.invalidate();
          done("Note created.");
          return;
        }
        case "artifact": {
          const created = await createArtifact.mutateAsync({
            title: value,
            body: showDescription ? seedDescription : "",
            type: artifactType,
          });
          await utils.artifact.list.invalidate();
          done("Artifact created.");
          if (secondary || showDescription) {
            const base = ws ? `/w/${ws.slug}` : "";
            router.push(`${base}/artifacts/${created.slug}`);
          }
          return;
        }
        case "action-request": {
          if (secondary && !showDescription) {
            setShowDescription(true);
            return;
          }
          await createActionRequest.mutateAsync({
            title: value,
            body: seedDescription.trim() ? seedDescription : null,
            severity,
          });
          await utils.actionRequest.list.invalidate();
          done("Action request opened.");
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
            const resolved = resolveIssueComposition(value);
            if (!resolved.finalTitle) {
              toast.error("Title required after slash commands.");
              return;
            }
            const issue = await createIssue.mutateAsync({
              title: resolved.finalTitle,
              // Sub-issues inherit the parent's project; a resolved
              // /project on the sub-issue is ignored, but an unresolved one
              // still rides along in applyCommands for the server to apply.
              projectId: contextIssue?.projectId ?? undefined,
              parentId: mode.issueId,
              priority: resolved.priorityValue,
              labelIds: [],
              applyCommands: resolved.applyCommands,
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

  // Apply one parsed slash command. Priority + a resolvable project key
  // sync onto the native pickers (so the chip / select visibly updates);
  // everything else lands in `committed` as a removable chip. Re-applying
  // a single-valued command (assign / due / project / watch|unwatch)
  // replaces the prior one; labels accumulate (de-duped by name).
  const applyCommand = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.kind === "priority") {
        setPriority(LEVEL_TO_PRIORITY[cmd.level] ?? "NONE");
        return;
      }
      if (cmd.kind === "project") {
        const match = projects?.items.find(
          (p) => p.key.toUpperCase() === cmd.key.toUpperCase(),
        );
        if (match) {
          setProjectId(match.id);
          return;
        }
        // Unknown / not-yet-loaded key — keep it as a chip; the server
        // resolves it by key on create.
        setCommitted((prev) => [
          ...prev.filter((c) => c.kind !== "project"),
          cmd,
        ]);
        return;
      }
      setCommitted((prev) => {
        if (cmd.kind === "label") {
          const dup = prev.some(
            (c) =>
              c.kind === "label" &&
              c.name.toLowerCase() === cmd.name.toLowerCase(),
          );
          return dup ? prev : [...prev, cmd];
        }
        if (cmd.kind === "watch" || cmd.kind === "unwatch") {
          return [
            ...prev.filter((c) => c.kind !== "watch" && c.kind !== "unwatch"),
            cmd,
          ];
        }
        // assign / due — single-valued.
        return [...prev.filter((c) => c.kind !== cmd.kind), cmd];
      });
    },
    [projects],
  );

  // Commit a trailing `/command arg` in the title into a chip, stripping
  // it (and the whitespace before it) from the title. Returns true when a
  // command was committed. Bound to Enter in the title input.
  const tryCommitTrailing = useCallback((): boolean => {
    const m = matchTrailingCommand(text);
    if (!m) return false;
    applyCommand(m.command);
    setText(text.slice(0, m.start).replace(/\s+$/, ""));
    return true;
  }, [text, applyCommand]);

  const removeCommitted = useCallback((key: string) => {
    setCommitted((prev) => prev.filter((c) => commandKey(c) !== key));
  }, []);

  // Live "this tail is a valid command" detection — drives the inline
  // "↵ apply …" hint so the operator sees the command is recognised
  // before committing it.
  const pendingCommand = useMemo(
    () => (slashEnabled ? matchTrailingCommand(text) : null),
    [slashEnabled, text],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const secondary = e.metaKey || e.ctrlKey;
      // Plain ⏎ with a recognised command at the end of the title commits
      // it into a chip and stays open (the title keeps just the prose).
      // ⌘/Ctrl+⏎ skips straight to create+open — submit() flushes any
      // trailing command itself, so nothing is lost.
      if (!secondary && slashEnabled && tryCommitTrailing()) return;
      // Mid-keyword (e.g. "/assi") with the dropdown open: let it insert
      // the stub rather than submitting an incomplete command.
      if (slashEnabled && slash.visible && slash.onKeyDown(e)) return;
      void submit(secondary);
      return;
    }
    // Arrow / Tab / Escape → autocomplete navigation while it's open.
    if (slashEnabled && slash.onKeyDown(e)) return;
    // Tab / Shift+Tab cycles through cyclable modes — issue-context
    // is sticky so users navigating from a `/issues/:id` page don't
    // get bumped out of the comment/sub-issue flow by stray Tab.
    if (e.key === "Tab" && mode.kind !== "issue-context") {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const idx = CYCLABLE_MODES.indexOf(mode.kind as CyclableMode);
      const next = CYCLABLE_MODES[(idx + dir + CYCLABLE_MODES.length) % CYCLABLE_MODES.length];
      setMode({ kind: next } as Mode);
      setPriority("NONE");
      setProjectId("");
      setCommitted([]);
      return;
    }
    // ⌘1..⌘7 jump straight to a mode without dragging through the
    // dropdown — fastest path for muscle memory.
    if ((e.metaKey || e.ctrlKey) && /^[1-7]$/.test(e.key) && mode.kind !== "issue-context") {
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < CYCLABLE_MODES.length) {
        e.preventDefault();
        setMode({ kind: CYCLABLE_MODES[idx] } as Mode);
        setPriority("NONE");
        setProjectId("");
        setCommitted([]);
      }
      return;
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
          "pointer-events-auto w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur",
          MOTION.slideInTop,
        )}
      >
        {/* Top row: mode chip + input + hint */}
        <div className="flex items-center gap-2.5 px-4 py-3.5">
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
              // Switching modes resets per-mode pickers (priority + project +
              // committed slash chips) so stale state doesn't follow you
              // from issue → sprint.
              if (mode.kind === "issue-context") return;
              setMode({ kind } as Mode);
              setPriority("NONE");
              setProjectId("");
              setCommitted([]);
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
          {/* Live "valid command" hint — shows the moment the tail of the
              title parses as a recognised command, so ⏎ visibly "applies"
              it into a chip instead of creating. Takes precedence over the
              ⌘⏎ secondary hint while a command is pending. */}
          {pendingCommand ? (
            <span className="hidden shrink-0 items-center gap-1 rounded-md border border-ember/40 bg-ember/10 px-1.5 py-0.5 text-[0.6875rem] text-ember sm:inline-flex">
              <CornerDownLeft className="h-3 w-3" aria-hidden />
              <span>apply</span>
              <span className="font-mono">
                {commandChipLabel(pendingCommand.command)}
              </span>
            </span>
          ) : (
            secondaryHint && (
              <span className="hidden shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground sm:inline-flex">
                <Kbd>⌘⏎</Kbd>
                <span>{secondaryHint.replace("⌘⏎ ", "")}</span>
              </span>
            )
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

        {/* Mode pill row — Tab / Shift+Tab to cycle, ⌘1..⌘7 to jump.
            Hidden in issue-context since that mode is URL-driven and
            shouldn't be cycled off accidentally. */}
        {mode.kind !== "issue-context" && (
          <div className="flex flex-wrap items-center gap-1 border-t border-border/60 bg-card/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
            <span className="font-mono uppercase tracking-wider opacity-70">modes</span>
            {CYCLABLE_MODES.map((m, idx) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode({ kind: m } as Mode);
                  setPriority("NONE");
                  setProjectId("");
                  setCommitted([]);
                  inputRef.current?.focus();
                }}
                className={cn(
                  "focus-ring inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
                  mode.kind === m
                    ? "bg-card text-foreground"
                    : "text-muted-foreground hover:bg-subtle/50 hover:text-foreground",
                )}
              >
                <span className="capitalize">{CYCLABLE_MODE_LABEL[m]}</span>
                <Kbd className="opacity-60">⌘{idx + 1}</Kbd>
              </button>
            ))}
            <span className="ml-auto inline-flex items-center gap-1 opacity-70">
              <Kbd>Tab</Kbd>
              <span>cycle</span>
            </span>
          </div>
        )}

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

        {/* Body / description textarea — used for:
            - issue mode when seeded from a "Convert to issue" event;
            - note/artifact/action-request modes when the user expands
              the secondary description via ⌘⏎. The textarea is editable
              so operators can trim or extend before submitting. */}
        {showDescription &&
          (mode.kind === "issue" ||
            mode.kind === "note" ||
            mode.kind === "artifact" ||
            mode.kind === "action-request") && (
          <div className="border-t border-border/60 bg-card/30 px-3 py-2">
            <label className="block">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                Description
              </span>
              <textarea
                value={seedDescription}
                onChange={(e) => setSeedDescription(e.target.value)}
                onKeyDown={(e) => {
                  // Match the title input's keymap: ⏎ submits primary,
                  // ⌘/Ctrl+⏎ submits secondary (create + open). Inside a
                  // textarea we require a modifier for both so plain ⏎
                  // still inserts newlines for description paragraphs.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit(true);
                  } else if (e.key === "Enter" && e.shiftKey === false && (e.altKey)) {
                    // (Alt+Enter unused — leave for future use.)
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    close(true);
                  }
                }}
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

        {/* Secondary row: per-mode chips. Issue → priority + project,
            issue-context → comment/sub-issue intent, artifact → type
            picker, action-request → severity. */}
        {(mode.kind === "issue" ||
          mode.kind === "issue-context" ||
          mode.kind === "artifact" ||
          mode.kind === "action-request") && (
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
                {mode.intent === "sub-issue" && (
                  <CommittedChips
                    committed={committed}
                    onRemove={removeCommitted}
                  />
                )}
              </>
            )}

            {mode.kind === "issue" && (
              <>
                <span className="mr-0.5 font-mono uppercase tracking-wider opacity-70">
                  priority
                </span>
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
                    <ProjectPickerChip
                      projects={projects.items}
                      value={projectId}
                      onChange={setProjectId}
                    />
                  </>
                )}
                <CommittedChips committed={committed} onRemove={removeCommitted} />
              </>
            )}

            {mode.kind === "artifact" && (
              <>
                <span className="mr-1 font-mono uppercase tracking-wider opacity-70">
                  type
                </span>
                {Object.values(ArtifactType).map((t) => (
                  <PriorityChip
                    key={t}
                    selected={artifactType === t}
                    label={t}
                    onClick={() => setArtifactType(t)}
                  />
                ))}
              </>
            )}

            {mode.kind === "action-request" && (
              <>
                <span className="mr-1 font-mono uppercase tracking-wider opacity-70">
                  severity
                </span>
                {SEVERITIES.map((s) => (
                  <PriorityChip
                    key={s}
                    selected={severity === s}
                    label={s}
                    onClick={() => setSeverity(s)}
                  />
                ))}
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

type SwitchableMode =
  | "issue"
  | "cycle"
  | "project"
  | "initiative"
  | "note"
  | "artifact"
  | "action-request";

export const SWITCHABLE_MODES: { kind: SwitchableMode; label: string }[] = [
  { kind: "issue", label: "Issue" },
  { kind: "cycle", label: "Sprint" },
  { kind: "project", label: "Project" },
  { kind: "initiative", label: "Initiative" },
  { kind: "note", label: "Note" },
  { kind: "artifact", label: "Artifact" },
  { kind: "action-request", label: "Action req." },
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
      : mode.kind === "note"
      ? "Note"
      : mode.kind === "artifact"
      ? "Artifact"
      : mode.kind === "action-request"
      ? "Action req."
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

/**
 * Themed project picker for the create overlay — replaces a native
 * `<select>` so it matches the warm-earthy chip language of the rest of
 * the row (a coloured dot + name, ember tint when set). Mirrors the
 * ModeChip dropdown mechanics (outside-click close + stopPropagation so
 * picking an item doesn't dismiss the overlay).
 */
function ProjectPickerChip({
  projects,
  value,
  onChange,
}: {
  projects: { id: string; name: string; color?: string | null }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = projects.find((p) => p.id === value) ?? null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Project"
        className={cn(
          "focus-ring inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] transition-colors",
          selected
            ? "border-ember/50 bg-ember/10 text-foreground"
            : "border-border bg-background/60 text-muted-foreground hover:bg-subtle/60",
        )}
      >
        {selected?.color && (
          <span
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ backgroundColor: selected.color }}
            aria-hidden
          />
        )}
        <span className="max-w-[160px] truncate">
          {selected ? selected.name : "No project"}
        </span>
        <ChevronDown className="h-2.5 w-2.5 opacity-70" aria-hidden />
      </button>
      {open && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute left-0 top-[calc(100%+4px)] z-50 max-h-64 min-w-[200px] overflow-y-auto rounded-md border border-border bg-popover shadow-sm"
        >
          <ul role="listbox" className="py-1">
            <ProjectOption
              label="No project"
              selected={!value}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            />
            {projects.map((p) => (
              <ProjectOption
                key={p.id}
                label={p.name}
                color={p.color}
                selected={value === p.id}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProjectOption({
  label,
  selected,
  onClick,
  color,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  color?: string | null;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-subtle",
          selected && "bg-subtle/60 text-foreground",
        )}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ backgroundColor: color ?? "transparent" }}
          aria-hidden
        />
        <span className="flex-1 truncate">{label}</span>
        {selected && <Check className="h-3 w-3 text-ember" aria-hidden />}
      </button>
    </li>
  );
}

/**
 * Committed slash-command chips (assign / due / label / watch / unwatch,
 * plus any unresolved /project). Each is removable with the × — the
 * source of truth is the parent's `committed` array. Priority + a
 * resolvable project never appear here; they sync onto the native
 * controls instead.
 */
function CommittedChips({
  committed,
  onRemove,
}: {
  committed: SlashCommand[];
  onRemove: (key: string) => void;
}) {
  if (committed.length === 0) return null;
  return (
    <>
      {committed.map((c) => {
        const key = commandKey(c);
        const text = commandChipLabel(c);
        return (
          <span
            key={key}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-ember/40 bg-ember/10 px-1.5 text-[0.6875rem] text-foreground"
          >
            <span className="max-w-[140px] truncate">{text}</span>
            <button
              type="button"
              aria-label={`Remove ${text}`}
              onClick={() => onRemove(key)}
              className="focus-ring -mr-0.5 rounded p-0.5 text-muted-foreground hover:bg-ember/20 hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" aria-hidden />
            </button>
          </span>
        );
      })}
    </>
  );
}
