import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminUsers } from "@/components/admin-shell/admin-users";

/**
 * `/admin/users` — instance-wide users with inline instance-role control.
 * Part of the multi-workspace restructure.
 */
export default function AdminUsersPage() {
  return (
    <AdminPage
      activePath="/admin/users"
      crumbs={["Administration", "People"]}
      eyebrow="Instance"
      title="People"
      subtitle="Everyone with access · manage instance-admin role"
    >
      <AdminUsers />
    </AdminPage>
  );
}
