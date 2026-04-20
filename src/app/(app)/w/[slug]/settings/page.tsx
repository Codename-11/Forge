"use client";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { Section } from "@/components/settings/section";
import { Card } from "@/components/settings/card";
import { useWorkspace } from "@/hooks/use-workspace";

type Entry = {
  path: string;
  title: string;
  description: string;
  badge?: string;
  scope: "workspace" | "account";
};

const ENTRIES: Entry[] = [
  {
    scope: "workspace",
    path: "/settings/workspace",
    title: "Workspace",
    description:
      "Name, avatar, cycle length, time tracking, attachment quota, and danger zone.",
  },
  {
    scope: "workspace",
    path: "/settings/members",
    title: "Members",
    description: "Invite teammates and manage their workspace role.",
  },
  {
    scope: "workspace",
    path: "/settings/statuses",
    title: "Statuses & workflow",
    description: "Customize the issue pipeline columns and their categories.",
  },
  {
    scope: "workspace",
    path: "/settings/labels",
    title: "Labels",
    description: "Colored tags for issues. Create, recolor, rename.",
  },
  {
    scope: "workspace",
    path: "/settings/templates",
    title: "Issue templates",
    description: "Reusable starting points. Stop hitting the blank page.",
  },
  {
    scope: "workspace",
    path: "/settings/project-templates",
    title: "Project templates",
    description: "Starter suggestions shown on the Projects page.",
  },
  {
    scope: "workspace",
    path: "/settings/recurring",
    title: "Recurring issues",
    description: "Auto-created on a cadence — weekly reviews, retros, standups.",
  },
  {
    scope: "workspace",
    path: "/settings/views",
    title: "Saved views",
    description: "Bookmark filter combos. Personal or shared.",
  },
];

const DEVELOPER: Entry[] = [
  {
    scope: "workspace",
    path: "/settings/plugins",
    title: "Plugins & integrations",
    description:
      "Manifest-based extensions with scoped access. Register, approve, or suspend installed plugins.",
  },
  {
    scope: "workspace",
    path: "/settings/admin",
    title: "Admin portal",
    description:
      "Workspace-wide observability — audit log, activity events, webhook delivery status.",
    badge: "admin only",
  },
];

const ACCOUNT: Entry[] = [
  {
    scope: "account",
    path: "/settings/account",
    title: "Account",
    description: "Profile, timezone, locale, time format, theme.",
  },
  {
    scope: "account",
    path: "/settings/access",
    title: "Developer access",
    description:
      "API keys + MCP endpoints. Copy-paste blocks for Claude Desktop, Claude Code, curl, and env vars.",
    badge: "external agents",
  },
  {
    scope: "account",
    path: "/settings/workspaces",
    title: "Workspaces",
    description: "Create, rename, archive, or switch workspaces you belong to.",
  },
];

function EntryRow({ href, s }: { href: string; s: Entry }) {
  return (
    <li>
      <Link
        href={href}
        className="group flex items-start gap-4 px-4 py-3 hover:bg-subtle/60"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{s.title}</span>
            {s.badge && (
              <span className="rounded border border-ember/30 bg-ember/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ember">
                {s.badge}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{s.description}</div>
        </div>
        <span className="mt-1 text-muted-foreground transition-colors group-hover:text-ember">
          →
        </span>
      </Link>
    </li>
  );
}

export default function SettingsPage() {
  const ws = useWorkspace();
  const w = (p: string) => `/w/${ws.slug}${p}`;
  const resolve = (s: Entry) => (s.scope === "workspace" ? w(s.path) : s.path);

  return (
    <>
      <Topbar title="Settings" subtitle={`${ws.name} · workspace configuration`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Section title="Workspace" hint="Applies to everyone in this workspace.">
            <Card>
              {ENTRIES.map((s) => (
                <EntryRow key={s.path} href={resolve(s)} s={s} />
              ))}
            </Card>
          </Section>

          <Section title="Developer">
            <Card>
              {DEVELOPER.map((s) => (
                <EntryRow key={s.path} href={resolve(s)} s={s} />
              ))}
            </Card>
          </Section>

          <Section title="Account" hint="Tied to your login, shared across all workspaces.">
            <Card>
              {ACCOUNT.map((s) => (
                <EntryRow key={s.path} href={resolve(s)} s={s} />
              ))}
            </Card>
          </Section>
        </div>
      </div>
    </>
  );
}
