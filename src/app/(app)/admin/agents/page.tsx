import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminAgents } from "@/components/admin-shell/admin-agents";

/**
 * `/admin/agents` — instance agent policy: share/disable global agent
 * profiles. Part of the multi-workspace restructure.
 */
export default function AdminAgentsPage() {
  return (
    <AdminPage
      activePath="/admin/agents"
      crumbs={["Instance", "Agent policy"]}
      eyebrow="Instance"
      title="Agent policy"
      subtitle="Share profiles to every workspace · force-disable across the instance"
    >
      <AdminAgents />
    </AdminPage>
  );
}
