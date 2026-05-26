"use client";
import { Layers, Users, Shield, Server, Bot, Plug, Activity } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ADMIN, AdminMetricTile, AdminPanel, AdminLoading } from "./admin-ui";

/**
 * System / build-info surface for `/admin/system`. Reads
 * `instanceAdmin.system` — version/buildSha/buildTime plus instance-wide
 * counts. Part of the multi-workspace restructure.
 */
export function AdminSystem() {
  const system = trpc.instanceAdmin.system.useQuery();
  const c = system.data?.counts;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      {/* Build identity */}
      <AdminPanel title="Build" hint="what's running" className="mb-5">
        {system.isLoading ? (
          <AdminLoading />
        ) : (
          <div className="grid grid-cols-3 gap-x-4 gap-y-4 p-4 text-meta">
            {(
              [
                ["Edition", "Self-hosted"],
                ["Version", system.data?.version ?? "dev"],
                ["Build SHA", system.data?.buildSha ?? "—"],
                ["Built at", system.data?.buildTime ?? "—"],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k}>
                <div style={{ color: ADMIN.textDim }}>{k}</div>
                <div className="mt-0.5 truncate font-mono text-[12px]" style={{ color: ADMIN.text }}>
                  {v}
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminPanel>

      {/* Instance-wide counts */}
      <div className="grid grid-cols-4 gap-3">
        <AdminMetricTile icon={Layers} label="Tenants" value={String(c?.tenants ?? "—")} />
        <AdminMetricTile icon={Users} label="Users" value={String(c?.users ?? "—")} />
        <AdminMetricTile icon={Shield} label="Instance admins" value={String(c?.admins ?? "—")} tone="warning" />
        <AdminMetricTile icon={Server} label="Runtimes" value={String(c?.runtimes ?? "—")} />
        <AdminMetricTile icon={Bot} label="Agent profiles" value={String(c?.profiles ?? "—")} />
        <AdminMetricTile icon={Plug} label="Connections" value={String(c?.connections ?? "—")} />
        <AdminMetricTile icon={Activity} label="Runs · 24h" value={String(c?.runs24 ?? "—")} tone="success" />
      </div>
    </div>
  );
}
