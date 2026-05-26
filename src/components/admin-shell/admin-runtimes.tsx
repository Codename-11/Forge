"use client";
import { trpc } from "@/lib/trpc";
import { ADMIN, AdminPanel, AdminLoading, AdminEmpty, relTime } from "./admin-ui";

/**
 * Instance-wide runtimes table for `/admin/runtimes`. Reads
 * `instanceAdmin.runtimes` (every runtime, not just the caller's). Online
 * is derived server-side from heartbeat recency. Part of the
 * multi-workspace restructure.
 */
export function AdminRuntimes() {
  const runtimes = trpc.instanceAdmin.runtimes.useQuery();
  const online = runtimes.data?.filter((r) => r.online).length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      <AdminPanel
        title="Runtimes"
        hint={runtimes.data ? `${online}/${runtimes.data.length} online` : undefined}
      >
        <div
          className="grid grid-cols-[1.6fr_0.7fr_0.8fr_0.5fr_0.7fr_0.6fr] items-center gap-2 px-4 py-2 text-meta"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Runtime</span>
          <span>Kind</span>
          <span>Owner</span>
          <span className="text-right">Agents</span>
          <span className="text-right">Heartbeat</span>
          <span className="text-right">Status</span>
        </div>
        {runtimes.isLoading ? (
          <AdminLoading />
        ) : !runtimes.data?.length ? (
          <AdminEmpty>No runtimes registered.</AdminEmpty>
        ) : (
          runtimes.data.map((r, i, arr) => {
            const status = r.disabledAt ? "disabled" : r.online ? "online" : "offline";
            const statusColor =
              status === "online"
                ? "hsl(var(--success))"
                : status === "disabled"
                  ? "hsl(var(--danger))"
                  : ADMIN.textMuted;
            return (
              <div
                key={r.id}
                className="grid grid-cols-[1.6fr_0.7fr_0.8fr_0.5fr_0.7fr_0.6fr] items-center gap-2 px-4 py-2.5"
                style={{ borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[0.8125rem] font-medium" style={{ color: ADMIN.text }}>
                    {r.name}
                    {r.instanceShared && (
                      <span
                        className="ml-1.5 rounded px-1 text-[9px] font-bold uppercase tracking-wider"
                        style={{ background: "rgba(217,119,87,0.18)", color: ADMIN.ember }}
                      >
                        shared
                      </span>
                    )}
                  </span>
                  {r.adapterKey && (
                    <span className="block text-[10px] font-mono" style={{ color: ADMIN.textDim }}>
                      {r.adapterKey}
                    </span>
                  )}
                </span>
                <span className="truncate text-meta font-mono" style={{ color: ADMIN.textSoft }}>
                  {r.kind.toLowerCase()}
                </span>
                <span className="truncate text-meta" style={{ color: ADMIN.textSoft }}>
                  {r.owner?.name ?? r.owner?.email ?? "—"}
                </span>
                <span className="text-right font-mono text-[0.8125rem] tabular-nums" style={{ color: ADMIN.text }}>
                  {r.boundAgents}
                </span>
                <span className="text-right text-meta tabular-nums" style={{ color: ADMIN.textMuted }}>
                  {relTime(r.heartbeatAt)}
                </span>
                <span className="text-right">
                  <span className="inline-flex items-center gap-1 text-meta" style={{ color: statusColor }}>
                    <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
                    {status}
                  </span>
                </span>
              </div>
            );
          })
        )}
      </AdminPanel>
    </div>
  );
}
