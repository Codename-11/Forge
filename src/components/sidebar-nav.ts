import {
  CalendarRange,
  CalendarDays,
  CalendarClock,
  CircleDot,
  Clock,
  Compass,
  Command,
  FileText,
  FolderKanban,
  Inbox,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Target,
  Map as MapIcon,
  MessageSquare,
  Settings,
  Shield,
  Sparkles,
  BookOpen,
  UsersRound,
  Workflow,
  Sun,
  NotebookPen,
} from "lucide-react";

export type WorkspaceNavItem = {
  path: string;
  label: string;
  icon: typeof Inbox;
  /** Second key of the `g <x>` leader chord. */
  chord?: string;
  /**
   * Renders a count badge: `"inbox"` = unread inbox items,
   * `"decisions"` = open action requests + pending review gates.
   */
  badge?: "inbox" | "decisions";
  /** Only show when `Workspace.timeTrackingEnabled`. */
  onlyWhenTimeTracking?: true;
};

export type WorkspaceNavSection = {
  id: string;
  label: string;
  items: readonly WorkspaceNavItem[];
};

/**
 * Single source of truth for workspace sidebar nav and keyboard chords.
 * Exported separately from the client sidebar so tests and route metadata can
 * validate product placement without rendering the full shell.
 */
export const WORKSPACE_NAV_SECTIONS: readonly WorkspaceNavSection[] = [
  {
    id: "work",
    label: "Work",
    items: [
      { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, chord: "d" },
      { path: "/command-center", label: "Command Center", icon: Command, chord: "j", badge: "decisions" },
      { path: "/inbox", label: "Inbox", icon: Inbox, chord: "i", badge: "inbox" },
      { path: "/chat", label: "Chat", icon: MessageSquare, chord: "m" },
      { path: "/issues", label: "Issues", icon: CircleDot, chord: "s" },
      { path: "/projects", label: "Projects", icon: FolderKanban, chord: "p" },
      { path: "/review", label: "Review", icon: Shield, chord: "v" },
      { path: "/time", label: "Time", icon: Clock, chord: "t", onlyWhenTimeTracking: true },
    ],
  },
  {
    id: "planning",
    label: "Planning",
    items: [
      { path: "/cycles", label: "Sprints", icon: CalendarRange, chord: "c" },
      { path: "/initiatives", label: "Initiatives", icon: Compass, chord: "n" },
      { path: "/roadmap", label: "Roadmap", icon: MapIcon, chord: "r" },
      { path: "/artifacts", label: "Artifacts", icon: FileText, chord: "f" },
      { path: "/goals", label: "Goals", icon: Target, chord: "g" },
      { path: "/plans", label: "Plans", icon: ListChecks, chord: "l" },
      { path: "/crews", label: "Crews", icon: UsersRound, chord: "u" },
      { path: "/canvas", label: "Canvas", icon: Sparkles, chord: "k" },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [
      {
        path: "/scheduled-tasks",
        label: "Scheduled tasks",
        icon: CalendarClock,
        chord: "q",
      },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    items: [
      { path: "/analytics", label: "Analytics", icon: LineChart, chord: "a" },
      { path: "/agents", label: "Agents", icon: Workflow, chord: "o" },
    ],
  },
] as const;

/** A calmer task-first information architecture for personal workspaces. */
export const PERSONAL_WORKSPACE_NAV_SECTIONS: readonly WorkspaceNavSection[] = [
  {
    id: "personal",
    label: "Personal",
    items: [
      { path: "/dashboard", label: "Today", icon: Sun, chord: "d" },
      { path: "/inbox", label: "Inbox", icon: Inbox, chord: "i", badge: "inbox" },
      { path: "/issues", label: "Tasks", icon: CircleDot, chord: "s" },
      { path: "/dashboard#upcoming", label: "Upcoming", icon: CalendarDays, chord: "c" },
      { path: "/dashboard#personal-notes", label: "Notes", icon: NotebookPen, chord: "n" },
    ],
  },
  {
    id: "assist",
    label: "Assist",
    items: [
      { path: "/chat", label: "Chat", icon: MessageSquare, chord: "m" },
      { path: "/scheduled-tasks", label: "Routines", icon: CalendarClock, chord: "q" },
      { path: "/agents", label: "Agents", icon: Workflow, chord: "o" },
    ],
  },
] as const;

/** Utility surfaces pinned below workflow navigation. */
export const WORKSPACE_NAV_FOOTER_ITEMS: readonly WorkspaceNavItem[] = [
  { path: "/docs", label: "Docs", icon: BookOpen, chord: "h" },
  { path: "/settings", label: "Settings", icon: Settings, chord: "," },
] as const;
