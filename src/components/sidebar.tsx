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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { useModKeyLabel } from "@/lib/platform";
import { useChord } from "@/lib/keyboard";
import { signOutAction } from "@/server/actions/auth";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, chord: "d" },
  { href: "/inbox", label: "Inbox", icon: Inbox, chord: "i" },
  { href: "/issues", label: "Issues", icon: CircleDot, chord: "s" },
  { href: "/projects", label: "Projects", icon: FolderKanban, chord: "p" },
  { href: "/analytics", label: "Analytics", icon: LineChart, chord: "a" },
  { href: "/settings/plugins", label: "Plugins", icon: Plug, chord: "l" },
  { href: "/settings", label: "Settings", icon: Settings, chord: "," },
];

export function Sidebar({
  workspace,
  user,
}: {
  workspace: { name: string; key: string; avatarUrl?: string | null };
  user: { name?: string | null; image?: string | null; email: string };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const mod = useModKeyLabel();

  const chordMap = useMemo(() => {
    const m: Record<string, () => void> = {};
    for (const n of nav) m[n.chord] = () => router.push(n.href);
    return m;
  }, [router]);
  useChord("g", chordMap);

  return (
    <aside className="flex h-svh w-56 flex-col border-r border-border bg-card/40">
      <div className="flex h-12 items-center gap-2 px-4">
        <Avatar name={workspace.name} image={workspace.avatarUrl} size={20} />
        <span className="truncate text-[13px] font-semibold tracking-tight">{workspace.name}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{workspace.key}</span>
      </div>

      <button
        data-command-palette
        className="mx-3 mt-1 flex h-7 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-subtle"
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
        <span className="ml-auto kbd bg-ember/20 text-ember-foreground">C</span>
      </button>

      <nav className="mt-4 flex flex-col gap-px px-2">
        {nav.map(({ href, label, icon: Icon, chord }) => {
          const active = pathname === href || pathname?.startsWith(`${href}/`);
          return (
            <Link
              key={href}
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

      <UserMenu user={user} />
    </aside>
  );
}

function UserMenu({
  user,
}: {
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
        <Avatar name={user.name} image={user.image} size={22} />
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
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle"
            role="menuitem"
          >
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
            Workspace settings
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
