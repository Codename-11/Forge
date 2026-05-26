import { redirect } from "next/navigation";
import { getGlobalShellData } from "@/components/global-shell/data";
import { AgentsContent } from "./agents-content";

/**
 * Global agent **profiles** — the user-owned definitions (the same
 * profile reaches every workspace it's bound to). Lives at the bare
 * `/settings/agents` (account scope) and renders inside the settings
 * layout's `SettingsRail`. Creating a profile is instance-admin-gated;
 * members see a muted "requires instance admin" hint. Part of the
 * multi-workspace restructure.
 */
export default async function GlobalAgentsPage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");
  return <AgentsContent isInstanceAdmin={data.user.instanceRole === "INSTANCE_ADMIN"} />;
}
