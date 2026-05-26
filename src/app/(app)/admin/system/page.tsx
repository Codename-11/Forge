import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminSystem } from "@/components/admin-shell/admin-system";

/**
 * `/admin/system` — build identity + instance-wide counts. Part of the
 * multi-workspace restructure.
 */
export default function AdminSystemPage() {
  return (
    <AdminPage
      activePath="/admin/system"
      crumbs={["Instance", "System"]}
      eyebrow="Instance"
      title="System"
      subtitle="Build identity and instance-wide totals"
    >
      <AdminSystem />
    </AdminPage>
  );
}
