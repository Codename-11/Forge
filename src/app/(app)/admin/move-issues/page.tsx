"use client";
import { AdminPage } from "@/components/admin-shell/admin-shell";
import { AdminMoveIssues } from "@/components/admin-shell/admin-move-issues";

/**
 * `/admin/move-issues` — instance-admin surface to move issues between
 * workspaces (audit ask #2). Preview the full remap before executing.
 */
export default function AdminMoveIssuesPage() {
  return (
    <AdminPage
      activePath="/admin/move-issues"
      crumbs={["Instance", "Move issues"]}
      eyebrow="Instance"
      title="Move issues between workspaces"
      subtitle="Re-tenant issues into another workspace — preview the remap first"
    >
      <AdminMoveIssues />
    </AdminPage>
  );
}
