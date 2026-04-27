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
  const activeGroup = groups.find((group) =>
    group.items.some((item) => isActiveItem(pathname, item)),
  ) ?? groups[0];

  if (props.scope === "account") {
    return (
      <div className="shrink-0 border-b border-border bg-card/30">
        <div className="flex min-h-12 flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center lg:px-4">
          <Link
            href={props.backHref}
            className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.75rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="truncate">{props.backLabel}</span>
          </Link>

          <SettingsLinkRow
            label="Account settings"
            items={activeGroup.items}
            pathname={pathname}
            className="lg:justify-center"
          />

          <div className="hidden max-w-64 truncate text-[0.6875rem] text-muted-foreground lg:block">
            Signed in as <span className="font-medium">{props.email}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-border bg-card/30">
      <div className="px-3 py-2 lg:px-4">
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto pb-1">
          {groups.map((group) => {
            const active = group.label === activeGroup.label;
            const first = group.items[0];
            return (
              <Link
                key={group.label}
                href={first.href}
                className={cn(
                  "focus-ring inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-[0.8125rem] font-medium transition-colors",
                  active
                    ? "border-border bg-background text-foreground shadow-sm"
                    : "border-transparent text-muted-foreground hover:bg-subtle hover:text-foreground",
                )}
              >
                {group.label}
              </Link>
            );
          })}
        </nav>

        <SettingsLinkRow
          label={`${activeGroup.label} settings`}
          items={activeGroup.items}
          pathname={pathname}
          className="border-t border-border/60 pt-1.5"
        />
      </div>
    </div>
  );
}

function SettingsLinkRow({
  label,
  items,
  pathname,
  className,
}: {
  label: string;
  items: NavItem[];
  pathname: string | null;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn("flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1 lg:pb-0", className)}
    >
      {items.map((item) => {
        const active = isActiveItem(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[0.75rem] transition-colors",
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
    </nav>
  );
}

function isActiveItem(pathname: string | null, item: NavItem) {
  if (!pathname) return false;
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
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
