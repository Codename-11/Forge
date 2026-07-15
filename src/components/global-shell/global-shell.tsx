"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles,
  Inbox,
  Activity,
  Search,
  Plus,
  Settings,
  Shield,
  ChevronDown,
  ChevronRight,
  Eye,
  Bell,
  HelpCircle,
  Menu,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/kbd";
import { Drawer } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";
import { VersionChip } from "./version-chip";

/**
 * Global "concourse" shell — the second of Forge's three shells (workspace
 * / global / admin). Paler than the workspace shell, read-only across
 * workspaces, with a Slack-style workspace switcher in the rail and a
 * breadcrumb crumb-chain in the top bar. Ports `global-shell.jsx` from the
 * design handoff. Data is passed from the server layout (no client fetches
 * for chrome). Part of the multi-workspace restructure.
 *
 * Mobile: the rail is `hidden md:flex` and surfaced via a hamburger →
 * bottom-sheet `Drawer` (the same primitive the workspace shell uses), so the
 * global pages (`/`, `/inbox`, `/activity`, `/whats-new`) no longer stack the
 * full 256px sidebar above content on a phone.
 */

export interface GlobalShellWorkspace {
  id: string;
  slug: string;
  name: string;
  key: string;
  avatarUrl?: string | null;
  mentions?: number;
}

/**
 * Workspace badge: the workspace's uploaded `avatarUrl` when set, else a
 * key-initial chip in the canonical warm-earthy `workspaceColor` (same as
 * the workspace shell's switcher) — so chips look consistent everywhere.
 */
export function WorkspaceBadge({
  ws,
  size = 20,
  className,
}: {
  ws: { key: string; name: string; avatarUrl?: string | null };
  size?: number;
  className?: string;
}) {
  if (ws.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={ws.avatarUrl}
        alt={ws.name}
        width={size}
        height={size}
        className={cn("shrink-0 rounded-md object-cover", className)}
      />
    );
  }
  const c = workspaceColor(ws.key);
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-md font-mono font-semibold", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: c.bg,
        color: c.fg,
        boxShadow: `inset 0 0 0 1px ${c.ring}`,
      }}
    >
      {ws.key.slice(0, size >= 20 ? 2 : 1)}
    </span>
  );
}

/**
 * Solid workspace chip color (the canonical warm-earthy hue), for small
 * legacy letter-chips that render white text on a solid background.
 * Prefer {@link WorkspaceBadge} for new code (handles avatars + ring).
 */
export function workspaceChipColor(key: string): string {
  return workspaceColor(key).fg;
}

export interface GlobalShellUser {
  name: string | null;
  email: string | null;
  image: string | null;
  instanceRole: "INSTANCE_ADMIN" | "MEMBER";
}

const GLOBAL_NAV: { href: string; icon: LucideIcon; label: string; hint: string }[] = [
  { href: "/", icon: Sparkles, label: "Mission Control", hint: "Across all workspaces" },
  { href: "/inbox", icon: Inbox, label: "Inbox", hint: "Mentions & assignments" },
  { href: "/activity", icon: Activity, label: "Activity", hint: "Live run feed" },
];

function ActivityPill() {
  return (
    <Link
      href="/activity"
      title="Activity · live runs + chat (G 5)"
      className="focus-ring relative inline-flex min-h-8 items-center gap-2 rounded-full border px-2 py-0.5 text-meta font-medium transition-colors sm:min-h-0"
      style={{
        background: "hsl(var(--ember) / 0.12)",
        borderColor: "hsl(var(--ember) / 0.35)",
        color: "hsl(var(--ember))",
      }}
    >
      <span aria-hidden className="relative inline-flex" style={{ width: 7, height: 7 }}>
        <span className="absolute inset-0 rounded-full" style={{ background: "currentColor", opacity: 0.85 }} />
        <span
          className="absolute inset-0 rounded-full"
          style={{ background: "currentColor", opacity: 0.5, animation: "forge-act-pulse 2.4s ease-in-out infinite" }}
        />
      </span>
      <span className="tracking-tight">Activity</span>
      {/* keyboard hint is desktop-only */}
      <span className="hidden md:inline-flex">
        <Kbd>5</Kbd>
      </span>
    </Link>
  );
}

