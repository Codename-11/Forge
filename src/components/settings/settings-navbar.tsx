"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  Boxes,
  ClipboardList,
  Key,
  Layers,
  ListChecks,
  Palette,
  Plug,
  Repeat,
  Send,
  Settings as SettingsIcon,
  Shield,
  Tag,
  User as UserIcon,
  Users,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

type SettingsNavbarProps =
  | {
      scope: "workspace";
      slug: string;
    }
  | {
      scope: "account";
      backHref: string;
      backLabel: string;
      email: string;
    };

export function SettingsNavbar(props: SettingsNavbarProps) {
  const pathname = usePathname();
  const groups = props.scope === "workspace" ? workspaceGroups(props.slug) : accountGroups();

  return (
    <div className="shrink-0 border-b border-border bg-card/30">
      <div className="flex min-h-12 flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center lg:px-4">
        {props.scope === "account" && (
          <Link
            href={props.backHref}
            className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.75rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="truncate">{props.backLabel}</span>
          </Link>
        )}

        <nav
          aria-label={props.scope === "workspace" ? "Workspace settings" : "Account settings"}
          className="flex min-w-0 flex-1 gap-3 overflow-x-auto pb-1 lg:pb-0"
        >
          {groups.map((group) => (
            <div key={group.label} className="flex shrink-0 items-center gap-1">
              <div className="mr-1 hidden text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground/60 xl:block">
                {group.label}
              </div>
              {group.items.map((item) => {
                const active = item.exact
                  ? pathname === item.href
                  : pathname === item.href || pathname?.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] transition-colors",
                      active
                        ? "bg-subtle text-foreground"
                        : "text-muted-foreground hover:bg-subtle/70 hover:text-foreground",
                    )}
                  >
                    <item.Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {props.scope === "account" && (
          <div className="hidden max-w-64 truncate text-[0.6875rem] text-muted-foreground lg:block">
            Signed in as <span className="font-medium">{props.email}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function workspaceGroups(slug: string): NavGroup[] {
  const w = (p: string) => `/w/${slug}/settings${p}`;
  return [
    {
      label: "Workspace",
      items: [
        { href: w(""), label: "Overview", Icon: SettingsIcon, exact: true },
        { href: w("/workspace"), label: "General", Icon: SettingsIcon },
        { href: w("/members"), label: "Members", Icon: Users },
      ],
    },
    {
      label: "Workflow",
      items: [
        { href: w("/statuses"), label: "Statuses", Icon: ListChecks },
        { href: w("/labels"), label: "Labels", Icon: Tag },
        { href: w("/templates"), label: "Templates", Icon: ClipboardList },
        { href: w("/project-templates"), label: "Projects", Icon: Boxes },
        { href: w("/recurring"), label: "Recurring", Icon: Repeat },
        { href: w("/views"), label: "Views", Icon: Layers },
      ],
    },
    {
      label: "Automation",
      items: [
        { href: w("/agents"), label: "Agents", Icon: Bot },
        { href: w("/dispatch-rules"), label: "Dispatch", Icon: Workflow },
      ],
    },
    {
      label: "Developer",
      items: [
        { href: w("/plugins"), label: "Plugins", Icon: Plug },
        { href: w("/admin"), label: "Admin", Icon: Shield },
        { href: w("/integrations/deliveries"), label: "Deliveries", Icon: Send },
      ],
    },
    {
      label: "Account",
      items: [{ href: "/settings/account", label: "Account", Icon: UserIcon }],
    },
  ];
}

function accountGroups(): NavGroup[] {
  return [
    {
      label: "Account",
      items: [
        { href: "/settings/account", label: "Profile", Icon: UserIcon },
        { href: "/settings/appearance", label: "Appearance", Icon: Palette },
        { href: "/settings/access", label: "Developer access", Icon: Key },
        { href: "/settings/workspaces", label: "Workspaces", Icon: Layers },
      ],
    },
  ];
}
