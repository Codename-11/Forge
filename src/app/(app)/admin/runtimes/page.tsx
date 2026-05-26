import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminRuntimes } from "@/components/admin-shell/admin-runtimes";

/**
 * `/admin/runtimes` — instance-wide runtimes (every runtime, all owners).
 * Part of the multi-workspace restructure.
 */
export default function AdminRuntimesPage() {
  return (
    <AdminPage
      activePath="/admin/runtimes"
      crumbs={["Instance", "Runtimes"]}
      eyebrow="Instance"
      title="Runtimes"
      subtitle="Compute environments hosting agents across the instance"
    >
      <AdminRuntimes />
    </AdminPage>
  );
}
