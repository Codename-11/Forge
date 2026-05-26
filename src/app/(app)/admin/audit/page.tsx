import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminAudit } from "@/components/admin-shell/admin-audit";

/**
 * `/admin/audit` — cross-tenant audit feed (paginated). Part of the
 * multi-workspace restructure.
 */
export default function AdminAuditPage() {
  return (
    <AdminPage
      activePath="/admin/audit"
      crumbs={["Instance", "Audit log"]}
      eyebrow="Instance"
      title="Audit log"
      subtitle="Activity across every tenant"
    >
      <AdminAudit />
    </AdminPage>
  );
}
