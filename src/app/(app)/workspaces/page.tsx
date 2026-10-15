import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import WorkspacesContent from "@/components/global-shell/workspaces-content";

export default async function WorkspacesPage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");
  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      crumbs={[{ label: "Home", href: "/" }, { label: "Workspaces" }]}
      contentClass="flex flex-col overflow-hidden"
    >
      <WorkspacesContent />
    </GlobalShell>
  );
}
