import { AdminPage } from "@/components/admin-shell/admin-shell";
import IdentitySettings from "@/components/admin-shell/identity-settings";

export default function AdminIdentityPage() {
  return (
    <AdminPage
      activePath="/admin/auth"
      crumbs={["Instance", "Identity & sign-in"]}
      contentClass="overflow-hidden bg-background text-foreground"
    >
      <IdentitySettings />
    </AdminPage>
  );
}
