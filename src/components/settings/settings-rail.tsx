"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Bot, PlugZap, Search, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ACCOUNT_SETTINGS_GROUP,
  WORKSPACE_SETTINGS_GROUPS,
  type SettingsNavItem,
} from "./settings-nav";

/**
 * Settings rail — the 244px left-hand navigation for the settings section
 * (design `SettingsLayout`). Replaces the old horizontal navbar: grouped
 * nav with per-item hint subtitles + admin pills, a "Search settings" box
 * with a `/` focus shortcut, and an ember-tinted active row. Sits to the
 * right of the global app sidebar, left of the settings detail pane.
 */

type RailItem = {
  href: string;
  label: string;
  icon: SettingsNavItem["icon"];
  hint: string;
  adminOnly: boolean;
};
type RailGroup = { id: string; label: string; hint?: string; items: RailItem[] };

type SettingsRailProps =
  | { scope: "workspace"; slug: string }
  | { scope: "account"; backHref: string; backLabel: string; email: string };

export function SettingsRail(props: SettingsRailProps) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(
    () => (props.scope === "workspace" ? workspaceGroups(props.slug) : accountGroups()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.scope, props.scope === "workspace" ? props.slug : null],
  );

  // `/` focuses the search box (unless already typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter(
            (it) =>
              it.label.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q),
          ),
        }))
        .filter((g) => g.items.length > 0)
    : groups;

  return (
    <aside className="flex max-h-64 min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-border bg-card/30 md:h-full md:max-h-none md:w-60 md:border-b-0 md:border-r">
      {props.scope === "account" && (
        <div className="border-b border-border/60 px-3 pt-3 pb-2">
          <Link
            href={props.backHref}
            className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.75rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="truncate">{props.backLabel}</span>
          </Link>
        </div>
      )}

      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            className="focus-ring h-7 w-full rounded-md border border-border bg-background px-2 pl-7 text-xs text-foreground placeholder:text-muted-foreground"
          />
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          {!query && (
            <span className="kbd absolute right-1.5 top-1/2 -translate-y-1/2">/</span>
          )}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {filtered.length === 0 && (
          <p className="px-2 py-3 text-meta text-muted-foreground">No settings match.</p>
        )}
        {filtered.map((g, gi) => (
          <div key={g.id} className={gi === 0 ? "" : "mt-3"}>
            <div className="flex items-baseline gap-1.5 px-2 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {g.label}
              </span>
              {g.hint && (
                <span className="hidden truncate text-meta text-muted-foreground/60 sm:inline">
                  · {g.hint}
                </span>
              )}
            </div>
            <ul className="flex flex-col gap-px">
              {g.items.map((it) => {
                const active = isActive(pathname, it.href);
                return (
                  <li key={it.href}>
                    <Link
                      href={it.href}
                      className={cn(
                        "group flex items-start gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] transition-colors",
                        active
                          ? "bg-ember/10 text-foreground"
                          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
                      )}
                    >
                      <it.icon
                        className={cn(
                          "mt-0.5 h-3.5 w-3.5 shrink-0",
                          active && "text-ember",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-medium">{it.label}</span>
                          {it.adminOnly && (
                            <span className="rounded border border-ember/30 bg-ember/10 px-1 text-[9px] font-medium uppercase tracking-wider text-ember">
                              admin
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-meta text-muted-foreground/80">
                          {it.hint}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {props.scope === "account" && (
        <div className="shrink-0 border-t border-border/60 px-3 py-2">
          <div className="truncate text-[0.6875rem] text-muted-foreground">
            Signed in as <span className="font-medium">{props.email}</span>
          </div>
        </div>
      )}
    </aside>
  );
}

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function workspaceGroups(slug: string): RailGroup[] {
  return WORKSPACE_SETTINGS_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    hint: group.hint,
    items: group.items.map((item) => ({
      href: `/w/${slug}/settings${item.path}`,
      label: item.label,
      icon: item.icon,
      hint: item.description,
      adminOnly: (item.badge ?? "").toLowerCase().includes("admin"),
    })),
  }));
}

/**
 * Cross-workspace items that live at the bare `/settings/*` root alongside
 * the account group: global agent **profiles**, the runtimes (hosts)
 * you've registered, and your OAuth connections. Added by the
 * multi-workspace restructure — they travel with your account, not a
 * workspace, so they belong in the account-scope rail.
 */
const GLOBAL_RAIL_ITEMS: RailItem[] = [
  {
    href: "/settings/agents",
    label: "Agents",
    icon: Bot,
    hint: "Profiles (definitions)",
    adminOnly: false,
  },
  {
    href: "/settings/runtimes",
    label: "Runtimes",
    icon: Server,
    hint: "Hosts I've registered",
    adminOnly: false,
  },
  {
    href: "/settings/connections",
    label: "Connections",
    icon: PlugZap,
    hint: "OAuth identities",
    adminOnly: false,
  },
];

function accountGroups(): RailGroup[] {
  return [
    {
      id: ACCOUNT_SETTINGS_GROUP.id,
      label: ACCOUNT_SETTINGS_GROUP.label,
      hint: ACCOUNT_SETTINGS_GROUP.hint,
      items: [
        ...GLOBAL_RAIL_ITEMS,
        ...ACCOUNT_SETTINGS_GROUP.items.map((item) => ({
          // Account paths are already rooted at `/settings`.
          href: item.path,
          label: item.label,
          icon: item.icon,
          hint: item.description,
          adminOnly: (item.badge ?? "").toLowerCase().includes("admin"),
        })),
      ],
    },
  ];
}
