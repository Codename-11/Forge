"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  HelpCircle,
  LogOut,
  Moon,
  Plus,
  Settings,
  Sun,
  User as UserIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { PinsStrip } from "@/components/pins/pins-strip";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { signOutAction } from "@/server/actions/auth";
import { trpc } from "@/lib/trpc";
import { useCrossTab, useRealtime } from "@/hooks/use-realtime";
import { MOTION } from "@/lib/motion";

/**
 * Workspace-shell top bar.
 *
 * Lives at the top of every `/w/[slug]/*` screen. Composition (left → right):
 *
 *   [ brand slot | pins strip | quick-create · inbox badge · help · user menu ]
 *
 * The pins strip (cross-workspace personal favorites) used to live in the
 * sidebar and was moved here so the sidebar can collapse to an icon rail
 * without hiding the user's pins. The user menu is also promoted out of the
 * sidebar so it's always one click away, regardless of sidebar state.
 */
export function TopBar({
  user,
}: {
  user: { name?: string | null; image?: string | null; email: string };
}) {
  const ws = useMaybeWorkspace();
  const utils = trpc.useUtils();
  const { data: inboxBadge } = trpc.inbox.badge.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });

  // Live-update the badge when relevant realtime events fire. Any issue
  // mutation or new comment may change mentions / stalled / assigned
  // counts; keep it cheap by just invalidating the query.
  useRealtime(
    () => {
      void utils.inbox.badge.invalidate();
    },
    { subjectType: ["issue"] },
  );
  useRealtime(
    () => {
      void utils.inbox.badge.invalidate();
    },
    { kindPrefix: "COMMENT_" },
  );
  useCrossTab((msg) => {
    if (msg.type === "inbox:refresh") {
      void utils.inbox.badge.invalidate();
    }
  });

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card/30 px-3">
      {/* Left: reserved for breadcrumbs / per-page title injected by pages. */}
      <div className="hidden min-w-0 items-center md:flex" aria-hidden />

      {/* Center: cross-workspace pins. Truncates aggressively on narrow widths. */}
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <PinsStrip />
      </div>

      {/* Right: actions. Order = most-frequent first. */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-quick-create
          title="New issue (Shift+C)"
          className={cn(
            "focus-ring inline-flex h-7 items-center gap-1.5 rounded-md bg-ember px-2 text-[11px] font-medium text-ember-foreground hover:bg-ember/90",
            MOTION.fast,
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">New</span>
          <span className="kbd hidden bg-ember/20 text-ember-foreground md:inline">⇧C</span>
        </button>

        {ws && (
          <Link
            href={`/w/${ws.slug}/inbox`}
            title="Inbox (g i)"
            className={cn(
              "focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground",
              MOTION.fast,
            )}
          >
            <Bell className="h-3.5 w-3.5" />
            {inboxBadge && inboxBadge.count > 0 && (
              <span className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-ember px-1 text-center font-mono text-[11px] leading-[14px] text-ember-foreground">
                {inboxBadge.count > 99 ? "99+" : inboxBadge.count}
              </span>
            )}
          </Link>
        )}

        <button
          type="button"
          title="Keyboard shortcuts (?)"
          onClick={() => window.dispatchEvent(new Event("forge:open-keyboard-help"))}
          className={cn(
            "focus-ring inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground",
            MOTION.fast,
          )}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>

        <UserMenu user={user} wsSlug={ws?.slug} />
      </div>
    </header>
  );
}

function UserMenu({
  user,
  wsSlug,
}: {
  user: { name?: string | null; image?: string | null; email: string };
  wsSlug?: string;
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
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "focus-ring flex h-7 items-center gap-1.5 rounded-md pl-0.5 pr-1.5 hover:bg-subtle",
          open && "bg-subtle",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <AvatarFallback user={user} />
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] w-60 overflow-hidden rounded-md border border-border bg-card shadow-lg"
        >
          <div className="border-b border-border px-3 py-2">
            <div className="truncate text-xs font-medium">{user.name ?? user.email}</div>
            <div className="truncate text-[11px] text-muted-foreground">{user.email}</div>
          </div>
          <Link
            href="/settings/account"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle"
            role="menuitem"
          >
            <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />
            Account settings
          </Link>
          {wsSlug && (
            <Link
              href={`/w/${wsSlug}/settings/workspace`}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle"
              role="menuitem"
            >
              <Settings className="h-3.5 w-3.5 text-muted-foreground" />
              Workspace settings
            </Link>
          )}
          <Link
            href="/settings/workspaces"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle"
            role="menuitem"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            Manage workspaces
          </Link>

          <ThemeToggleRow />

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

function ThemeToggleRow() {
  // `next-themes` is already wired via `ThemeProvider` at the root layout.
  // Use it if available; gracefully fall back to a no-op button if not.
  const theme = useTheme();
  const current = theme?.theme ?? theme?.resolvedTheme ?? "light";
  const isDark = current === "dark";
  return (
    <button
      type="button"
      onClick={() => theme?.setTheme?.(isDark ? "light" : "dark")}
      className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs hover:bg-subtle"
      role="menuitem"
    >
      {isDark ? (
        <Sun className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <Moon className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      {isDark ? "Light mode" : "Dark mode"}
    </button>
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
    <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-subtle font-mono text-[11px] text-muted-foreground">
      {initials || "·"}
    </span>
  );
}
