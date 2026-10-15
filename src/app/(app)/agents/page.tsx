import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { AgentsContent } from "@/app/(app)/settings/agents/agents-content";

/** Agent identity, access, and connection setup. */
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
      crumbs={[{ label: "Home", href: "/" }, { label: "Agents" }]}
      title="Agents"
      subtitle="Manage identities, workspace access, and how agents connect or execute."
      eyebrow="Agents"
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
