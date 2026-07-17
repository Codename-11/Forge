"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "next/navigation";
import {
  AlertCircle,
  Calendar,
  ChevronDown,
  CornerDownLeft,
  Github,
  GitPullRequest,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ArtifactType, NotificationSeverity } from "@prisma/client";
import { cn } from "@/lib/utils";
import { parseGitHubIssueOrPrRef } from "@/lib/github-ref";
import { MOTION } from "@/lib/motion";
import { Kbd } from "@/components/ui/kbd";
import { useHotkey } from "@/lib/keyboard";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { clearDraft, readDraft, saveDraft } from "@/components/ui/modal/draft";
import { NewCycleDialog } from "@/components/cycles/new-cycle-dialog";
import { NewInitiativeDialog } from "@/components/initiatives/new-initiative-dialog";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";
import { AgentAvatar, type AgentAvatarIdentity } from "@/components/agents/agent-avatar";
import { PriorityGlyph } from "@/components/ui/priority-glyph";
import {
  EngagementModeGlyph,
  MODE_LABEL,
  MODE_ORDER,
  MODE_SUBTITLE,
  type EngagementModeValue,
} from "@/components/ui/engagement-mode-glyph";
import {
  matchTrailingCommand,
  parseDateExpression,
  parseSlashCommands,
  SLASH_COMMAND_HELP,
  type SlashCommand,
} from "@/lib/slash-commands";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

const PRIORITY_LABEL: Record<Priority, string> = {
  NONE: "No priority",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

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

// Commands whose ARGUMENT we can autocomplete against live data (value
// stage). `/watch` / `/unwatch` take no arg, so they complete at the
// keyword stage only.
const VALUE_COMMANDS = new Set(["project", "assign", "label", "priority", "p", "due"]);

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

// ----- trailing-token parsing (tokenized input) --------------------

/**
 * Find an in-progress slash token at the END of the single-line title.
 * Unlike `matchTrailingCommand` (which only matches a *complete*,
 * parseable command), this matches a command-in-progress so the value
 * autocomplete can surface while the operator is still typing the arg:
 *
 *   "Fix bug /pro"          → { keyword: "pro",      hasSpace: false }
 *   "Fix bug /project for"  → { keyword: "project",  hasSpace: true, arg: "for" }
 *
 * The `/` must start a token (preceded by start-of-string or whitespace)
 * so a mid-word slash ("and/or", "https://…") is never a token.
 */
function matchTrailingToken(
  text: string,
): { start: number; keyword: string; hasSpace: boolean; arg: string } | null {
  let slash = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "/" && (i === 0 || /\s/.test(text[i - 1]))) {
      slash = i;
      break;
    }
  }
  if (slash === -1) return null;
  const rest = text.slice(slash + 1);
  const m = rest.match(/^(\w*)(\s+)?([\s\S]*)$/);
  if (!m) return null;
  return {
    start: slash,
    keyword: (m[1] ?? "").toLowerCase(),
    hasSpace: !!m[2],
    arg: m[3] ?? "",
  };
}

