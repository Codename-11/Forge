import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { MissionControlHome } from "@/components/global-shell/mission-control-home";

/**
 * Mission Control — the cross-workspace home. Renders inside the global
 * ("concourse") shell. Shell chrome (user + workspaces for the rail) is
 * resolved server-side; the aggregations stream client-side from the
 * `global.*` tRPC routers. Part of the multi-workspace restructure.
 */
export default async function MissionControlPage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/"
      crumbs={["Forge", "Mission Control"]}
      title="Mission Control"
      subtitle="Across all workspaces"
      eyebrow="Home"
      big
    >
      <MissionControlHome />
    </GlobalShell>
  );
}
