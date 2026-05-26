"use client";
import { MoreHorizontal } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ADMIN, AdminPanel, AdminLoading, AdminEmpty, relTime } from "./admin-ui";

/**
 * Full tenants (workspaces) table for `/admin/tenants`. Reads
 * `instanceAdmin.tenants`. Part of the multi-workspace restructure.
 */
export function AdminTenants() {
  const tenants = trpc.instanceAdmin.tenants.useQuery();

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      <AdminPanel title="Workspaces" hint={tenants.data ? `${tenants.data.length} tenants` : undefined}>
        <div
          className="grid grid-cols-[1.6fr_0.8fr_0.5fr_0.5fr_0.5fr_0.6fr_24px] items-center gap-2 px-4 py-2 text-meta"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Workspace</span>
          <span>Owner</span>
          <span className="text-right">Members</span>
          <span className="text-right">Runs 24h</span>
          <span className="text-right">Issues</span>
          <span className="text-right">Created</span>
          <span />
        </div>
        {tenants.isLoading ? (
          <AdminLoading />
        ) : !tenants.data?.length ? (
          <AdminEmpty>No workspaces yet.</AdminEmpty>
        ) : (
          tenants.data.map((t, i, arr) => (
            <div
              key={t.id}
              className="grid grid-cols-[1.6fr_0.8fr_0.5fr_0.5fr_0.5fr_0.6fr_24px] items-center gap-2 px-4 py-2.5"
              style={{ borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white"
                  style={{ background: "hsl(var(--ember))" }}
                >
                  {t.key[0]}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[0.8125rem] font-medium" style={{ color: ADMIN.text }}>
                    {t.name}
                  </span>
                  <span className="block text-[10px] font-mono" style={{ color: ADMIN.textDim }}>
                    {t.slug} · {t.key}
                  </span>
                </span>
              </span>
              <span className="min-w-0 truncate text-[0.8125rem]" style={{ color: "hsl(40 8% 80%)" }}>
                {t.owner?.name ?? t.owner?.email ?? "—"}
              </span>
              <span className="text-right font-mono text-[0.8125rem] tabular-nums" style={{ color: ADMIN.text }}>
                {t.members}
              </span>
              <span className="text-right font-mono text-[0.8125rem] tabular-nums" style={{ color: ADMIN.text }}>
                {t.runsLast24}
              </span>
              <span className="text-right font-mono text-[0.8125rem] tabular-nums" style={{ color: ADMIN.text }}>
                {t.issues}
              </span>
              <span className="text-right text-meta" style={{ color: ADMIN.textMuted }}>
                {relTime(t.createdAt)}
              </span>
              <button style={{ color: ADMIN.textMuted }}>
                <MoreHorizontal size={13} />
              </button>
            </div>
          ))
        )}
      </AdminPanel>
    </div>
  );
}
