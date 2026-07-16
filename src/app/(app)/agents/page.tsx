import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { AgentsContent } from "@/app/(app)/settings/agents/agents-content";

/** Mission Control fleet: define, bind, and operate global agent identities. */
export default async function AgentFleetPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const [data, query] = await Promise.all([getGlobalShellData(), searchParams]);
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/agents"
      crumbs={["Forge", "Mission Control", "Agents"]}
      title="Agent fleet"
      subtitle="Define identities, connect execution, bind workspaces, and monitor live use."
      eyebrow="Mission Control"
      scope="control"
      contentClass="flex flex-col overflow-hidden"
    >
      <AgentsContent
        isInstanceAdmin={data.user.instanceRole === "INSTANCE_ADMIN"}
        workspaces={data.workspaces}
        initialWorkspaceId={query.workspace}
      />
    </GlobalShell>
  );
}
