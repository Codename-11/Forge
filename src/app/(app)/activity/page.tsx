import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { GlobalActivity } from "@/components/global-shell/global-activity";

/**
 * Global activity feed — cross-workspace events for the signed-in user,
 * the full-page counterpart to the chord-G-5 Activity dock. Part of the
 * multi-workspace restructure.
 */
export default async function GlobalActivityPage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/activity"
      crumbs={["Forge", "Activity"]}
      title="Activity"
      subtitle="Live run & event feed across all your workspaces"
      eyebrow="Across workspaces"
    >
      <GlobalActivity />
    </GlobalShell>
  );
}
