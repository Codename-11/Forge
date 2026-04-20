import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { Section } from "@/components/settings/section";
import { Card } from "@/components/settings/card";

type Entry = {
  href: string;
  title: string;
  description: string;
  badge?: string;
};

const GENERAL: Entry[] = [
  {
    href: "/settings/account",
    title: "Account",
    description: "Profile, timezone, locale, time format, theme.",
  },
];

const WORKSPACE: Entry[] = [
  {
    href: "/settings/members",
    title: "Members",
    description: "Invite teammates and manage their workspace role.",
  },
  {
    href: "/settings/statuses",
    title: "Statuses & workflow",
    description: "Customize the issue pipeline columns and their categories.",
  },
  {
    href: "/settings/labels",
    title: "Labels",
    description: "Colored tags for issues. Create, recolor, rename.",
  },
  {
    href: "/settings/templates",
    title: "Issue templates",
    description: "Reusable starting points. Stop hitting the blank page.",
  },
  {
    href: "/settings/project-templates",
    title: "Project templates",
    description: "Starter suggestions shown on the Projects page.",
  },
  {
    href: "/settings/recurring",
    title: "Recurring issues",
    description: "Auto-created on a cadence — weekly reviews, retros, standups.",
  },
  {
    href: "/settings/views",
    title: "Saved views",
    description: "Bookmark filter combos. Personal or shared.",
  },
];

const DEVELOPER: Entry[] = [
  {
    href: "/settings/access",
    title: "Developer access",
    description:
      "API keys + MCP endpoints. Copy-paste blocks for Claude Desktop, Claude Code, curl, and env vars.",
    badge: "external agents",
  },
  {
    href: "/settings/plugins",
    title: "Plugins & integrations",
    description:
      "Manifest-based extensions with scoped access. Register, approve, or suspend installed plugins.",
  },
  {
    href: "/settings/admin",
    title: "Admin portal",
    description:
      "Workspace-wide observability — audit log, activity events, webhook delivery status.",
    badge: "admin only",
  },
];

function EntryRow({ s }: { s: Entry }) {
  return (
    <li>
      <Link
        href={s.href}
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
  return (
    <>
      <Topbar title="Settings" subtitle="Workspace and personal settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Section title="General">
            <Card>
              {GENERAL.map((s) => (
                <EntryRow key={s.href} s={s} />
              ))}
            </Card>
          </Section>

          <Section title="Workspace">
            <Card>
              {WORKSPACE.map((s) => (
                <EntryRow key={s.href} s={s} />
              ))}
            </Card>
          </Section>

          <Section title="Developer">
            <Card>
              {DEVELOPER.map((s) => (
                <EntryRow key={s.href} s={s} />
              ))}
            </Card>
          </Section>
        </div>
      </div>
    </>
  );
}
