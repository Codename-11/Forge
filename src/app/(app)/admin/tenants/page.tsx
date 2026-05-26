"use client";
import { Plus } from "lucide-react";
import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminTenants } from "@/components/admin-shell/admin-tenants";
import { AdminButton } from "@/components/admin-shell/admin-ui";

/**
 * `/admin/tenants` — full workspaces (tenants) table. Part of the
 * multi-workspace restructure.
 */
export default function AdminTenantsPage() {
  return (
    <AdminPage
      activePath="/admin/tenants"
      crumbs={["Instance", "Workspaces"]}
      eyebrow="Instance"
      title="Workspaces"
      subtitle="Every tenant on this instance"
      actions={
        <AdminButton icon={Plus} tone="ember">
          New tenant
        </AdminButton>
      }
    >
      <AdminTenants />
    </AdminPage>
  );
}