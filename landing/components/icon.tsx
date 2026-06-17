import type { CSSProperties } from "react";

/* Forge icon set — minimal stroke-1.6 lucide-style SVGs, ported verbatim
   from the prototype's forge-icons.jsx. Centralized so the screens share a
   uniform glyph vocabulary that matches the real lucide-react icons in the
   app. Each icon renders into viewBox=0 0 24 24 and inherits currentColor. */

export const FORGE_ICON_PATHS: Record<string, string> = {
  // ─── sidebar nav (mirrors sidebar-nav.ts) ───
  LayoutDashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  Command:
    "M15 6V4.5a2.5 2.5 0 1 1 2.5 2.5H16M9 6V4.5A2.5 2.5 0 1 0 6.5 7H8M9 18v1.5a2.5 2.5 0 1 1-2.5-2.5H8M15 18v1.5a2.5 2.5 0 1 0 2.5-2.5H16M8 8h8v8H8z",
  Inbox:
    "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  MessageSquare: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  CircleDot: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  FolderKanban: "M4 4h5l2 3h9v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 10v6M12 10v3M16 10v8",
  Shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  Clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  CalendarRange:
    "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M8 2v4M16 2v4M8 14l2 2 4-4",
  Compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z",
  Map: "M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14",
  FileText: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  Target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  ListChecks: "M3 5l2 2 4-4M3 12l2 2 4-4M3 19l2 2 4-4M13 6h8M13 13h8M13 20h8",
  UsersRound: "M18 21a8 8 0 0 0-16 0M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  Sparkles:
    "M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4zM19 14l.8 2 2.2.6-2.2.6-.8 2-.8-2-2.2-.6 2.2-.6zM5 17l.5 1.3 1.5.4-1.5.4-.5 1.3-.5-1.3-1.5-.4 1.5-.4z",
  LineChart: "M3 3v18h18M7 14l3-3 4 4 6-6",
  Workflow: "M3 3h6v6H3zM15 3h6v6h-6zM9 9v3h6v3M9 15h6v6H9z",
  BookOpen: "M2 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H2zM22 4h-7a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h8z",
  Settings:
    "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",

  // ─── shell + ui ───
  Search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  Plus: "M12 5v14M5 12h14",
  Bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  HelpCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h0",
  ChevronDown: "M6 9l6 6 6-6",
  ChevronRight: "M9 18l6-6-6-6",
  ChevronLeft: "M15 18l-6-6 6-6",
  MoreHorizontal: "M5 12h.01M12 12h.01M19 12h.01",
  PanelLeftClose: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 3v18M16 15l-3-3 3-3",
  Bot: "M12 8V4M9 4h6M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M9 13v2M15 13v2",
  AlertTriangle: "M10.3 3.86a2 2 0 0 1 3.4 0l8.5 14a2 2 0 0 1-1.7 3H3.5a2 2 0 0 1-1.7-3zM12 9v4M12 17h0",
  ArrowRight: "M5 12h14M12 5l7 7-7 7",
  CalendarClock:
    "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6M16 2v4M8 2v4M3 10h13M17 21a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17 17v-2.5l1.5 1",
  X: "M18 6L6 18M6 6l12 12",
  Folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  CheckCheck: "M3 13l4 4L18 6M8 13l4 4L23 6",
  Eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  AtSign: "M16 8v5a3 3 0 1 0 6 0v-1a10 10 0 1 0-3.9 7.9M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  Zap: "M13 2L3 14h8l-1 8 10-12h-8z",
  Sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  Moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  UserCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM7 18a5 5 0 0 1 10 0M12 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  GitBranch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM15 6a9 9 0 0 0-9 9",
  PaperClip: "M21.4 11l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8L15 6",
  Activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  Link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7L11.5 4.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1.5-1.5",
  Pin: "M12 17v5M9 9V3h6v6M5 9h14l-2 8H7z",
  Filter: "M22 3H2l8 9.5V19l4 2v-8.5z",
  ListIcon: "M3 6h18M3 12h18M3 18h18",
  Grid: "M3 3h8v8H3zM13 3h8v8h-8zM13 13h8v8h-8zM3 13h8v8H3z",
  Loader: "M21 12a9 9 0 1 1-6.2-8.55",
  Rocket:
    "M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.9.7-2.2-.1-3-.8-.8-2.1-.8-3 .1zM12 15l-3-3a22 22 0 0 1 8-10l3 3a22 22 0 0 1-8 10zM9 12H4l3-3h4M12 15v5l3-3v-4",
  Check: "M5 12l5 5L20 7",

  // ─── settings + extras ───
  Users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  User: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  Tag: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13.1V3h10.1l7.5 7.5a2 2 0 0 1 0 2.9zM7 7h.01",
  ClipboardList: "M9 4h6a1 1 0 0 1 1 1v2H8V5a1 1 0 0 1 1-1zM7 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 12h8M9 16h6M9 20h4",
  Layers: "M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  Repeat: "M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  Plug: "M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5",
  PlugZap: "M9 2v3M13 2v3M6 5h11l-1.5 6a3 3 0 0 1-3 2H10.5a3 3 0 0 1-3-2zM12 13l-2 5h4l-2 5",
  Server: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 15a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 7h.01M7 17h.01",
  Send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  DatabaseBackup: "M4 6a8 3 0 1 0 16 0 8 3 0 1 0-16 0M4 6v6a8 3 0 0 0 11 2.8M4 12v6a8 3 0 0 0 6.6 3M18 14l-3 3 3 3M21 17h-6",
  Palette:
    "M12 21a9 9 0 1 0 0-18c5 0 9 4 9 8 0 3-2 4-4 4h-3a2 2 0 0 0-1 4 3 3 0 0 1-1 2zM7 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2M10 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2M15 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2",
  Key: "M15 11a4 4 0 1 0-4-4M11 7L3 15v4h4l1-1v-2h2v-2h2l1-1z",
  KeyRound: "M15 11a4 4 0 1 0-4-4M11 7L2 16v4h4v-2h2v-2h2v-2z",
  GripVertical: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  Bookmark: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
  Download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  Upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  Terminal: "M4 17l6-6-6-6M12 19h8",
};

export type IconName = keyof typeof FORGE_ICON_PATHS;

export function Icon({
  name,
  size = 14,
  className = "",
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const d = FORGE_ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
