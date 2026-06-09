"use client";
import { trpc } from "@/lib/trpc";
import { RuntimeToolSurfaceBadges } from "@/components/runtime-tool-surface";
import { ADMIN, AdminPanel, AdminLoading, AdminEmpty } from "./admin-ui";

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
          className="grid grid-cols-[1.5fr_0.65fr_1.2fr_0.75fr_0.5fr_0.7fr_0.6fr] items-center gap-2 px-4 py-2 text-meta"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Runtime</span>
          <span>Kind</span>
          <span>Tool surface</span>
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
            const status = r.health.label;
            const statusColor =
              r.health.tone === "success"
                ? "hsl(var(--success))"
                : r.health.tone === "danger"
                  ? "hsl(var(--danger))"
                  : r.health.tone === "warning"
                    ? "hsl(var(--warning))"
                    : ADMIN.textMuted;
            return (
              <div
                key={r.id}
                className="grid grid-cols-[1.5fr_0.65fr_1.2fr_0.75fr_0.5fr_0.7fr_0.6fr] items-center gap-2 px-4 py-2.5"
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
                  <span className="block truncate text-[10px]" style={{ color: ADMIN.textDim }} title={r.health.reason}>
                    {r.health.reason}
                  </span>
                </span>
                <span className="truncate text-meta font-mono" style={{ color: ADMIN.textSoft }}>
                  {r.kind.toLowerCase()}
                </span>
                <RuntimeToolSurfaceBadges
                  adapterKey={r.adapterKey}
                  config={r.config}
                  configStatus={r.configStatus}
                  className="min-w-0"
                />
                <span className="truncate text-meta" style={{ color: ADMIN.textSoft }}>
                  {r.owner?.name ?? r.owner?.email ?? "—"}
                </span>
                <span className="text-right font-mono text-[0.8125rem] tabular-nums" style={{ color: ADMIN.text }}>
                  {r.boundAgents}
                </span>
                <span className="text-right text-meta tabular-nums" style={{ color: ADMIN.textMuted }} title={r.health.reason}>
                  {r.health.lastSignal}
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