// Relative due-date presets surfaced by the `/due` value autocomplete.
function buildDuePresets(): { label: string; date: Date }[] {
  const atMidnight = (d: Date) => {
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const now = new Date();
  const today = atMidnight(new Date(now));
  const tomorrow = atMidnight(new Date(now));
  tomorrow.setDate(tomorrow.getDate() + 1);
  const in3 = atMidnight(new Date(now));
  in3.setDate(in3.getDate() + 3);
  const nextWeek = atMidnight(new Date(now));
  nextWeek.setDate(nextWeek.getDate() + 7);
  return [
    { label: "Today", date: today },
    { label: "Tomorrow", date: tomorrow },
    { label: "In 3 days", date: in3 },
    { label: "Next week", date: nextWeek },
  ];
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// A single suggestion in the value/keyword autocomplete.
type Suggestion =
  | { kind: "command"; keyword: string; example: string }
  | { kind: "project"; id: string; name: string; key: string; color?: string | null }
  | {
      kind: "agent";
      id: string;
      name: string | null;
      profileKey: string | null;
      avatar: string | null;
    }
  | { kind: "label"; name: string; color: string }
  | { kind: "priority"; level: Priority }
  | { kind: "due"; label: string; date: Date };

function suggestionKey(s: Suggestion): string {
  switch (s.kind) {
    case "command":
      return `cmd:${s.keyword}`;
    case "project":
      return `prj:${s.id}`;
    case "agent":
      return `agt:${s.id}`;
    case "label":
      return `lbl:${s.name}`;
    case "priority":
      return `pri:${s.level}`;
    case "due":
      return `due:${s.label}:${s.date.getTime()}`;
  }
}

export type Mode =
  | { kind: "issue" }
  | { kind: "cycle" }
  | { kind: "initiative" }
  | { kind: "project" }
  | { kind: "note" }
  | { kind: "artifact" }
  | { kind: "action-request" }
  | { kind: "issue-context"; issueId: string; intent: "comment" | "sub-issue" };

export type QuickCreateOverride = {
  projectId?: string;
  statusId?: string;
  title?: string;
  body?: string;
  archiveNoteId?: string;
  /** Bypass pathname-aware capture when the caller promises a new issue. */
  mode?: "issue";
};

/** Resolve the initial capture mode from the current route and caller intent. */
export function resolveQuickCreateMode(path: string | null, override?: QuickCreateOverride): Mode {
  // Explicit issue actions (for example the command palette) must stay
  // issues even on an issue-detail route, where contextual capture defaults
  // to a comment. Seeded note conversions have the same one-shot intent.
  if (override?.mode === "issue" || override?.title || override?.body) {
    return { kind: "issue" };
  }
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
  if (tail === "/initiatives" || tail.startsWith("/initiatives?")) {
    return { kind: "initiative" };
  }
  if (tail === "/projects" || tail.startsWith("/projects?")) return { kind: "project" };
  if (tail === "/artifacts" || tail.startsWith("/artifacts?") || tail.startsWith("/artifacts/")) {
    return { kind: "artifact" };
  }
  return { kind: "issue" };
}

const DRAFT_KEY = "quickCreate";

// Cyclable mode order for Tab / Shift+Tab / ⌘1..⌘7 mode jumping.
// Ordered by how often operators reach for each capture target —
// issue first, then notes, then the planning surfaces, then artifacts
// and action-requests. `issue-context` is excluded because it's
// driven by the current URL, not by user choice.
type CyclableMode =
  | "issue"
  | "note"
  | "project"
  | "initiative"
  | "cycle"
  | "artifact"
  | "action-request";
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
 * For issue capture the title field is a TOKENIZED bar: type a `/`
 * command and the value autocomplete surfaces real projects / agents /
 * labels / priorities / due dates. Tab (or Enter / click) "catches" the
 * pick as a coloured badge inside the box and strips the `/command arg`
 * text from the title. Backspace at the start of an empty caret removes
 * the last badge. The autocomplete popover is PORTALED to `document.body`
 * so it's never clipped by the card.
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
export function QuickCreate({ initialOpen }: { initialOpen?: QuickCreateOverride }) {
  // A lazy-mounted first request must render the dialog in its initial
  // commit. The follow-up effect still applies contextual mode/project/seed
  // data through openFor, but does not leave the first click waiting on it.
  const [open, setOpen] = useState(Boolean(initialOpen));
  const [mode, setMode] = useState<Mode>({ kind: "issue" });
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<Priority>("NONE");
  const [projectId, setProjectId] = useState<string>("");
  // Contextual board/list adds pin the new issue to the originating status.
  const [statusId, setStatusId] = useState<string>("");
  // Slash commands the operator has "committed" into chips: assign / due /
  // label / watch / unwatch (and any /project whose key didn't resolve to a
  // loaded project). Priority + a resolved project sync onto the native
  // controls instead, so the visible pickers always reflect the command.
  const [committed, setCommitted] = useState<SlashCommand[]>([]);
  const [restored, setRestored] = useState(false);
  // Per-mode extras for the new agentic-OS destinations.
  const [artifactType, setArtifactType] = useState<ArtifactType>(ArtifactType.DOCUMENT);
  const [severity, setSeverity] = useState<NotificationSeverity>(NotificationSeverity.INFO);

  // Autocomplete state: active index + a per-token dismissal flag (Esc
  // closes the popover without closing the overlay; the next keystroke
  // reopens it).
  const [acActive, setAcActive] = useState(0);
  const [acDismissed, setAcDismissed] = useState(false);

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
  const [fullForm, setFullForm] = useState<null | {
    kind: "cycle" | "initiative" | "project";
    name: string;
  }>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const acPopoverRef = useRef<HTMLDivElement | null>(null);

  const router = useRouter();
  const pathname = usePathname();
  const ws = useMaybeWorkspace();
  const utils = trpc.useUtils();

  const invalidateIssueViews = async () => {
    await Promise.all([utils.issue.list.invalidate(), utils.issue.count.invalidate()]);
  };

  // Issue / sub-issue are the only modes with attribute tokens + slash
  // autocomplete. Drives query enablement, the badge row, and the add
  // pills.
  const isIssueLike =
    mode.kind === "issue" || (mode.kind === "issue-context" && mode.intent === "sub-issue");

  // Live data for the value autocomplete + badge rendering.
  const { data: projects } = trpc.project.list.useQuery(
    { archived: false, limit: 100 },
    { enabled: open && isIssueLike },
  );
  const { data: agents } = trpc.agent.list.useQuery(undefined, {
    enabled: open && isIssueLike,
  });
  const { data: labels } = trpc.label.list.useQuery(undefined, {
    enabled: open && isIssueLike,
  });

  // Lookups so committed assign/label badges can render an avatar / colour.
  const agentByHandle = useMemo(() => {
    const m = new Map<string, AgentAvatarIdentity>();
    (agents ?? []).forEach((a) => {
      if (a.profileKey) m.set(a.profileKey.toLowerCase(), a);
    });
    return m;
  }, [agents]);
  const labelColorByName = useMemo(() => {
    const m = new Map<string, string>();
    (labels ?? []).forEach((l) => m.set(l.name.toLowerCase(), l.color));
    return m;
  }, [labels]);

  // Parent issue context (for inheriting its project on sub-issue).
  const contextIssueId = mode.kind === "issue-context" ? mode.issueId : undefined;
  const { data: contextIssue } = trpc.issue.byId.useQuery(
    { id: contextIssueId ?? "" },
    { enabled: open && !!contextIssueId },
  );

  // Pasting a GitHub issue/PR URL (or owner/repo#123) into Issue mode turns
  // the capture bar into an import path instead of creating a literal URL-title
  // Forge issue. Sub-issue/comment contexts stay local to the current issue.
  const githubImportRef = useMemo(
    () => (mode.kind === "issue" ? parseGitHubIssueOrPrRef(text) : null),
    [mode.kind, text],
  );
  const githubImportRepo = githubImportRef?.repoFullName ?? null;
  const githubLinkability = trpc.github.linkability.useQuery(
    { repoFullName: githubImportRepo ?? "" },
    {
      enabled: open && !!githubImportRepo && !!githubImportRef?.number,
      staleTime: 15_000,
      retry: false,
    },
  );
  const githubReady = githubLinkability.data?.status === "ready" ? githubLinkability.data : null;
  const githubPreviewInput = githubImportRef?.url
    ? { url: githubImportRef.url, mappingId: githubReady?.mappingId }
    : {
        repoFullName: githubImportRepo ?? "",
        number: githubImportRef?.number ?? 0,
        mappingId: githubReady?.mappingId,
      };
  const githubPreview = trpc.github.preview.useQuery(githubPreviewInput, {
    enabled: !!githubReady && !!githubImportRef?.number,
    staleTime: 15_000,
    retry: false,
  });

  // ----- mutations --------------------------------------------------

  const createIssue = trpc.issue.create.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const importGitHubIssue = trpc.github.importIssue.useMutation({
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
    importGitHubIssue.isPending ||
    createComment.isPending ||
    createCycle.isPending ||
    createInitiative.isPending ||
    createProject.isPending ||
    createNote.isPending ||
    createArtifact.isPending ||
    createActionRequest.isPending;

  // ----- open/close lifecycle --------------------------------------

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
      setStatusId("");
      setCommitted([]);
      setRestored(false);
      setAcActive(0);
      setAcDismissed(false);
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
    (override?: QuickCreateOverride) => {
      const effectiveMode = resolveQuickCreateMode(pathname, override);
      const seeded = !!(override?.title || override?.body);
      setMode(effectiveMode);
      if (override?.projectId) setProjectId(override.projectId);
      if (override?.statusId) setStatusId(override.statusId);

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
    [pathname],
  );

  const initialOpenRef = useRef(initialOpen);
  useEffect(() => {
    if (!initialOpenRef.current) return;
    const request = initialOpenRef.current;
    initialOpenRef.current = undefined;
    openFor(request);
  }, [openFor]);

  // Hotkey: ⇧C (does not fire inside editable fields unless the leader
  // modifier matches — which it doesn't here, so typing ⇧C in a textarea
  // naturally inserts a capital C).
  useHotkey("shift+c", () => openFor(), [pathname]);

  // Legacy hooks: [data-quick-create] clicks + window event.
  useEffect(() => {
    const clickHandler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-quick-create]") as HTMLElement | null;
      if (!el) return;
      const pid = el.dataset.quickCreateProject;
      openFor(pid ? { projectId: pid } : undefined);
    };
    document.addEventListener("click", clickHandler);
    const evtHandler = (e: Event) => {
      const detail = (e as CustomEvent<QuickCreateOverride>).detail ?? {};
      openFor(detail);
    };
    window.addEventListener("forge:quick-create", evtHandler);
    return () => {
      document.removeEventListener("click", clickHandler);
      window.removeEventListener("forge:quick-create", evtHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Global Escape: close the floating input. Clicks outside also close —
  // but a click inside the portaled autocomplete popover must NOT close
  // the overlay, so we check that ref too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (acPopoverRef.current?.contains(target)) return;
      close(true);
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
    mode.kind === "cycle" || mode.kind === "initiative" || mode.kind === "project";
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
        const match = projects?.items.find((p) => p.key.toUpperCase() === c.key.toUpperCase());
        if (match) projectIdValue = match.id;
        else flushed.push(c);
      } else {
        flushed.push(c);
      }
    }
    const { strippedBody, commands: leadingCommands } = parseSlashCommands(working);
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
          if (githubImportRef) {
            if (githubLinkability.isLoading) {
              toast.info("Checking GitHub access…");
              return;
            }
            if (!githubReady) {
              toast.error("Connect this GitHub repository before importing it.");
              return;
            }
            if (githubPreview.isLoading) {
              toast.info("Loading GitHub preview…");
              return;
            }
            if (githubPreview.isError || !githubPreview.data) {
              toast.error(githubPreview.error?.message ?? "Could not load GitHub preview.");
              return;
            }
            const explicitLabelIds = (labels ?? [])
              .filter((label) =>
                committed.some(
                  (c) => c.kind === "label" && c.name.toLowerCase() === label.name.toLowerCase(),
                ),
              )
              .map((label) => label.id);
            const result = await importGitHubIssue.mutateAsync({
              mappingId: githubReady.mappingId,
              url: githubPreview.data.url,
              projectId: projectId || null,
              labelIds: explicitLabelIds,
            });
            await invalidateIssueViews();
            done(result.created ? "Imported GitHub issue." : "Opened existing imported issue.");
            if (secondary) {
              const base = ws ? `/w/${ws.slug}` : "";
              router.push(`${base}/issues/${result.issueId}`);
            }
            return;
          }

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
          const { finalTitle, applyCommands, priorityValue, projectIdValue } = resolved;
          // Seed description (note → issue path). If empty after trim,
          // stay omitted so we don't write blank descriptions.
          const seededDesc = seedDescription.trim() || undefined;
          // Capture the archive intent before close() resets state.
          const archiveTargetNoteId = archiveNoteId && archiveOnCreate ? archiveNoteId : null;
          const issue = await createIssue.mutateAsync({
            title: finalTitle,
            description: seededDesc,
            projectId: projectIdValue || undefined,
            statusId: statusId || undefined,
            priority: priorityValue,
            labelIds: [],
            applyCommands,
          });
          await invalidateIssueViews();
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
          const key =
            suggestedKey.length >= 2
              ? suggestedKey
              : value
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
          const bodyVal = showDescription ? seedDescription.trim() : value;
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
            await invalidateIssueViews();
            done(`Created sub-issue #${issue.number}`);
          }
          return;
        }
      }
    } catch {
      // mutation's onError already surfaced a toast
    }
  }

  // ----- value autocomplete ----------------------------------------

  // The in-progress slash token at the end of the title (issue-like only).
  const trailing = useMemo(
    () => (isIssueLike ? matchTrailingToken(text) : null),
    [isIssueLike, text],
  );

  // Build the suggestion list for the current token. Keyword stage when
  // no space has been typed yet ("/pro"); value stage once it has
  // ("/project for") and the keyword takes an arg.
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trailing) return [];
    if (!trailing.hasSpace) {
      const q = trailing.keyword;
      return SLASH_COMMAND_HELP.filter((c) => c.keyword.slice(1).startsWith(q)).map((c) => ({
        kind: "command" as const,
        keyword: c.keyword,
        example: c.example,
      }));
    }
    if (!VALUE_COMMANDS.has(trailing.keyword)) return [];
    const q = trailing.arg.trim().toLowerCase();
    switch (trailing.keyword) {
      case "project":
        return (projects?.items ?? [])
          .filter((p) => !q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))
          .slice(0, 8)
          .map((p) => ({
            kind: "project" as const,
            id: p.id,
            name: p.name,
            key: p.key,
            color: p.color,
          }));
      case "assign":
        return (agents ?? [])
          .filter(
            (a) =>
              !q || a.name?.toLowerCase().includes(q) || a.profileKey?.toLowerCase().includes(q),
          )
          .slice(0, 8)
          .map((a) => ({
            kind: "agent" as const,
            id: a.id,
            name: a.name,
            profileKey: a.profileKey,
            avatar: a.avatar,
          }));
      case "label":
        return (labels ?? [])
          .filter((l) => !q || l.name.toLowerCase().includes(q))
          .slice(0, 8)
          .map((l) => ({ kind: "label" as const, name: l.name, color: l.color }));
      case "priority":
      case "p":
        return PRIORITIES.filter((p) => p !== "NONE" && (!q || p.toLowerCase().startsWith(q))).map(
          (level) => ({ kind: "priority" as const, level }),
        );
      case "due": {
        const out: Suggestion[] = [];
        const parsed = q ? parseDateExpression(trailing.arg.trim()) : null;
        if (parsed) out.push({ kind: "due", label: fmtDate(parsed), date: parsed });
        for (const d of buildDuePresets()) {
          if (!q || d.label.toLowerCase().includes(q)) {
            out.push({ kind: "due", label: d.label, date: d.date });
          }
        }
        return out;
      }
      default:
        return [];
    }
  }, [trailing, projects, agents, labels]);

  const acVisible = !acDismissed && suggestions.length > 0;

  // Reset active index when the candidate set shifts.
  useEffect(() => {
    setAcActive(0);
  }, [suggestions.length, trailing?.keyword, trailing?.hasSpace]);

  const focusInputEnd = useCallback(() => {
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }, 0);
  }, []);

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
        const match = projects?.items.find((p) => p.key.toUpperCase() === cmd.key.toUpperCase());
        if (match) {
          setProjectId(match.id);
          return;
        }
        // Unknown / not-yet-loaded key — keep it as a chip; the server
        // resolves it by key on create.
        setCommitted((prev) => [...prev.filter((c) => c.kind !== "project"), cmd]);
        return;
      }
      setCommitted((prev) => {
        if (cmd.kind === "label") {
          const dup = prev.some(
            (c) => c.kind === "label" && c.name.toLowerCase() === cmd.name.toLowerCase(),
          );
          return dup ? prev : [...prev, cmd];
        }
        if (cmd.kind === "watch" || cmd.kind === "unwatch") {
          return [...prev.filter((c) => c.kind !== "watch" && c.kind !== "unwatch"), cmd];
        }
        // assign / due — single-valued.
        return [...prev.filter((c) => c.kind !== cmd.kind), cmd];
      });
    },
    [projects],
  );

  // Catch a chosen suggestion as a badge: a keyword pick completes the
  // stub and keeps the popover open for the value; a value pick strips
  // the `/command arg` from the title and applies the attribute.
  const applySuggestion = useCallback(
    (s: Suggestion) => {
      const tok = matchTrailingToken(text);
      if (!tok) return;
      if (s.kind === "command") {
        setText(text.slice(0, tok.start) + s.keyword + " ");
        setAcDismissed(false);
        focusInputEnd();
        return;
      }
      const stripped = text.slice(0, tok.start).replace(/\s+$/, "");
      setText(stripped);
      setAcDismissed(true);
      switch (s.kind) {
        case "project":
          setProjectId(s.id);
          break;
        case "agent":
          applyCommand({ kind: "assign", handle: s.profileKey ?? s.name ?? "" });
          break;
        case "label":
          applyCommand({ kind: "label", name: s.name });
          break;
        case "priority":
          setPriority(s.level);
          break;
        case "due":
          applyCommand({ kind: "due", date: s.date });
          break;
      }
      focusInputEnd();
    },
    [text, applyCommand, focusInputEnd],
  );

  // Click an "add" pill: prime the matching slash stub + reopen the
  // popover so mouse users get the same value picker as `/`.
  const primeSlash = useCallback(
    (keyword: string) => {
      const base = text.replace(/\s+$/, "");
      setText((base ? base + " " : "") + "/" + keyword + " ");
      setAcDismissed(false);
      focusInputEnd();
    },
    [text, focusInputEnd],
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

  // Engagement mode for the committed /assign — unset means "use the
  // surface's resolved default" (same as not touching the field at all).
  const setAssignMode = useCallback((assignMode: EngagementModeValue) => {
    setCommitted((prev) => prev.map((c) => (c.kind === "assign" ? { ...c, mode: assignMode } : c)));
  }, []);

  const hasBadges = priority !== "NONE" || !!projectId || committed.length > 0;

  // Backspace at caret-start pops the most-recent badge (committed →
  // project → priority).
  const removeLastBadge = useCallback(() => {
    if (committed.length > 0) {
      setCommitted((prev) => prev.slice(0, -1));
      return;
    }
    if (projectId) {
      setProjectId("");
      return;
    }
    if (priority !== "NONE") setPriority("NONE");
  }, [committed.length, projectId, priority]);

  const switchMode = useCallback((kind: CyclableMode) => {
    setMode({ kind } as Mode);
    setPriority("NONE");
    setProjectId("");
    setCommitted([]);
    setAcActive(0);
    setAcDismissed(false);
    inputRef.current?.focus();
  }, []);

  // Live "this tail is a valid command" detection — drives the inline
  // "↵ apply …" hint so the operator sees the command is recognised
  // before committing it. Suppressed while the autocomplete is open
  // (the popover already shows what ⏎/Tab will do).
  const pendingCommand = useMemo(
    () => (isIssueLike && !acVisible ? matchTrailingCommand(text) : null),
    [isIssueLike, acVisible, text],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Autocomplete owns Arrow / Enter / Tab / Esc while it's open.
    if (acVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcActive((a) => (a + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcActive((a) => (a - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const s = suggestions[acActive];
        if (s) applySuggestion(s);
        return;
      }
      if (e.key === "Escape") {
        // Close the popover, not the overlay.
        e.preventDefault();
        e.stopPropagation();
        setAcDismissed(true);
        return;
      }
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const secondary = e.metaKey || e.ctrlKey;
      // Plain ⏎ with a recognised command at the end of the title commits
      // it into a chip and stays open. ⌘/Ctrl+⏎ skips straight to
      // create+open — submit() flushes any trailing command itself.
      if (!secondary && isIssueLike && tryCommitTrailing()) return;
      void submit(secondary);
      return;
    }

    // Backspace at the very start of an empty caret removes the last badge.
    if (e.key === "Backspace" && hasBadges) {
      const el = inputRef.current;
      if (el && el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault();
        removeLastBadge();
        return;
      }
    }

    // Tab / Shift+Tab cycles modes — only when the title is empty, so it
    // never fights tokenization mid-type. issue-context is sticky.
    if (e.key === "Tab" && mode.kind !== "issue-context" && text.trim() === "") {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const idx = CYCLABLE_MODES.indexOf(mode.kind as CyclableMode);
      const next = CYCLABLE_MODES[(idx + dir + CYCLABLE_MODES.length) % CYCLABLE_MODES.length];
      switchMode(next);
      return;
    }

    // ⌘1..⌘7 jump straight to a mode without dragging through the
    // dropdown — fastest path for muscle memory.
    if ((e.metaKey || e.ctrlKey) && /^[1-7]$/.test(e.key) && mode.kind !== "issue-context") {
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < CYCLABLE_MODES.length) {
        e.preventDefault();
        switchMode(CYCLABLE_MODES[idx]);
      }
      return;
    }
  }

  // ----- render ----------------------------------------------------

  // Full-form escalation takes over when open.
  if (fullForm) {
    if (fullForm.kind === "cycle") {
      return <NewCycleDialog open={true} onClose={() => setFullForm(null)} />;
    }
    if (fullForm.kind === "initiative") {
      return <NewInitiativeDialog open={true} onClose={() => setFullForm(null)} />;
    }
    if (fullForm.kind === "project") {
      return <NewProjectDialog open={true} onClose={() => setFullForm(null)} />;
    }
  }

  if (!open) return null;

  const isEmpty = text.trim() === "";
  const showModesLegend = mode.kind !== "issue-context" && isEmpty;

  return (
    <div
      // Wrap the floating bar so it anchors to the top of the viewport
      // without capturing clicks on the surrounding page (the bar itself
      // handles outside-click close via the mousedown listener above).
      className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center px-3 sm:top-[18vh] sm:px-4"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-label={`Quick-create ${modeLabel}`}
        className={cn(
          "pointer-events-auto flex max-h-[calc(100vh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur",
          MOTION.slideInTop,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 bg-card/60 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              Create {modeLabel.toLowerCase()}
            </div>
            <p className="text-meta mt-0.5 text-muted-foreground">
              Pick the target, add context, then press Enter to create.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {restored && (
              <span className="hidden shrink-0 rounded-md border border-ember/30 bg-ember/10 px-1.5 py-0.5 font-mono text-[0.6875rem] uppercase tracking-wider text-ember sm:inline">
                Restored
              </span>
            )}
            <button
              type="button"
              onClick={() => close(true)}
              aria-label="Close quick create"
              className="focus-ring -mr-1 rounded-md p-1 text-muted-foreground hover:bg-subtle hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>

        {/* Capture row: the tokenized box + Create button */}
        <div className="flex items-start gap-2 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div
              ref={boxRef}
              onClick={() => inputRef.current?.focus()}
              className="flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background/40 px-2 py-1.5 transition-colors focus-within:border-ember/60"
            >
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
                  if (mode.kind === "issue-context") return;
                  switchMode(kind as CyclableMode);
                }}
              />
              {isIssueLike && (
                <TokenBadges
                  priority={priority}
                  projectId={projectId}
                  projects={projects?.items}
                  committed={committed}
                  agentByHandle={agentByHandle}
                  labelColorByName={labelColorByName}
                  onRemovePriority={() => setPriority("NONE")}
                  onRemoveProject={() => setProjectId("")}
                  onRemoveCommitted={removeCommitted}
                  onSetAssignMode={setAssignMode}
                />
              )}
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setAcDismissed(false);
                }}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                aria-label={`Quick-create ${modeLabel}`}
                autoComplete="off"
                className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              {pendingCommand && (
                <span className="hidden shrink-0 items-center gap-1 rounded-md border border-ember/40 bg-ember/10 px-1.5 py-0.5 text-[0.6875rem] text-ember sm:inline-flex">
                  <CornerDownLeft className="h-3 w-3" aria-hidden />
                  <span>apply</span>
                  <span className="font-mono">{commandChipLabel(pendingCommand.command)}</span>
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={!text.trim() || busy}
            className={cn(
              "focus-ring mt-0.5 inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-ember px-3 py-2 text-xs font-medium text-ember-foreground hover:bg-ember/90 disabled:pointer-events-none disabled:opacity-40",
              MOTION.fast,
            )}
          >
            {busy ? "…" : githubImportRef ? "Import" : "Create"}
            <Kbd className="border-ember-foreground/30 bg-ember-foreground/10 text-ember-foreground/80">
              ⏎
            </Kbd>
          </button>
        </div>

        {githubImportRef && (
          <GitHubImportStatus
            checking={githubLinkability.isLoading}
            linkabilityError={githubLinkability.error?.message ?? null}
            linkabilityStatus={githubLinkability.data?.status ?? null}
            previewLoading={githubPreview.isLoading}
            previewError={githubPreview.error?.message ?? null}
            snapshot={githubPreview.data ?? null}
            fallbackRepo={githubImportRef.repoFullName}
            fallbackNumber={githubImportRef.number}
          />
        )}

        {/* Add pills (mouse path) — issue / sub-issue only. Each primes
            the matching slash so it shares the keyboard value picker. */}
        {isIssueLike && (
          <div className="flex flex-wrap items-center gap-1 border-t border-border/60 bg-card/40 px-4 py-1.5 text-[0.6875rem] text-muted-foreground">
            <span className="mr-0.5 font-mono uppercase tracking-wider opacity-60">add</span>
            <AddPill label="Priority" onClick={() => primeSlash("priority")} />
            <AddPill label="Project" onClick={() => primeSlash("project")} />
            <AddPill label="Assignee" onClick={() => primeSlash("assign")} />
            <AddPill label="Label" onClick={() => primeSlash("label")} />
            <AddPill label="Due" onClick={() => primeSlash("due")} />
            <button
              type="button"
              onClick={() => setShowDescription((v) => !v)}
              aria-pressed={showDescription}
              className={cn(
                "focus-ring rounded px-1.5 py-0.5 transition-colors",
                showDescription
                  ? "bg-ember/15 text-ember"
                  : "text-muted-foreground hover:bg-subtle hover:text-foreground",
              )}
            >
              Description
            </button>
            <span className="ml-auto inline-flex items-center gap-1 opacity-70">
              <Kbd>/</Kbd>
              <span>or</span>
              <Kbd>Tab</Kbd>
              <span>to add</span>
            </span>
          </div>
        )}

        {/* Mode pill row — only while the title is empty (teach, then get
            out of the way). Tab / Shift+Tab cycle, ⌘1..⌘7 jump. */}
        {showModesLegend && (
          <div className="flex flex-wrap items-center gap-1 border-t border-border/60 bg-card/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
            <span className="font-mono uppercase tracking-wider opacity-70">modes</span>
            {CYCLABLE_MODES.map((m, idx) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
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

        {/* Body / description textarea — for issue (seeded from "Convert
            to issue") and for note/artifact/action-request when expanded. */}
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
                    // Match the title input's keymap: ⌘/Ctrl+⏎ submits
                    // secondary (create + open). Plain ⏎ inserts newlines.
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void submit(true);
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

        {/* Per-mode secondary row: issue-context intent tabs, artifact
            type, action-request severity. */}
        {(mode.kind === "issue-context" ||
          mode.kind === "artifact" ||
          mode.kind === "action-request") && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-card/50 px-3 py-2 text-[0.6875rem]">
            {mode.kind === "issue-context" && (
              <>
                <IntentChip
                  selected={mode.intent === "comment"}
                  onClick={() => setMode({ ...mode, intent: "comment" })}
                  label="Comment"
                />
                <IntentChip
                  selected={mode.intent === "sub-issue"}
                  onClick={() => setMode({ ...mode, intent: "sub-issue" })}
                  label="Sub-issue"
                />
                {mode.intent === "sub-issue" && contextIssue && (
                  <span className="ml-1 truncate text-muted-foreground">
                    parent: <span className="font-mono text-foreground">{contextIssue.title}</span>
                  </span>
                )}
              </>
            )}

            {mode.kind === "artifact" && (
              <>
                <span className="mr-1 font-mono uppercase tracking-wider opacity-70">type</span>
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
                <span className="mr-1 font-mono uppercase tracking-wider opacity-70">severity</span>
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
              {secondaryHint && (
                <>
                  <Kbd>⌘⏎</Kbd>
                  <span>{secondaryHint.replace("⌘⏎ ", "")}</span>
                  <span className="mx-1 opacity-40">·</span>
                </>
              )}
              <Kbd>⎋</Kbd> close
            </span>
          </div>
        )}
      </div>

      {/* Portaled value autocomplete — anchored to the box, never clipped. */}
      {acVisible && (
        <AutocompletePopover
          anchorRef={boxRef}
          popoverRef={acPopoverRef}
          measureKey={text}
          items={suggestions}
          active={acActive}
          setActive={setAcActive}
          onPick={applySuggestion}
          agentByHandle={agentByHandle}
        />
      )}
    </div>
  );
}

function GitHubImportStatus({
  checking,
  linkabilityError,
  linkabilityStatus,
  previewLoading,
  previewError,
  snapshot,
  fallbackRepo,
  fallbackNumber,
}: {
  checking: boolean;
  linkabilityError: string | null;
  linkabilityStatus: string | null;
  previewLoading: boolean;
  previewError: string | null;
  snapshot: {
    resourceType: string;
    title: string;
    state: string;
    url: string;
    repoFullName: string;
    number: number;
  } | null;
  fallbackRepo: string;
  fallbackNumber: number;
}) {
  const lineClass = "flex items-center gap-1.5 text-meta";
  const warningClass = `${lineClass} text-warning`;
  const mutedClass = `${lineClass} text-muted-foreground`;

  if (checking) {
    return (
      <div className="border-t border-border/60 bg-card/30 px-4 py-2">
        <p className={mutedClass}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking access to <span className="font-mono">{fallbackRepo}</span>…
        </p>
      </div>
    );
  }

  if (linkabilityError) {
    return (
      <div className="border-t border-border/60 bg-card/30 px-4 py-2">
        <p className={warningClass}>
          <AlertCircle className="h-3.5 w-3.5" />
          {linkabilityError}
        </p>
      </div>
    );
  }

  if (linkabilityStatus && linkabilityStatus !== "ready") {
    return (
      <div className="border-t border-border/60 bg-card/30 px-4 py-2">
        <p className={warningClass}>
          <AlertCircle className="h-3.5 w-3.5" />
          Connect <span className="font-mono">{fallbackRepo}</span> in GitHub settings before
          importing.
        </p>
      </div>
    );
  }

  if (previewLoading) {
    return (
      <div className="border-t border-border/60 bg-card/30 px-4 py-2">
        <p className={mutedClass}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading{" "}
          <span className="font-mono">
            {fallbackRepo}#{fallbackNumber}
          </span>
          …
        </p>
      </div>
    );
  }

  if (previewError) {
    return (
      <div className="border-t border-border/60 bg-card/30 px-4 py-2">
        <p className={warningClass}>
          <AlertCircle className="h-3.5 w-3.5" />
          {previewError}
        </p>
      </div>
    );
  }

  if (!snapshot) return null;
  const isPr = snapshot.resourceType === "PULL_REQUEST";
  return (
    <div className="border-t border-border/60 bg-card/30 px-4 py-2">
      <div className="flex items-start gap-2 rounded-md border border-border bg-background/70 p-2">
        {isPr ? (
          <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <Github className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.8125rem] font-medium" title={snapshot.title}>
            {snapshot.title}
          </p>
          <div className="text-meta mt-0.5 flex items-center gap-1.5 text-muted-foreground">
            <span className="font-mono">
              {snapshot.repoFullName}#{snapshot.number}
            </span>
            <span>{isPr ? "pull request" : "issue"}</span>
            <span>{snapshot.state || "unknown"}</span>
            <span className="ml-auto">Press Enter to import</span>
          </div>
        </div>
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
        onClick={(e) => {
          e.stopPropagation();
          onToggleIntent();
        }}
        aria-label="Toggle comment / sub-issue"
        className="focus-ring shrink-0 cursor-pointer rounded-md border border-border/70 bg-subtle/70 px-2 py-1 font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground hover:bg-subtle"
      >
        {label}
      </button>
    );
  }

  // Switchable: real dropdown listing the creation modes.
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
                    onClick={(e) => {
                      e.stopPropagation();
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
        selected ? "bg-subtle text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

// A small "+ field" button below the box — primes the matching slash.
function AddPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
    >
      <Plus className="h-2.5 w-2.5 opacity-70" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

// Dynamic colour swatch for project / label badges + suggestions.
function ColorDot({ color }: { color?: string | null }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-sm"
      style={{ backgroundColor: color ?? "transparent" }}
      aria-hidden
    />
  );
}

// Removable badge wrapper used for every caught attribute.
function Badge({
  children,
  onRemove,
  removeLabel,
}: {
  children: React.ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-md border border-ember/40 bg-ember/10 px-1.5 text-[0.6875rem] text-foreground">
      <span className="flex max-w-[160px] items-center gap-1 truncate">{children}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="focus-ring -mr-0.5 rounded p-0.5 text-muted-foreground hover:bg-ember/20 hover:text-foreground"
      >
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>
    </span>
  );
}

/**
 * The caught attributes rendered as inline badges inside the capture box:
 * priority (when set) → project (when set) → committed slash commands in
 * order (assign / due / label / watch|unwatch / unresolved project).
 * Priority + a resolved project sync onto the native state; everything
 * else lives in `committed`.
 */
function TokenBadges({
  priority,
  projectId,
  projects,
  committed,
  agentByHandle,
  labelColorByName,
  onRemovePriority,
  onRemoveProject,
  onRemoveCommitted,
  onSetAssignMode,
}: {
  priority: Priority;
  projectId: string;
  projects?: { id: string; name: string; color?: string | null }[];
  committed: SlashCommand[];
  agentByHandle: Map<string, AgentAvatarIdentity>;
  labelColorByName: Map<string, string>;
  onRemovePriority: () => void;
  onRemoveProject: () => void;
  onRemoveCommitted: (key: string) => void;
  onSetAssignMode: (mode: EngagementModeValue) => void;
}) {
  const project = projects?.find((p) => p.id === projectId) ?? null;
  return (
    <>
      {priority !== "NONE" && (
        <Badge onRemove={onRemovePriority} removeLabel="Remove priority">
          <PriorityGlyph priority={priority} />
          <span>{PRIORITY_LABEL[priority]}</span>
        </Badge>
      )}
      {project && (
        <Badge onRemove={onRemoveProject} removeLabel="Remove project">
          <ColorDot color={project.color} />
          <span className="truncate">{project.name}</span>
        </Badge>
      )}
      {committed.map((c) => {
        const key = commandKey(c);
        return (
          <span key={key} className="contents">
            <Badge
              onRemove={() => onRemoveCommitted(key)}
              removeLabel={`Remove ${commandChipLabel(c)}`}
            >
              <CommittedBadgeContent
                command={c}
                agentByHandle={agentByHandle}
                labelColorByName={labelColorByName}
              />
            </Badge>
            {c.kind === "assign" && <AssignModePicker mode={c.mode} onChange={onSetAssignMode} />}
          </span>
        );
      })}
    </>
  );
}

/** Compact mode picker shown next to a committed /assign badge — lets the
 *  operator say how far to take the work at the moment they hand it over,
 *  instead of always falling back to the workspace's assignment default. */
function AssignModePicker({
  mode,
  onChange,
}: {
  mode: EngagementModeValue | undefined;
  onChange: (mode: EngagementModeValue) => void;
}) {
  return (
    <span
      role="radiogroup"
      aria-label="Engagement mode"
      className="inline-flex h-6 items-center gap-0.5 rounded-md border border-border bg-card/30 px-0.5"
    >
      {MODE_ORDER.map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${MODE_LABEL[m]} — ${MODE_SUBTITLE[m]}`}
            onClick={() => onChange(m)}
            className={cn(
              "focus-ring grid h-5 w-5 place-items-center rounded transition-colors",
              active
                ? "bg-ember/15 text-ember"
                : "text-muted-foreground hover:bg-subtle hover:text-foreground",
            )}
          >
            <EngagementModeGlyph mode={m} size={11} className={active ? "text-ember" : ""} />
          </button>
        );
      })}
    </span>
  );
}

function CommittedBadgeContent({
  command,
  agentByHandle,
  labelColorByName,
}: {
  command: SlashCommand;
  agentByHandle: Map<string, AgentAvatarIdentity>;
  labelColorByName: Map<string, string>;
}) {
  switch (command.kind) {
    case "assign": {
      const agent = agentByHandle.get(command.handle.toLowerCase()) ?? null;
      return (
        <>
          {agent ? <AgentAvatar agent={agent} size="xs" title={null} /> : null}
          <span className="truncate">@{command.handle}</span>
        </>
      );
    }
    case "label":
      return (
        <>
          <ColorDot color={labelColorByName.get(command.name.toLowerCase())} />
          <span className="truncate">{command.name}</span>
        </>
      );
    case "due":
      return (
        <>
          <Calendar className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          <span className="truncate">
            {command.date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </>
      );
    case "project":
      return <span className="font-mono">{command.key}</span>;
    case "watch":
      return <span>watching</span>;
    case "unwatch":
      return <span>unwatch</span>;
    case "priority":
      return <span>!{command.level}</span>;
  }
}

/**
 * Portaled autocomplete popover. Anchored to the capture box's bounding
 * rect (fixed positioning, re-measured on scroll / resize / text change)
 * and rendered into `document.body` so the card's `overflow-hidden` can
 * never clip it — the original "project dropdown is invisible" bug.
 */
function AutocompletePopover({
  anchorRef,
  popoverRef,
  measureKey,
  items,
  active,
  setActive,
  onPick,
  agentByHandle,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  measureKey: string;
  items: Suggestion[];
  active: number;
  setActive: (i: number) => void;
  onPick: (s: Suggestion) => void;
  agentByHandle: Map<string, AgentAvatarIdentity>;
}) {
  const [rect, setRect] = useState<{
    left: number;
    width: number;
    anchorTop: number;
    anchorBottom: number;
    placeAbove: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    function measure() {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const placeAbove = below < 260 && r.top > below;
      setRect({
        left: r.left,
        width: r.width,
        anchorTop: r.top,
        anchorBottom: r.bottom,
        placeAbove,
      });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef, items.length, measureKey]);

  if (!rect) return null;

  const style: React.CSSProperties = rect.placeAbove
    ? {
        position: "fixed",
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.anchorTop + 4,
      }
    : {
        position: "fixed",
        left: rect.left,
        width: rect.width,
        top: rect.anchorBottom + 4,
      };

  return createPortal(
    <div
      ref={popoverRef}
      // preventDefault on mousedown keeps the input focused while clicking.
      onMouseDown={(e) => e.preventDefault()}
      style={style}
      className="z-[60] max-h-64 overflow-y-auto rounded-md border border-border bg-popover shadow-md"
      role="listbox"
      aria-label="Field suggestions"
    >
      <ul className="py-1">
        {items.map((s, i) => {
          const selected = i === active;
          return (
            <li key={suggestionKey(s)}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(s)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                  selected
                    ? "bg-subtle text-foreground"
                    : "text-muted-foreground hover:bg-subtle/70",
                )}
              >
                <SuggestionRow suggestion={s} agentByHandle={agentByHandle} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

function SuggestionRow({
  suggestion: s,
  agentByHandle,
}: {
  suggestion: Suggestion;
  agentByHandle: Map<string, AgentAvatarIdentity>;
}) {
  switch (s.kind) {
    case "command":
      return (
        <>
          <span className="font-mono text-foreground">{s.keyword}</span>
          <span className="text-meta ml-auto truncate text-muted-foreground">{s.example}</span>
        </>
      );
    case "project":
      return (
        <>
          <ColorDot color={s.color} />
          <span className="flex-1 truncate text-foreground">{s.name}</span>
          <span className="text-id font-mono text-muted-foreground">{s.key}</span>
        </>
      );
    case "agent": {
      const agent = (s.profileKey && agentByHandle.get(s.profileKey.toLowerCase())) || s;
      return (
        <>
          <AgentAvatar agent={agent} size="xs" title={null} />
          <span className="flex-1 truncate text-foreground">{s.name ?? s.profileKey}</span>
          {s.profileKey && (
            <span className="text-id font-mono text-muted-foreground">@{s.profileKey}</span>
          )}
        </>
      );
    }
    case "label":
      return (
        <>
          <ColorDot color={s.color} />
          <span className="flex-1 truncate text-foreground">{s.name}</span>
        </>
      );
    case "priority":
      return (
        <>
          <PriorityGlyph priority={s.level} />
          <span className="flex-1 text-foreground">{PRIORITY_LABEL[s.level]}</span>
        </>
      );
    case "due":
      return (
        <>
          <Calendar className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          <span className="flex-1 text-foreground">{s.label}</span>
          <span className="text-meta text-muted-foreground">{fmtDate(s.date)}</span>
        </>
      );
  }
}
