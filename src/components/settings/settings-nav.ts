import {
  Bot,
  ClipboardList,
  DatabaseBackup,
  Github,
  Key,
  Layers,
  ListChecks,
  Palette,
  Plug,
  PlugZap,
  Repeat,
  Send,
  Settings as SettingsIcon,
  Shield,
  Tag,
  User as UserIcon,
  Users,
  Workflow,
} from "lucide-react";

export type SettingsNavItem = {
  /**
   * Path relative to the settings root. Workspace items resolve under
   * `/w/<slug>/settings`, account items under `/settings`. Consumers add
   * the prefix — keep these root-relative so the two scopes share one list.
   */
  path: string;
  label: string;
  icon: typeof Users;
  /** Shown on the settings Overview index cards. */
  description: string;
  /** Small uppercase chip (e.g. "admin only", "external agents"). */
  badge?: string;
};

export type SettingsNavGroup = {
  id: string;
  label: string;
  /** Optional sub-label shown under the group heading on the Overview. */
  hint?: string;
  items: readonly SettingsNavItem[];
};

/**
 * Single source of truth for workspace settings navigation.
 *
 * Both the {@link SettingsRail} and the settings Overview index
 * (`/w/<slug>/settings`) render from this list, so the two surfaces can
 * never drift (they used to maintain separate, disagreeing inventories —
 * crews appeared in one, runtimes in the other, admin in different groups).
 *
 * Agent **crews** intentionally live at the top-level `/crews` route (with a
 * `/crews/<id>` detail view), not here — crew creation and roster management
 * happen there so the operator never has to detour through settings.
 */
export const WORKSPACE_SETTINGS_GROUPS: readonly SettingsNavGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    hint: "Applies to everyone in this workspace.",
    items: [
      {
        path: "/workspace",
        label: "General",
        icon: SettingsIcon,
        description:
          "Name, avatar, sprint length (iteration cadence), time tracking, the attachment storage cap, and the archive/delete danger zone.",
      },
      {
        path: "/members",
        label: "Members",
        icon: Users,
        badge: "admin only",
        description: "Add teammates by email, change roles, remove access.",
      },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    items: [
      {
        path: "/statuses",
        label: "Statuses",
        icon: ListChecks,
        description: "Customize the issue pipeline columns and their categories.",
      },
      {
        path: "/labels",
        label: "Labels",
        icon: Tag,
        description: "Colored tags for issues. Create, recolor, rename.",
      },
      {
        path: "/templates",
        label: "Templates",
        icon: ClipboardList,
        description:
          "Reusable starting points for issues and projects. Stop hitting the blank page.",
      },
      {
        path: "/views",
        label: "Saved views",
        icon: Layers,
        description: "Bookmark filter combos. Personal or shared.",
      },
      {
        path: "/recurring",
        label: "Recurring",
        icon: Repeat,
        description: "Auto-created on a cadence — weekly reviews, retros, standups.",
      },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [
      {
        path: "/agents",
        label: "Agent policy",
        icon: Bot,
        description:
          "Set capacity, engagement, routing eligibility, and approval policy for agents bound from Mission Control.",
      },
      {
        path: "/dispatch-rules",
        label: "Dispatch & routing",
        icon: Workflow,
        description:
          "Declarative routing: pin issues matching priority / label / project to a specific agent before the mode-based picker runs.",
      },
      {
        path: "/access",
        label: "Agent access",
        icon: Key,
        badge: "admin only",
        description:
          "MCP clients, API keys, scopes, provider setup, rotation, and revocation in one place.",
      },
    ],
  },
  {
    id: "connections",
    label: "Connections",
    hint: "Inbound + outbound I/O. For agents and their runtimes, see Automation → Agents.",
    items: [
      {
        path: "/connections",
        label: "Connections",
        icon: PlugZap,
        description:
          "Inbound and outbound I/O — GitHub, Slack, email-to-issue, custom webhooks. For agents, see Automation.",
      },
      {
        path: "/github-apps",
        label: "GitHub Apps",
        icon: Github,
        description:
          "Workspace GitHub Apps for realtime issue/PR sync and short-lived runtime GH_TOKEN credentials.",
      },
      {
        path: "/plugins",
        label: "Plugins",
        icon: Plug,
        description:
          "Manifest-based extensions with scoped access. Register, approve, or suspend installed plugins.",
      },
      {
        path: "/deliveries",
        label: "Webhook deliveries",
        icon: Send,
        badge: "admin only",
        description:
          "Inspect the webhook delivery queue. Drill into failures and requeue dead-lettered rows.",
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      {
        path: "/admin",
        label: "Admin portal",
        icon: Shield,
        badge: "admin only",
        description:
          "Workspace-wide observability — audit log, activity events, webhook delivery status.",
      },
      {
        path: "/data",
        label: "Data export / import",
        icon: DatabaseBackup,
        badge: "admin only",
        description:
          "Download this workspace's core content as a portable JSON snapshot, or import one into this workspace. Great for cloning a workspace into local dev.",
      },
    ],
  },
] as const;

/**
 * Account-level settings. These live at the bare `/settings/*` root (global
 * to the user, shared across workspaces) rather than under a workspace, so
 * their `path` values are already rooted at `/settings`.
 */
export const ACCOUNT_SETTINGS_GROUP: SettingsNavGroup = {
  id: "personal",
  label: "Personal",
  hint: "Follows you across every workspace.",
  items: [
    {
      path: "/settings/account",
      label: "Profile & regional",
      icon: UserIcon,
      description: "Profile, timezone, locale, time format, theme.",
    },
    {
      path: "/settings/appearance",
      label: "Appearance",
      icon: Palette,
      description: "Density, text size, and motion. Saved per user.",
    },
    {
      path: "/settings/workspaces",
      label: "Workspaces",
      icon: Layers,
      description: "Create, rename, archive, or switch workspaces you belong to.",
    },
  ],
};
