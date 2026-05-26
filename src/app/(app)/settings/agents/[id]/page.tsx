import { AgentDetailContent } from "./agent-detail-content";

/**
 * Global agent profile detail — definition card + per-workspace bindings
 * table + cross-workspace recent runs. Reads from `agents.profiles.get`.
 * Renders inside the settings layout `SettingsRail`. Part of the
 * multi-workspace restructure.
 */
export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentDetailContent id={id} />;
}
