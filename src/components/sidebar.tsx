"use client";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Inbox,
  CircleDot,
  FolderKanban,
  LayoutDashboard,
  LineChart,
  Plug,
  Settings,
  Search,
  Plus,
  LogOut,
  User as UserIcon,
  ChevronUp,
  Target,
  CalendarRange,
  Compass,
  Map as MapIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useModKeyLabel } from "@/lib/platform";
import { useChord, useHotkey } from "@/lib/keyboard";
import { signOutAction } from "@/server/actions/auth";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { trpc } from "@/lib/trpc";

const NAV = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, chord: "d" },
  { path: "/inbox", label: "Inbox", icon: Inbox, chord: "i" },
  { path: "/issues", label: "Issues", icon: CircleDot, chord: "s" },
  { path: "/projects", label: "Projects", icon: FolderKanban, chord: "p" },
  { path: "/cycles", label: "Cycles", icon: CalendarRange, chord: "c" },
  { path: "/initiatives", label: "Initiatives", icon: Compass, chord: "n" },
  { path: "/roadmap", label: "Roadmap", icon: MapIcon, chord: "r" },
  { path: "/standup", label: "Standup", icon: Target, chord: "u" },
  { path: "/analytics", label: "Analytics", icon: LineChart, chord: "a" },
  { path: "/settings/plugins", label: "Plugins", icon: Plug, chord: "l" },
  { path: "/settings", label: "Settings", icon: Settings, chord: "," },
] as const;

export function Sidebar({
  slug,
  user,
}: {
  slug: string;
  user: { name?: string | null; image?: string | null; email: string };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const mod = useModKeyLabel();

  const nav = useMemo(
    () => NAV.map((n) => ({ ...n, href: `/w/${slug}${n.path}` })),
    [slug],
  );

  const chordMap = useMemo(() => {
    const m: Record<string, () => void> = {};
    for (const n of nav) m[n.chord] = () => router.push(n.href);
    // `g n` is documented as "new initiative" in Phase 3 — overrides the
    // plain nav entry to auto-open the dialog via ?new.
    m["n"] = () => router.push(`/w/${slug}/initiatives?new`);
    return m;
  }, [nav, router, slug]);
  useChord("g", chordMap);

  // `c` → jump to the current cycle's detail page, falling back to /cycles
  // if no ACTIVE cycle exists. The query stays cached by tRPC so pressing
  // `c` repeatedly is instant.
  const { data: currentCycle } = trpc.cycle.current.useQuery();
  useHotkey(
    "c",
    () => {
      if (currentCycle) router.push(`/w/${slug}/cycles/${currentCycle.id}`);
      else router.push(`/w/${slug}/cycles`);
    },
    [currentCycle, router, slug],
  );

  return (
    <aside className="flex h-svh w-56 flex-col border-r border-border bg-card/40">
      <div className="px-3 pt-3">
        <WorkspaceSwitcher />
      </div>

      <button
        data-command-palette
        className="mx-3 mt-3 flex h-7 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-subtle"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search or jump</span>
        <span className="ml-auto kbd">{mod}+K</span>
      </button>

      <button
        data-quick-create
        className="mx-3 mt-1 flex h-7 items-center gap-2 rounded-md bg-ember px-2 text-xs font-medium text-ember-foreground hover:bg-ember/90"
      >
        <Plus className="h-3.5 w-3.5" />
        New issue
        <span className="ml-auto kbd bg-ember/20 text-ember-foreground">⇧C</span>
      </button>

      <nav className="mt-4 flex flex-col gap-px px-2">
        {nav.map(({ href, path, label, icon: Icon, chord }) => {
          const active = pathname === href || pathname?.startsWith(`${href}/`);
          return (
            <Link
              key={path}
              href={href}
              className={cn(
                "row h-7 rounded-md px-2 text-[13px]",
                active
                  ? "bg-subtle text-foreground"
                  : "text-muted-foreground hover:bg-subtle hover:text-foreground",
              )}
              title={`g then ${chord}`}
            >
              <Icon className="mr-2 h-3.5 w-3.5" />
              <span>{label}</span>
              <span className="ml-auto flex items-center gap-px text-[10px] text-muted-foreground/70">
                <span className="kbd !px-1 !text-[9px]">G</span>
                <span className="kbd !px-1 !text-[9px]">{chord.toUpperCase()}</span>
              </span>
            </Link>
          );
        })}
      </nav>

      <UserMenu slug={slug} user={user} />
    </aside>
  );
}

function UserMenu({
  slug,
  user,
}: {
  slug: string;
  user: { name?: string | null; image?: string | null; email: string };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative mt-auto border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-subtle/60",
          open && "bg-subtle/60",
        )}
      >
        <AvatarFallback user={user} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{user.name ?? user.email}</div>
          <div className="truncate text-[10px] text-muted-foreground">{user.email}</div>
        </div>
        <ChevronUp
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open ? "" : "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+6px)] left-2 right-2 overflow-hidden rounded-md border border-border bg-card shadow-lg"
        >
          <Link
            href="/settings/account"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle"
            role="menuitem"
          >
            <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />
            Account settings
          </Link>
          <Link
            href={`/w/${slug}/settings/workspace`}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle"
            role="menuitem"
          >
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
            Workspace settings
          </Link>
          <Link
            href="/settings/workspaces"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle"
            role="menuitem"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            Manage workspaces
          </Link>
          <form action={signOutAction} className="border-t border-border">
            <button
              type="submit"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-danger hover:bg-subtle"
              role="menuitem"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function AvatarFallback({
  user,
}: {
  user: { name?: string | null; image?: string | null; email: string };
}) {
  if (user.image) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={user.image}
        alt=""
        width={22}
        height={22}
        className="rounded-full object-cover"
      />
    );
  }
  const source = user.name ?? user.email;
  const initials = source
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-subtle font-mono text-[10px] text-muted-foreground">
      {initials || "·"}
    </span>
  );
}
