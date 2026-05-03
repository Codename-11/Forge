"use client";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Inbox,
  CircleDot,
  Clock,
  FolderKanban,
  LayoutDashboard,
  LineChart,
  Settings,
  Search,
  Plus,
  CalendarRange,
  Compass,
  Map as MapIcon,
  Workflow,
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { useModKeyLabel } from "@/lib/platform";
import { useChord, useHotkey } from "@/lib/keyboard";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { PinnedSidebarSection } from "@/components/pins/pinned-sidebar-section";
import { trpc } from "@/lib/trpc";

/**
 * Grouped, collapsible workspace sidebar.
 *
 * The nav is driven by a `NavSection[]` table (see `sections()` below) so
 * pages can be added or re-ordered without touching the shell layout. Each
 * section has a small-caps header (hidden in collapsed mode) and a list of
 * leaf items with icons + optional `g <chord>` shortcuts.
 *
 * Collapse:
 *   - `⌘\` toggles expanded (`w-56`) ↔ icon rail (`w-14`).
 *   - State persists per-user in `localStorage[forge.sidebarCollapsed]`.
 *   - Below the `md` breakpoint, the sidebar auto-collapses via CSS (the
 *     content is the same either way; only width + label visibility change).
 *
 * What moved OUT of the sidebar:
 *   - Pins strip → top bar (`src/components/top-bar.tsx`).
 *   - User menu → top bar (avatar dropdown).
 *   - Sign out / theme toggle → inside the user menu.
 */

type NavItem = {
  path: string;
  label: string;
  icon: typeof Inbox;
  /** Second key of the `g <x>` leader chord. */
  chord?: string;
  /** Renders an unread-inbox badge when set to `"inbox"`. */
  badge?: "inbox";
  /** Only show when `Workspace.timeTrackingEnabled`. */
  onlyWhenTimeTracking?: true;
};

type NavSection = {
  id: string;
  label: string;
  items: readonly NavItem[];
};

/**
 * Single source of truth for sidebar nav. Agent 3 (dashboard/inbox merge) may
 * flip entries in the `Work` and `Personal` groups; keep this structure data-
 * driven so those edits don't require touching the rendering code.
 */
const SECTIONS: readonly NavSection[] = [
  {
    id: "work",
    label: "Work",
    // Dashboard is the default workspace landing (rollups + onboarding).
    // Inbox sits next to it because both are "homepage-y" surfaces — the
    // bell-drawer Mine tab is a fast-access version of Inbox, but the
    // full page lives here. Issues / Projects round out the workflow.
    // Time is workspace-feature-flagged; renders only when enabled.
    // Standup was dropped from the rail — it lives on the Dashboard as
    // a tile and stays reachable via the command palette and `g u` chord.
    items: [
      { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, chord: "d" },
      { path: "/inbox", label: "Inbox", icon: Inbox, chord: "i", badge: "inbox" },
      { path: "/issues", label: "Issues", icon: CircleDot, chord: "s" },
      { path: "/projects", label: "Projects", icon: FolderKanban, chord: "p" },
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

/**
 * Pinned-to-bottom items rendered in a separate footer block (above the
 * collapse toggle). Visually separated by a thin border so utility
 * surfaces — Docs (help) and Settings (configuration) — stay one click
 * away without competing with the workflow nav above.
 */
const FOOTER_ITEMS: readonly NavItem[] = [
  // `g h` = help mnemonic for the in-app VitePress viewer.
  { path: "/docs", label: "Docs", icon: BookOpen, chord: "h" },
  { path: "/settings", label: "Settings", icon: Settings, chord: "," },
] as const;

const COLLAPSED_STORAGE_KEY = "forge.sidebarCollapsed";

function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  // Default to expanded; read from localStorage on mount so SSR output stays
  // stable. A brief flash (~1 frame) is acceptable and avoids layout-shift
  // from cookie reads on every request.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (raw === "1") setCollapsed(true);
    } catch {
      // localStorage unavailable — fall back to expanded (safe default).
    }
  }, []);

  const set = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  return [collapsed, set];
}

