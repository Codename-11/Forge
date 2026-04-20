import "server-only";
import { skills as issueTriageSkills } from "@forge/plugins/issue-triage/handler";

/**
 * Static registry of `runtime: "local"` plugins.
 *
 * Local plugins run in-process and are imported statically so the bundler
 * includes them in the server bundle (with their full dependency graph:
 * db, logger, etc.). New local plugins are added here as a file change +
 * manifest entry — there's no dynamic filesystem discovery.
 *
 * For true dynamic extension without a deploy, use `runtime: "plugin"`
 * with an HTTP webhook (see plugin-runtime.ts).
 */
type SkillHandler = (
  input: unknown,
  ctx: { workspaceId: string; invokerUserId: string | null },
) => Promise<unknown>;

// Plugin handlers are authored with their own narrower Input/Output types;
// cast at registration to the uniform SkillHandler shape. The runtime
// re-validates input against the manifest's declared JSON Schema before
// dispatch, so this is safe.
export const localPlugins: Record<string, Record<string, SkillHandler>> = {
  "issue-triage": issueTriageSkills as unknown as Record<string, SkillHandler>,
};

export function getLocalSkill(slug: string, name: string): SkillHandler | undefined {
  return localPlugins[slug]?.[name];
}
