"use client";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Search,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Menu,
} from "lucide-react";
import {
  WORKSPACE_NAV_FOOTER_ITEMS,
  WORKSPACE_NAV_SECTIONS,
  type WorkspaceNavItem,
  type WorkspaceNavSection,
} from "@/components/sidebar-nav";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { useModKeyLabel } from "@/lib/platform";
import { useChord, useHotkey } from "@/lib/keyboard";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { PinnedSidebarSection } from "@/components/pins/pinned-sidebar-section";
import { trpc } from "@/lib/trpc";
import { Drawer } from "@/components/ui/modal";

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
 *   - Below the `md` breakpoint, the desktop rail is replaced by a
 *     touch-first bottom nav + drawer.
 *
 * What moved OUT of the sidebar:
 *   - Pins strip → top bar (`src/components/top-bar.tsx`).
 *   - User menu → top bar (avatar dropdown).
 *   - Sign out / theme toggle → inside the user menu.
 */

const SECTIONS = WORKSPACE_NAV_SECTIONS;
const FOOTER_ITEMS = WORKSPACE_NAV_FOOTER_ITEMS;

const COLLAPSED_STORAGE_KEY = "forge.sidebarCollapsed";
const MOBILE_PRIMARY_PATHS = ["/dashboard", "/inbox", "/issues", "/projects"] as const;

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // `⌘\` toggles collapse globally. Backslash is an unclaimed key and plays
  // well with the rest of the cmd-prefixed shortcuts (`⌘K` command palette).
  useHotkey("cmd+\\", () => setCollapsed(!collapsed), [collapsed]);

  useEffect(() => {
    const open = () => setMobileNavOpen(true);
    window.addEventListener("forge:open-mobile-nav", open);
    return () => window.removeEventListener("forge:open-mobile-nav", open);
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

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

  const { data: decisions } = trpc.commandCenter.decisionsCount.useQuery(undefined, {
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

  const mobilePrimaryItems = MOBILE_PRIMARY_PATHS.map((path) =>
    sections.flatMap((sec) => sec.items).find((item) => item.path === path),
  ).filter((item): item is WorkspaceNavItem & { href: string } => Boolean(item));

  const isMobileMoreActive =
    !!pathname &&
    !mobilePrimaryItems.some((item) => isNavItemActive(pathname, item.href));

  return (
    <>
      <aside
        data-collapsed={collapsed || undefined}
        className={cn(
          "group/sidebar hidden h-svh shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-150 md:flex",
          collapsed ? "w-14" : "w-56",
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
          <WorkspaceSwitcher collapsed={collapsed} />
        </div>
      </div>

      <button
        data-command-palette
        title="Search or jump"
        data-tooltip-kbd={`${mod} K`}
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
          {/* M8 (design spec): ember caret blink on the omnibar trigger —
              bridges the search affordance to the streaming-text language.
              Reduced-motion / motion-off renders a static caret. */}
          <span className="truncate">
            Search or jump
            <span className="forge-caret" />
          </span>
          <span className="ml-auto kbd">{mod}+K</span>
        </span>
      </button>

      <button
        data-quick-create
        title={quickCreateLabel}
        data-tooltip-kbd="⇧ C"
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

      <nav className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2">
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
                decisionsCount={decisions?.total ?? 0}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* Pinned section lives in its OWN bounded region below the
          scrollable workflow nav and above the footer. Capped at
          roughly 10 rows tall (`max-h-[16rem]`) with internal scroll
          so a wallet of pins never crowds the workflow nav (which
          scrolls independently above). Server enforces 5 max per scope
          + 5 cross-workspace = up to ~10 rows in this section before
          internal scroll kicks in. The section + header only render
          when the user has at least one pin so a fresh workspace
          doesn't show an empty "Pinned" eyebrow. In collapsed / icon-
          rail mode the eyebrow label hides and only the row icons
          remain (and the bounded scroll still applies). */}
      {workspace && hasPins && (
        <div className="mx-2 flex shrink-0 flex-col gap-px border-t border-border/60 pt-2">
          <div
            className={cn(
              "px-2 pb-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70",
              collapsed ? "hidden" : "max-md:hidden",
            )}
          >
            Pinned
          </div>
          <div className="max-h-64 overflow-y-auto pb-1">
            <PinnedSidebarSection
              workspaceId={workspace.id}
              workspaceSlug={workspace.slug}
              collapsed={collapsed}
            />
          </div>
        </div>
      )}

      {/* Footer block: utility surfaces (Docs + Settings) pinned to the
          bottom, separated from the workflow nav by a thin border. The
          collapse toggle lives below this block. */}
      <div
        className={cn(
          "mx-2 flex flex-col gap-px border-t border-border/60 pt-2",
        )}
      >
        {/* Escape hatch back to the cross-workspace home. The switcher also
            offers it, but this is the always-visible affordance. */}
        <Link
          href="/"
          title="Mission Control · across all workspaces"
          className={cn(
            "flex h-8 items-center gap-2 rounded-md text-[0.8125rem] text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground",
            collapsed ? "justify-center px-0" : "px-2 max-md:justify-center max-md:px-0",
          )}
        >
          <Sparkles className="h-4 w-4 shrink-0" />
          <span className={cn(collapsed ? "hidden" : "max-md:hidden")}>Mission Control</span>
        </Link>
        {footerItems.map((item) => (
          <NavRow
            key={item.path}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
            inboxCount={0}
            decisionsCount={0}
            inFooter
          />
        ))}
      </div>

      {/* Collapse toggle lives at the bottom — primary affordance is `⌘\`,
          the button is the visual backup for mouse users. */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        title={`${collapsed ? "Expand" : "Collapse"} sidebar`}
        data-tooltip-kbd={`${mod} \\`}
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
      <MobileWorkspaceNav
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        pathname={pathname}
        sections={sections}
        footerItems={footerItems}
        primaryItems={mobilePrimaryItems}
        moreActive={isMobileMoreActive}
        inboxCount={inboxBadge?.count ?? 0}
        decisionsCount={decisions?.total ?? 0}
        quickCreateLabel={quickCreateLabel}
        workspaceId={workspace?.id}
        workspaceSlug={workspace?.slug}
        hasPins={hasPins}
      />
    </>
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
  decisionsCount,
  inFooter,
}: {
  item: WorkspaceNavItem & { href: string };
  pathname: string | null;
  collapsed: boolean;
  inboxCount: number;
  decisionsCount: number;
  inFooter?: boolean;
}) {
  const { href, path, label, icon: Icon, chord, badge } = item;
  const active = isNavItemActive(pathname, href);
  const badgeCount =
    badge === "inbox" ? inboxCount : badge === "decisions" ? decisionsCount : 0;
  return (
    <Link
      key={path}
      href={href}
      title={label}
      data-tooltip-kbd={chord ? `G ${chord.toUpperCase()}` : undefined}
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
          <span
            className={cn(
              "ml-2 rounded-full px-1.5 py-0 font-mono text-[0.6875rem]",
              // Decisions (action requests + review gates) get the ember
              // accent; routine inbox unread reads as a quiet subtle count.
              badge === "decisions"
                ? "bg-ember/15 text-ember"
                : "bg-subtle text-foreground",
            )}
          >
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

function MobileWorkspaceNav({
  open,
  onOpenChange,
  pathname,
  sections,
  footerItems,
  primaryItems,
  moreActive,
  inboxCount,
  decisionsCount,
  quickCreateLabel,
  workspaceId,
  workspaceSlug,
  hasPins,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pathname: string | null;
  sections: Array<WorkspaceNavSectionWithHref>;
  footerItems: Array<WorkspaceNavItem & { href: string }>;
  primaryItems: Array<WorkspaceNavItem & { href: string }>;
  moreActive: boolean;
  inboxCount: number;
  decisionsCount: number;
  quickCreateLabel: string;
  workspaceId?: string;
  workspaceSlug?: string;
  hasPins: boolean;
}) {
  return (
    <>
      <nav
        aria-label="Primary workspace navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-1.5 shadow-lg backdrop-blur md:hidden"
      >
        <div className="mx-auto grid max-w-lg grid-cols-5 gap-1">
          {primaryItems.map((item) => (
            <MobileBottomNavItem
              key={item.path}
              item={item}
              pathname={pathname}
              inboxCount={inboxCount}
              decisionsCount={decisionsCount}
            />
          ))}
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={cn(
              "focus-ring relative flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[0.6875rem]",
              moreActive || open
                ? "bg-subtle text-foreground"
                : "text-muted-foreground hover:bg-subtle hover:text-foreground",
            )}
          >
            <Menu className="h-4 w-4 shrink-0" />
            <span className="max-w-full truncate">More</span>
          </button>
        </div>
      </nav>

      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        title="Workspace menu"
        maxHeight="min(82vh, 42rem)"
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <WorkspaceSwitcher />
            <Link
              href="/"
              onClick={() => onOpenChange(false)}
              className="focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-subtle hover:text-foreground"
            >
              <Sparkles className="h-4 w-4" />
              <span className="hidden min-[380px]:inline">Mission Control</span>
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-command-palette
              onClick={() => onOpenChange(false)}
              className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground hover:bg-subtle hover:text-foreground"
            >
              <Search className="h-4 w-4" />
              <span className="truncate">Search</span>
            </button>
            <button
              type="button"
              data-quick-create
              onClick={() => onOpenChange(false)}
              className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-md bg-ember px-3 text-xs font-medium text-ember-foreground hover:bg-ember/90"
            >
              <Plus className="h-4 w-4" />
              <span className="truncate">{quickCreateLabel}</span>
            </button>
          </div>

          <div className="flex flex-col gap-4">
            {sections.map((sec) => (
              <div key={sec.id} className="flex flex-col gap-1">
                <div className="px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {sec.label}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {sec.items.map((item) => (
                    <MobileDrawerNavItem
                      key={item.path}
                      item={item}
                      pathname={pathname}
                      inboxCount={inboxCount}
                      decisionsCount={decisionsCount}
                      onSelect={() => onOpenChange(false)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {workspaceId && workspaceSlug && hasPins && (
            <div className="flex flex-col gap-1 border-t border-border/60 pt-3">
              <div className="px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Pinned
              </div>
              <div className="max-h-48 overflow-y-auto rounded-md border border-border/60 bg-background/40 p-1">
                <PinnedSidebarSection
                  workspaceId={workspaceId}
                  workspaceSlug={workspaceSlug}
                  collapsed={false}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5 border-t border-border/60 pt-3">
            {footerItems.map((item) => (
              <MobileDrawerNavItem
                key={item.path}
                item={item}
                pathname={pathname}
                inboxCount={0}
                decisionsCount={0}
                onSelect={() => onOpenChange(false)}
              />
            ))}
          </div>
        </div>
      </Drawer>
    </>
  );
}

function MobileBottomNavItem({
  item,
  pathname,
  inboxCount,
  decisionsCount,
}: {
  item: WorkspaceNavItem & { href: string };
  pathname: string | null;
  inboxCount: number;
  decisionsCount: number;
}) {
  const { href, label, icon: Icon, badge } = item;
  const active = isNavItemActive(pathname, href);
  const badgeCount =
    badge === "inbox" ? inboxCount : badge === "decisions" ? decisionsCount : 0;

  return (
    <Link
      href={href}
      className={cn(
        "focus-ring relative flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[0.6875rem]",
        active
          ? "bg-subtle text-foreground"
          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="max-w-full truncate">{label}</span>
      {badgeCount > 0 && (
        <span className="absolute right-2 top-1 h-1.5 w-1.5 rounded-full bg-ember ring-2 ring-card" />
      )}
    </Link>
  );
}

function MobileDrawerNavItem({
  item,
  pathname,
  inboxCount,
  decisionsCount,
  onSelect,
}: {
  item: WorkspaceNavItem & { href: string };
  pathname: string | null;
  inboxCount: number;
  decisionsCount: number;
  onSelect: () => void;
}) {
  const { href, label, icon: Icon, badge } = item;
  const active = isNavItemActive(pathname, href);
  const badgeCount =
    badge === "inbox" ? inboxCount : badge === "decisions" ? decisionsCount : 0;

  return (
    <Link
      href={href}
      onClick={onSelect}
      className={cn(
        "focus-ring flex h-11 min-w-0 items-center gap-2 rounded-md px-3 text-xs",
        active
          ? "bg-subtle text-foreground"
          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badgeCount > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 font-mono text-[0.6875rem]",
            badge === "decisions"
              ? "bg-ember/15 text-ember"
              : "bg-subtle text-foreground",
          )}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}
    </Link>
  );
}

type WorkspaceNavSectionWithHref = Omit<WorkspaceNavSection, "items"> & {
  items: Array<WorkspaceNavItem & { href: string }>;
};

function isNavItemActive(pathname: string | null, href: string) {
  return pathname === href || pathname?.startsWith(`${href}/`) || false;
}