function WorkspaceSwitcherCard({ ws, onNavigate }: { ws: GlobalShellWorkspace; onNavigate?: () => void }) {
  return (
    <Link
      href={`/w/${ws.slug}`}
      title={`Switch to ${ws.name}`}
      onClick={onNavigate}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
    >
      <WorkspaceBadge ws={ws} size={20} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{ws.name}</span>
        <span className="block truncate text-id text-muted-foreground/70">{ws.key}</span>
      </span>
      {!!ws.mentions && ws.mentions > 0 && (
        <span className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ember/15 px-1 text-[9px] font-medium text-ember">
          {ws.mentions}
        </span>
      )}
    </Link>
  );
}

function NavRow({
  item,
  active,
  onNavigate,
}: {
  item: { href: string; icon: LucideIcon; label: string; hint: string };
  active: boolean;
  onNavigate?: () => void;
}) {
  const Ico = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] transition-colors",
        active ? "bg-subtle text-foreground" : "text-muted-foreground hover:bg-subtle hover:text-foreground",
      )}
    >
      <Ico size={14} className={active ? "text-ember" : ""} />
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-tight">{item.label}</span>
        <span className="block text-meta leading-tight text-muted-foreground/70">{item.hint}</span>
      </span>
    </Link>
  );
}

/**
 * The rail's body — account header, search, global nav, workspace switcher,
 * settings/admin, version chip. Rendered by the desktop `<aside>` and the
 * mobile `Drawer` alike; `onNavigate` closes the drawer on selection.
 */
function GlobalNavContent({
  user,
  workspaces,
  activePath,
  inDrawer = false,
  onNavigate,
}: {
  user: GlobalShellUser;
  workspaces: GlobalShellWorkspace[];
  activePath: string;
  inDrawer?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className={cn("pb-2", inDrawer ? "pt-0" : "px-3 pt-3")}>
        <Link
          href="/settings/account"
          onClick={onNavigate}
          className="flex h-10 w-full items-center gap-2 rounded-md px-1.5 hover:bg-subtle"
        >
          <Avatar name={user.name ?? user.email ?? "?"} image={user.image} size={26} />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-semibold tracking-tight">{user.name ?? "You"}</span>
            <span className="block truncate text-meta text-muted-foreground">{user.email}</span>
          </span>
          <ChevronDown size={12} className="text-muted-foreground" />
        </Link>
      </div>

      <button
        type="button"
        data-command-palette
        onClick={onNavigate}
        className={cn(
          "mt-1 flex h-9 items-center gap-2 rounded-md border border-border bg-background/70 px-2 text-xs text-muted-foreground hover:bg-subtle",
          inDrawer ? "" : "mx-2 h-7",
        )}
      >
        <Search size={13} />
        <span className="flex-1 truncate text-left">Search everywhere</span>
        <span className="kbd hidden md:inline-flex">⌘K</span>
      </button>

      <nav className={cn("mt-3 flex flex-col gap-px", inDrawer ? "" : "px-2")}>
        {GLOBAL_NAV.map((it) => (
          <NavRow key={it.href} item={it} active={activePath === it.href} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className={cn("mt-4 flex flex-col", inDrawer ? "" : "min-h-0 flex-1 px-2")}>
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Workspaces</span>
          <Link
            href="/settings/workspaces"
            onClick={onNavigate}
            className="text-muted-foreground hover:text-foreground"
            title="Manage workspaces"
          >
            <Plus size={12} />
          </Link>
        </div>
        <div
          className={cn(
            "flex flex-col gap-px overflow-y-auto pr-1",
            inDrawer ? "max-h-[40vh]" : "min-h-0 flex-1",
          )}
        >
          {workspaces.map((w) => (
            <WorkspaceSwitcherCard key={w.id} ws={w} onNavigate={onNavigate} />
          ))}
        </div>
      </div>

      <div className={cn("mt-2 flex flex-col gap-px border-t border-border/60 pt-2", inDrawer ? "" : "mx-2")}>
        <Link
          href="/settings"
          onClick={onNavigate}
          className={cn(
            "group flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] transition-colors",
            activePath.startsWith("/settings")
              ? "bg-subtle text-foreground"
              : "text-muted-foreground hover:bg-subtle hover:text-foreground",
          )}
        >
          <Settings size={13} />
          <span className="flex-1">Settings</span>
          <span className="hidden md:inline-flex">
            <Kbd>,</Kbd>
          </span>
        </Link>
        {user.instanceRole === "INSTANCE_ADMIN" && (
          <Link
            href="/admin"
            onClick={onNavigate}
            className={cn(
              "group flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] transition-colors",
              activePath.startsWith("/admin")
                ? "bg-subtle text-foreground"
                : "text-muted-foreground hover:bg-subtle hover:text-foreground",
            )}
          >
            <Shield size={13} />
            <span className="flex-1">Instance admin</span>
            <span className="rounded border border-ember/30 bg-ember/10 px-1 text-[9px] font-medium uppercase tracking-wider text-ember">
              root
            </span>
          </Link>
        )}
      </div>

      {/* Build/version chip — at-a-glance "what's running" + What's New. */}
      <div className={cn("mb-1 mt-1 border-t border-border/60 pt-1", inDrawer ? "" : "mx-2")}>
        <VersionChip />
      </div>
    </>
  );
}

function GlobalSidebar({
  user,
  workspaces,
  activePath,
}: {
  user: GlobalShellUser;
  workspaces: GlobalShellWorkspace[];
  activePath: string;
}) {
  return (
    <aside
      className="hidden h-full w-60 min-h-0 shrink-0 flex-col overflow-hidden border-r border-border md:flex"
      style={{
        background: "linear-gradient(180deg, hsl(var(--card) / 0.6) 0%, hsl(var(--card) / 0.3) 100%)",
      }}
    >
      <GlobalNavContent user={user} workspaces={workspaces} activePath={activePath} />
    </aside>
  );
}

function GlobalTopBar({ crumbs, onOpenNav }: { crumbs: string[]; onOpenNav?: () => void }) {
  return (
    <header
      className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-4 sm:py-0"
      style={{ background: "hsl(var(--card) / 0.3)" }}
    >
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open menu"
        className="focus-ring -ml-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground md:hidden"
      >
        <Menu size={18} />
      </button>
      <nav className="flex min-w-0 items-center gap-1 text-meta text-muted-foreground">
        {crumbs.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight size={11} className="opacity-60" />}
            <span className={cn("truncate", i === crumbs.length - 1 ? "text-foreground" : "")}>{c}</span>
          </span>
        ))}
      </nav>
      <span className="hidden items-center gap-1 rounded-md border border-border/70 bg-card/40 px-1.5 py-0.5 text-meta text-muted-foreground sm:ml-2 sm:inline-flex">
        <Eye size={10} />
        <span>Read-only across workspaces</span>
      </span>
      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        <ActivityPill />
        <button className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground sm:h-7 sm:w-7">
          <Bell size={14} />
        </button>
        <button className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground sm:h-7 sm:w-7">
          <HelpCircle size={14} />
        </button>
      </div>
    </header>
  );
}

