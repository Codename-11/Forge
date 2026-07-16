import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { AgentDetailContent } from "@/app/(app)/settings/agents/[id]/agent-detail-content";

/** Mission Control profile detail and binding control surface. */
export default async function AgentFleetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [data, { id }] = await Promise.all([getGlobalShellData(), params]);
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/agents"
      crumbs={["Forge", "Mission Control", "Agents", "Profile"]}
      scope="control"
      contentClass="flex flex-col overflow-hidden"
    >
      <AgentDetailContent
        id={id}
        isInstanceAdmin={data.user.instanceRole === "INSTANCE_ADMIN"}
        workspaces={data.workspaces}
      />
    </GlobalShell>
  );
}
