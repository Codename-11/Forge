"use client";
import { DatabaseBackup, Plus } from "lucide-react";
import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminOverview } from "@/components/admin-shell/admin-overview";
import { AdminButton } from "@/components/admin-shell/admin-ui";

/**
 * `/admin` — instance Overview. Server shell around the `AdminOverview`
 * client component (metric tiles, tenants/users tables, system card,
 * instance-events feed, license footer). Part of the multi-workspace
 * restructure.
 */
export default function AdminOverviewPage() {
  return (
    <AdminPage
      activePath="/admin"
      crumbs={["Instance", "Overview"]}
      eyebrow="Instance"
      title="Forge · self-hosted"
      subtitle="Health, tenants, and license across the whole instance"
      actions={
        <>
          <AdminButton icon={DatabaseBackup}>Backup now</AdminButton>
          <AdminButton icon={Plus} tone="ember">
            New tenant
          </AdminButton>
        </>
      }
    >
      <AdminOverview />
    </AdminPage>
  );
}