export function GlobalPageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  big,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  big?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 flex-col items-stretch gap-3 border-b border-border bg-background sm:flex-row sm:items-end sm:gap-4",
        big ? "px-4 pb-4 pt-4 sm:px-8 sm:pb-6 sm:pt-6" : "px-4 pb-3 pt-4 sm:px-8 sm:pb-4 sm:pt-5",
      )}
    >
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">{eyebrow}</div>
        )}
        <h1 className={cn("mt-0.5 truncate font-semibold tracking-tight", big ? "text-[1.65rem]" : "text-xl")}>{title}</h1>
        {subtitle && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground sm:truncate">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:flex-nowrap">{actions}</div>}
    </header>
  );
}

export function GlobalShell({
  user,
  workspaces,
  activePath,
  crumbs = ["Forge"],
  title,
  subtitle,
  eyebrow,
  actions,
  big,
  contentClass = "overflow-y-auto",
  children,
}: {
  user: GlobalShellUser;
  workspaces: GlobalShellWorkspace[];
  activePath?: string;
  crumbs?: string[];
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  big?: boolean;
  contentClass?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = activePath ?? pathname ?? "/";
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      <GlobalSidebar user={user} workspaces={workspaces} activePath={active} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <GlobalTopBar crumbs={crumbs} onOpenNav={() => setMobileNavOpen(true)} />
        {title && <GlobalPageHeader title={title} subtitle={subtitle} eyebrow={eyebrow} actions={actions} big={big} />}
        <div className={cn("min-h-0 flex-1", contentClass)}>{children}</div>
      </main>

      {/* Mobile nav — bottom-sheet Drawer (md:hidden trigger lives in the top bar). */}
      <Drawer open={mobileNavOpen} onOpenChange={setMobileNavOpen} title="Menu" maxHeight="min(82vh, 42rem)">
        <GlobalNavContent
          user={user}
          workspaces={workspaces}
          activePath={active}
          inDrawer
          onNavigate={() => setMobileNavOpen(false)}
        />
      </Drawer>
    </div>
  );
}
