import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { PersonalHome } from "@/components/global-shell/personal-home";

/**
 * Personal home across accessible workspaces. Operational health has its
 * own /mission-control route so runtime setup does not gate everyday work.
 */
export default async function HomePage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/"
      crumbs={[{ label: "Home" }]}
      title="My work"
      subtitle="Your assignments and workspaces, together."
      big
    >
      <PersonalHome workspaces={data.workspaces} />
    </GlobalShell>
  );
}
