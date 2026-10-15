import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { AgentDetailContent } from "@/app/(app)/settings/agents/[id]/agent-detail-content";

/** Agent identity, workspace access, and connection detail. */
export default async function AgentFleetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ workspace?: string; setup?: string }>;
}) {
  const [data, { id }, query] = await Promise.all([getGlobalShellData(), params, searchParams]);
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/agents"
      crumbs={[
        { label: "Home", href: "/" },
        { label: "Agents", href: "/agents" },
        { label: "Profile" },
      ]}
      scope="control"
      contentClass="flex flex-col overflow-hidden"
    >
      <AgentDetailContent
        id={id}
        isInstanceAdmin={data.user.instanceRole === "INSTANCE_ADMIN"}
        workspaces={data.workspaces}
        initialWorkspaceId={query.workspace}
        setupMode={
          query.setup === "external" || query.setup === "managed" ? query.setup : undefined
        }
      />
    </GlobalShell>
  );
}
