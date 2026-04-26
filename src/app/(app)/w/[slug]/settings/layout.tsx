"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Boxes,
  ClipboardList,
  Layers,
  ListChecks,
  Plug,
  Repeat,
  Send,
  Settings as SettingsIcon,
  Shield,
  Tag,
  Users,
  Workflow,
} from "lucide-react";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";

/**
 * Workspace-settings shell. Sits inside the workspace shell (sidebar +
 * topbar are still visible above) and adds a secondary nav column on
 * the left so users can move between settings surfaces without bouncing
 * through the /settings landing page each time.
 *
 * Order maps to the four logical buckets — General, Automation,
 * Developer, Workflow — keeping each sub-page focused on one concern.
 */
export default function WorkspaceSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ws = useWorkspace();
  const pathname = usePathname();
  const w = (p: string) => `/w/${ws.slug}/settings${p}`;

  const groups: Array<{
    label: string;
    items: Array<{
      href: string;
      label: string;
      Icon: React.ComponentType<{ className?: string }>;
    }>;
  }> = [
    {
      label: "Workspace",
      items: [
        { href: w(""), label: "Overview", Icon: SettingsIcon },
        { href: w("/workspace"), label: "General", Icon: SettingsIcon },
        { href: w("/members"), label: "Members", Icon: Users },
      ],
    },
    {
      label: "Workflow",
      items: [
        { href: w("/statuses"), label: "Statuses", Icon: ListChecks },
        { href: w("/labels"), label: "Labels", Icon: Tag },
        { href: w("/templates"), label: "Issue templates", Icon: ClipboardList },
        { href: w("/project-templates"), label: "Project templates", Icon: Boxes },
        { href: w("/recurring"), label: "Recurring", Icon: Repeat },
        { href: w("/views"), label: "Saved views", Icon: Layers },
      ],
    },
    {
      label: "Automation",
      items: [
        { href: w("/agents"), label: "Agents", Icon: Bot },
        { href: w("/dispatch-rules"), label: "Dispatch rules", Icon: Workflow },
      ],
    },
    {
      label: "Developer",
      items: [
        { href: w("/plugins"), label: "Plugins", Icon: Plug },
        { href: w("/admin"), label: "Admin portal", Icon: Shield },
        {
          href: w("/integrations/deliveries"),
          label: "Webhook deliveries",
          Icon: Send,
        },
      ],
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col gap-4 border-r border-border bg-card/30 px-2 py-4 max-md:hidden">
        <div className="px-3 text-[0.6875rem] uppercase tracking-wider text-muted-foreground/80">
          Settings
        </div>
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-px">
            <div className="px-3 pb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {group.label}
            </div>
            {group.items.map((it) => {
              const active =
                pathname === it.href || pathname.startsWith(`${it.href}/`);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={cn(
                    "row h-8 rounded-md px-2 text-[0.8125rem]",
                    active
                      ? "bg-subtle text-foreground"
                      : "text-muted-foreground hover:bg-subtle hover:text-foreground",
                  )}
                >
                  <it.Icon className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{it.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-px">
          <Link
            href="/settings/account"
            className="row h-8 rounded-md px-4 text-[0.8125rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <span className="truncate">Account settings →</span>
          </Link>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
