import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { MissionControlHome } from "@/components/global-shell/mission-control-home";

export default async function MissionControlPage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      crumbs={[{ label: "Home", href: "/" }, { label: "Mission Control" }]}
      title="Mission Control"
      subtitle="Agent operations and delivery across your accessible workspaces."
      big
    >
      <MissionControlHome />
    </GlobalShell>
  );
}
