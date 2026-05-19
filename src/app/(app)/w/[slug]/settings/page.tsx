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
};

const ENTRIES: Entry[] = [
  {
    path: "/settings/workspace",
    title: "Workspace",
    description:
      "Name, avatar, sprint length (iteration cadence), time tracking on/off, per-workspace attachment storage cap, and the archive/delete danger zone.",
  },
  {
    path: "/settings/members",
    title: "Members",
    description: "Admin-gated: add teammates by email, change roles, remove access.",
    badge: "admin only",
  },
  {
    path: "/settings/statuses",
    title: "Statuses & workflow",
    description: "Customize the issue pipeline columns and their categories.",
  },
  {
    path: "/settings/labels",
    title: "Labels",
    description: "Colored tags for issues. Create, recolor, rename.",
  },
  {
    path: "/settings/templates",
    title: "Templates",
    description: "Reusable starting points for issues and projects. Stop hitting the blank page.",
  },
  {
    path: "/settings/recurring",
    title: "Recurring issues",
    description: "Auto-created on a cadence — weekly reviews, retros, standups.",
  },
  {
    path: "/settings/views",
    title: "Saved views",
    description: "Bookmark filter combos. Personal or shared.",
  },
];

const AUTOMATION: Entry[] = [
  {
    path: "/settings/agents",
    title: "Agents",
    description:
      "MCP-first actors that hold keys and receive work. Register Hermes, Claude, Codex, or custom profiles.",
  },
  {
    path: "/settings/dispatch-rules",
    title: "Dispatch rules",
    description:
      "Declarative routing layer: pin issues matching priority / label / project to a specific agent before the mode-based picker runs.",
  },
  {
    path: "/settings/crews",
    title: "Agent crews",
    description:
      "Bind agents into named crews with planner/worker/reviewer roles. Crews drive multi-agent execution plans and review gates.",
  },
];

const INTEGRATIONS: Entry[] = [
  {
    path: "/settings/integrations",
    title: "Integrations",
    description:
      "Connect external services. Browse available integrations and manage active connections.",
  },
  {
    path: "/settings/plugins",
    title: "Plugins",
    description:
      "Manifest-based extensions with scoped access. Register, approve, or suspend installed plugins.",
  },
  {
    path: "/settings/integrations/deliveries",
    title: "Webhook deliveries",
    description:
      "Inspect the webhook delivery queue. Drill into failures and requeue dead-lettered rows.",
    badge: "admin only",
  },
  {
    path: "/settings/admin",
    title: "Admin portal",
    description:
      "Workspace-wide observability — audit log, activity events, webhook delivery status.",
    badge: "admin only",
  },
];

const ACCOUNT: Entry[] = [
  {
    path: "/settings/account",
    title: "Account",
    description: "Profile, timezone, locale, time format, theme.",
  },
  {
    path: "/settings/appearance",
    title: "Appearance",
    description: "Density and text size. Saved per user.",
  },
  {
    path: "/settings/access",
    title: "Developer access",
    description:
      "API keys + MCP endpoints. Provider setup for Hermes, Claude, Codex, custom HTTP, and env vars.",
    badge: "external agents",
  },
  {
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
              <span className="rounded border border-ember/30 bg-ember/10 px-1.5 py-0.5 text-[0.6875rem] uppercase tracking-wider text-ember">
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
  const resolve = (s: Entry) => w(s.path);

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

          <Section title="Automation">
            <Card>
              {AUTOMATION.map((s) => (
                <EntryRow key={s.path} href={resolve(s)} s={s} />
              ))}
            </Card>
          </Section>

          <Section title="Integrations">
            <Card>
              {INTEGRATIONS.map((s) => (
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