export function Sidebar({
  slug,
  user: _user,
}: {
  slug: string;
  /** Kept in the API for backwards compat; the user menu moved to the top bar. */
  user: { name?: string | null; image?: string | null; email: string };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const mod = useModKeyLabel();
  const workspace = useMaybeWorkspace();
  const timeTrackingEnabled = workspace?.timeTrackingEnabled ?? false;

  const [collapsed, setCollapsed] = useSidebarCollapsed();

  // `⌘\` toggles collapse globally. Backslash is an unclaimed key and plays
  // well with the rest of the cmd-prefixed shortcuts (`⌘K` command palette).
  useHotkey("cmd+\\", () => setCollapsed(!collapsed), [collapsed]);

  // Pathname-aware quick-create label. The button itself doesn't change which
  // mode the overlay opens — that's keyed off the pathname inside the
  // overlay — but matching the visible label here keeps the surface honest.
  const quickCreateLabel = useMemo(() => {
    const tail = pathname?.replace(/^\/w\/[^/]+/, "") ?? "";
    if (tail.startsWith("/projects")) return "New project";
    if (tail.startsWith("/cycles")) return "New sprint";
    if (tail.startsWith("/initiatives")) return "New initiative";
    return "New issue";
  }, [pathname]);

  const sections = useMemo(
    () =>
      SECTIONS.map((sec) => ({
        ...sec,
        items: sec.items
          .filter((it) => (it.onlyWhenTimeTracking ? timeTrackingEnabled : true))
          .map((it) => ({ ...it, href: `/w/${slug}${it.path}` })),
      })).filter((sec) => sec.items.length > 0),
    [slug, timeTrackingEnabled],
  );

  const footerItems = useMemo(
    () => FOOTER_ITEMS.map((it) => ({ ...it, href: `/w/${slug}${it.path}` })),
    [slug],
  );

  const chordMap = useMemo(() => {
    const m: Record<string, () => void> = {};
    for (const sec of sections) {
      for (const it of sec.items) {
        if (it.chord) m[it.chord] = () => router.push(it.href);
      }
    }
    for (const it of footerItems) {
      if (it.chord) m[it.chord] = () => router.push(it.href);
    }
    // Spec overrides (preserved from the previous shell):
    //   `g n` opens the new-initiative dialog via ?new.
    //   `g b` = "browse inbox" alias for `g i`.
    //   `g u` = standup (used to be a sidebar entry; kept as a chord
    //           since the page itself still exists).
    m["n"] = () => router.push(`/w/${slug}/initiatives?new`);
    m["b"] = () => router.push(`/w/${slug}/inbox`);
    m["u"] = () => router.push(`/w/${slug}/standup`);
    return m;
  }, [sections, footerItems, router, slug]);
  useChord("g", chordMap);

  const { data: inboxBadge } = trpc.inbox.badge.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });

  // Count pins (this-workspace + cross-workspace) so the "Pinned" header
  // only renders when at least one row will appear under it. Each query
  // is shared with the PinnedSidebarSection — same input, same cache key,
  // no duplicate fetches.
  const { data: wsPinsForCount } = trpc.pin.listAll.useQuery(
    { workspaceId: workspace?.id ?? "" },
    { enabled: !!workspace },
  );
  const { data: crossPinsForCount } = trpc.pin.listAll.useQuery({
    workspaceId: null,
  });
  const hasPins =
    (wsPinsForCount?.length ?? 0) + (crossPinsForCount?.length ?? 0) > 0;

  // Sprint nav lives on `g c` (chord). The previous bare-"c" hotkey
  // was dropped because it ate Ctrl+C copy on Linux/Windows where Ctrl
  // is the platform modifier — pressing Ctrl+C anywhere outside an
  // input would route to /cycles AND preventDefault the copy.

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={cn(
        "group/sidebar flex h-svh shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-150",
        // Below `md`, force icon rail regardless of user preference. This
        // keeps the `w-` utility class applied so Tailwind purges correctly.
        collapsed ? "w-14" : "w-56 max-md:w-14",
      )}
    >
      {/* Workspace switcher — always visible at the top. Hides its label in
          collapsed mode via the data-collapsed CSS variant below. */}
      <div className="px-2 pt-3">
        <div
          className={cn(
            "flex items-center",
            collapsed ? "justify-center max-md:justify-center" : "max-md:justify-center",
          )}
        >
          <WorkspaceSwitcher />
        </div>
      </div>

      <button
        data-command-palette
        title={`Search or jump (${mod}+K)`}
        className={cn(
          "mx-2 mt-3 flex h-7 items-center gap-2 rounded-md border border-border bg-background text-xs text-muted-foreground hover:bg-subtle",
          collapsed
            ? "justify-center px-0"
            : "px-2 max-md:justify-center max-md:px-0",
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span
          className={cn(
            "flex flex-1 items-center gap-2 truncate",
            collapsed ? "hidden" : "max-md:hidden",
          )}
        >
          <span className="truncate">Search or jump</span>
          <span className="ml-auto kbd">{mod}+K</span>
        </span>
      </button>

      <button
        data-quick-create
        title={`${quickCreateLabel} (Shift+C)`}
        className={cn(
          "mx-2 mt-1 flex h-7 items-center gap-2 rounded-md bg-ember text-xs font-medium text-ember-foreground hover:bg-ember/90",
          collapsed
            ? "justify-center px-0"
            : "px-2 max-md:justify-center max-md:px-0",
        )}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span
          className={cn(
            "flex flex-1 items-center gap-2 truncate",
            collapsed ? "hidden" : "max-md:hidden",
          )}
        >
          <span className="truncate">{quickCreateLabel}</span>
          <span className="ml-auto kbd bg-ember/20 text-ember-foreground">⇧C</span>
        </span>
      </button>

      <nav className="mt-3 flex flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2">
        {sections.map((sec) => (
          <div key={sec.id} className="flex flex-col gap-px">
            <div
              className={cn(
                "px-2 pb-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70",
                collapsed ? "hidden" : "max-md:hidden",
              )}
            >
              {sec.label}
            </div>
            {sec.items.map((item) => (
              <NavRow
                key={item.path}
                item={item}
                pathname={pathname}
                collapsed={collapsed}
                inboxCount={inboxBadge?.count ?? 0}
              />
            ))}
          </div>
        ))}

        {/* Pinned items live below the workflow nav. The section + header
            only render when the user has at least one pin (this workspace
            or cross-workspace) so a fresh workspace doesn't show an empty
            "Pinned" eyebrow. Header matches the rest of the nav-section
            visual; in collapsed/icon-rail mode the label hides and only
            the row icons remain. */}
        {workspace && hasPins && (
          <div className="flex flex-col gap-px">
            <div
              className={cn(
                "px-2 pb-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70",
                collapsed ? "hidden" : "max-md:hidden",
              )}
            >
              Pinned
            </div>
            <PinnedSidebarSection
              workspaceId={workspace.id}
              workspaceSlug={workspace.slug}
              collapsed={collapsed}
            />
          </div>
        )}
      </nav>

      {/* Footer block: utility surfaces (Docs + Settings) pinned to the
          bottom, separated from the workflow nav by a thin border. The
          collapse toggle lives below this block. */}
      <div
        className={cn(
          "mx-2 flex flex-col gap-px border-t border-border/60 pt-2",
        )}
      >
        {footerItems.map((item) => (
          <NavRow
            key={item.path}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
            inboxCount={0}
            inFooter
          />
        ))}
      </div>

      {/* Collapse toggle lives at the bottom — primary affordance is `⌘\`,
          the button is the visual backup for mouse users. */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        title={`${collapsed ? "Expand" : "Collapse"} sidebar (${mod}+\\)`}
        className={cn(
          "mx-2 mb-2 flex h-7 items-center gap-2 rounded-md border border-border/70 bg-transparent text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground",
          collapsed
            ? "justify-center px-0"
            : "px-2 max-md:justify-center max-md:px-0",
        )}
      >
        {collapsed ? (
          <PanelLeftOpen className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <PanelLeftClose className="h-3.5 w-3.5 shrink-0" />
        )}
        <span
          className={cn(
            "flex flex-1 items-center gap-2 truncate",
            collapsed ? "hidden" : "max-md:hidden",
          )}
        >
          <span className="truncate">Collapse</span>
          <span className="ml-auto kbd">{mod}+\</span>
        </span>
      </button>
    </aside>
  );
}

/**
 * Single nav row used by both the main sections and the bottom-pinned
 * footer block. Same visual contract — icon + label + optional `g X`
 * chord hint — so Docs/Settings don't visually drift from the rest of
 * the sidebar even though they live in a separate container.
 */
function NavRow({
  item,
  pathname,
  collapsed,
  inboxCount,
  inFooter,
}: {
  item: { href: string; path: string; label: string; icon: typeof Inbox; chord?: string; badge?: "inbox" };
  pathname: string | null;
  collapsed: boolean;
  inboxCount: number;
  inFooter?: boolean;
}) {
  const { href, path, label, icon: Icon, chord, badge } = item;
  const active = pathname === href || pathname?.startsWith(`${href}/`);
  const badgeCount = badge === "inbox" ? inboxCount : 0;
  const chordHint = chord ? `g then ${chord}` : label;
  return (
    <Link
      key={path}
      href={href}
      title={chordHint}
      className={cn(
        "row relative h-8 rounded-md text-[0.8125rem]",
        active
          ? "bg-subtle text-foreground"
          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
        collapsed
          ? "justify-center px-0"
          : "px-2 max-md:justify-center max-md:px-0",
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          !collapsed && "mr-2 max-md:mr-0",
          inFooter && !active && "text-muted-foreground/80",
        )}
      />
      {collapsed && badgeCount > 0 && (
        <span
          aria-label={`${badgeCount} unread`}
          className="absolute right-3 top-1 h-1.5 w-1.5 rounded-full bg-ember ring-2 ring-card"
        />
      )}
      <span
        className={cn(
          "flex flex-1 items-center",
          collapsed ? "hidden" : "max-md:hidden",
        )}
      >
        <span className="truncate">{label}</span>
        {badgeCount > 0 && (
          <span className="ml-2 rounded-full bg-ember/15 px-1.5 py-0 font-mono text-[0.6875rem] text-ember">
            {badgeCount > 99 ? "99+" : badgeCount}
          </span>
        )}
        {chord && (
          <span className="ml-auto flex items-center gap-px text-[0.6875rem] text-muted-foreground/70">
            <span className="kbd !px-1 !text-[0.6875rem]">G</span>
            <span className="kbd !px-1 !text-[0.6875rem]">{chord.toUpperCase()}</span>
          </span>
        )}
      </span>
    </Link>
  );
}
