import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { GlobalInbox } from "@/components/global-shell/global-inbox";

/**
 * Global inbox — cross-workspace assignments for the signed-in user,
 * rendered in the concourse shell. The workspace-scoped inbox still lives
 * at `/w/<slug>/inbox`. Part of the multi-workspace restructure.
 */
export default async function GlobalInboxPage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/inbox"
      crumbs={["Forge", "Inbox"]}
      title="Inbox"
      subtitle="Assignments across all your workspaces"
      eyebrow="Across workspaces"
    >
      <GlobalInbox />
    </GlobalShell>
  );
}
