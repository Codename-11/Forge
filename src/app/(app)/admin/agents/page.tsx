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
      crumbs={["Instance", "Agent governance"]}
      eyebrow="Instance"
      title="Agent governance"
      subtitle="Approve requests · control instance sharing · force-disable across every workspace"
    >
      <AdminAgents />
    </AdminPage>
  );
}
