"use client";
import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { runtimeOwnershipLabel } from "@/lib/runtime-ownership";
import { runtimeDisplayIdentity } from "@/lib/transport-display";
import { RuntimeLifecycleActions } from "@/components/settings/runtime-lifecycle";
import { RuntimeToolSurfaceBadges } from "@/components/runtime-tool-surface";
import { RuntimeSelfTestLine } from "@/components/settings/runtime-self-test";
import { ADMIN, AdminPanel, AdminLoading, AdminEmpty } from "./admin-ui";

/**
 * Instance-wide runtimes table for `/admin/runtimes`. Reads
 * `instanceAdmin.runtimes` (every runtime, not just the caller's). Online
 * is derived server-side from heartbeat recency. Part of the
 * multi-workspace restructure.
 */
export function AdminRuntimes() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const runtimes = trpc.instanceAdmin.runtimes.useQuery();
  const accessibleWorkspaces = trpc.workspace.list.useQuery();
  const visibleRuntimes = runtimes.data?.filter(
    (runtime) => includeArchived || !runtime.archivedAt,
  );
  const online = visibleRuntimes?.filter((runtime) => runtime.online).length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-3 px-4 py-6 sm:px-8">
      <div className="text-meta flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">
          Review ownership separately from registration home and workspace access.
        </p>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived
        </label>
      </div>
      <AdminPanel
        title="Runtimes"
        hint={visibleRuntimes ? `${online}/${visibleRuntimes.length} online` : undefined}
      >
        <div
          className="text-meta hidden grid-cols-[1.5fr_0.65fr_1.2fr_0.75fr_0.5fr_0.7fr_0.6fr] items-center gap-2 px-4 py-2 lg:grid"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Runtime</span>
          <span>Connection</span>
          <span>Tool surface</span>
          <span>Owner</span>
          <span className="text-right">Agents</span>
          <span className="text-right">Heartbeat</span>
          <span className="text-right">Status</span>
        </div>
        {runtimes.isLoading ? (
          <AdminLoading />
        ) : runtimes.isError ? (
          <AdminEmpty>
            Runtime registrations could not be loaded.{" "}
            <button
              className="focus-ring rounded underline"
              onClick={() => void runtimes.refetch()}
            >
              Try again
            </button>
          </AdminEmpty>
        ) : !visibleRuntimes?.length ? (
          <AdminEmpty>No runtimes registered.</AdminEmpty>
        ) : (
          visibleRuntimes.map((r, i, arr) => {
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
                className="space-y-3 px-4 py-3"
                style={{
                  borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}`,
                }}
              >
                <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_0.65fr_1.2fr_0.75fr_0.5fr_0.7fr_0.6fr] lg:items-center lg:gap-2">
                  <span className="min-w-0">
                    <span
                      className="block truncate text-[0.8125rem] font-medium"
                      style={{ color: ADMIN.text }}
                    >
                      {r.name}
                      {r.archivedAt && (
                        <span className="text-meta ml-2 text-warning">Archived</span>
                      )}
                      {r.instanceShared && (
                        <span
                          className="ml-1.5 rounded px-1 text-[9px] font-bold uppercase tracking-wider"
                          style={{ background: "rgba(217,119,87,0.18)", color: ADMIN.ember }}
                        >
                          instance-available
                        </span>
                      )}
                    </span>
                    {r.adapterKey && (
                      <span
                        className="block font-mono text-[10px]"
                        style={{ color: ADMIN.textDim }}
                      >
                        {r.adapterKey}
                      </span>
                    )}
                    <span
                      className="block truncate text-[10px]"
                      style={{ color: ADMIN.textDim }}
                      title={r.health.reason}
                    >
                      {r.health.reason}
                    </span>
                    <RuntimeSelfTestLine selfTest={r.selfTest} className="block text-[10px]" />
                  </span>
                  <span className="text-meta" style={{ color: ADMIN.textSoft }}>
                    {runtimeDisplayIdentity(r).runtimeLabel}
                  </span>
                  <RuntimeToolSurfaceBadges
                    adapterKey={r.adapterKey}
                    config={r.config}
                    configStatus={r.configStatus}
                    className="min-w-0"
                  />
                  <span className="text-meta" style={{ color: ADMIN.textSoft }}>
                    {runtimeOwnershipLabel(r)}
                  </span>
                  <span
                    className="text-right font-mono text-[0.8125rem] tabular-nums"
                    style={{ color: ADMIN.text }}
                  >
                    <span className="mr-2 font-sans lg:hidden">Agents</span>
                    {r.boundAgents}
                  </span>
                  <span
                    className="text-meta text-right tabular-nums"
                    style={{ color: ADMIN.textMuted }}
                    title={r.health.reason}
                  >
                    {r.health.lastSignal}
                  </span>
                  <span className="text-right">
                    <span
                      className="text-meta inline-flex items-center gap-1"
                      style={{ color: statusColor }}
                    >
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: statusColor }}
                      />
                      {status}
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-3">
                  {accessibleWorkspaces.data?.some(
                    (workspace) => workspace.id === r.workspace.id,
                  ) ? (
                    <Link
                      href={`/w/${r.workspace.slug}/settings/runtimes/${r.id}`}
                      className="focus-ring text-meta rounded text-muted-foreground underline hover:text-foreground"
                    >
                      Registration home: {r.workspace.name} · settings
                    </Link>
                  ) : (
                    <span className="text-meta text-muted-foreground">
                      Registration home: {r.workspace.name} · host settings require workspace access
                    </span>
                  )}
                  <RuntimeLifecycleActions
                    id={r.id}
                    canManage
                    onChanged={(mode) => {
                      if (mode === "prepare") setIncludeArchived(true);
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </AdminPanel>
    </div>
  );
}
