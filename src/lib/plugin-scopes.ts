/**
 * Scope → human blurb copy, shared between the plugins list page
 * (Permission reference grid) and the plugin detail page (Approved
 * scopes rows). Keyed by the real `PluginScope` enum values from
 * `prisma/schema.prisma` — keep this in lockstep with that enum.
 *
 * A plugin's approved scopes are the ceiling for any API key issued to
 * it; reviewers should approve the smallest set that does the job.
 */
export const PLUGIN_SCOPE_HELP: Record<string, string> = {
  READ_ISSUES: "List + read issues and their fields",
  WRITE_ISSUES: "Create, edit, transition issues",
  READ_PROJECTS: "Projects, initiatives, sprints",
  WRITE_PROJECTS: "Create + edit projects/initiatives",
  READ_COMMENTS: "Read issue + entity comments",
  WRITE_COMMENTS: "Post comments and status updates",
  READ_USERS: "Members + roles (no emails)",
  READ_ANALYTICS: "Aggregate metrics + rollups",
  SUBSCRIBE_EVENTS: "Receive outbound webhook events",
  INVOKE_SKILLS: "Call registered plugin skills",
  ADMIN: "Full workspace administration",
};

/** Stable display order for the permission reference grid. */
export const PLUGIN_SCOPE_ORDER = Object.keys(
  PLUGIN_SCOPE_HELP,
) as (keyof typeof PLUGIN_SCOPE_HELP)[];
