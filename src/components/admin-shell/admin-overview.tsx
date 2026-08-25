"use client";
import { useState } from "react";
import {
  Layers,
  Users,
  Activity,
  Server,
  Search,
  Plus,
  FileText,
  Shield,
  MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  ADMIN,
  AdminMetricTile,
  AdminPanel,
  AdminLoading,
  AdminEmpty,
  AdminButton,
  relTime,
} from "./admin-ui";
import { QuickForm } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";

/**
 * Instance-admin overview content. Aggregates `instanceAdmin.system`,
 * `.tenants`, `.users`, `.runtimes`, and `.audit` into the metric tiles,
 * tenants table, system card, users table, instance-events feed, and
 * license footer from the design handoff's `InstanceAdminScreen`.
 * Part of the multi-workspace restructure.
 */
export function AdminOverview() {
  const system = trpc.instanceAdmin.system.useQuery();
  const tenants = trpc.instanceAdmin.tenants.useQuery();
  const users = trpc.instanceAdmin.users.useQuery();
  const runtimes = trpc.instanceAdmin.runtimes.useQuery();
  const audit = trpc.instanceAdmin.audit.useQuery({ limit: 12 });

  const [inviteOpen, setInviteOpen] = useState(false);

  const counts = system.data?.counts;
  const activeTenants = tenants.data?.filter((t) => t.runsLast24 > 0).length ?? 0;
  const onlineRuntimes = runtimes.data?.filter((r) => r.online).length ?? 0;
  const totalRuntimes = runtimes.data?.length ?? 0;
  const admins = counts?.admins ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      {/* Top metrics */}
      <div className="grid grid-cols-4 gap-3">
        <AdminMetricTile
          icon={Layers}
          label="Tenants"
          value={String(counts?.tenants ?? tenants.data?.length ?? "—")}
          sub={`${activeTenants} active in last 24h`}
        />
        <AdminMetricTile
          icon={Users}
          label="Users"
          value={String(counts?.users ?? users.data?.length ?? "—")}
          sub={`${admins} ${admins === 1 ? "admin" : "admins"}`}
        />
        <AdminMetricTile
          icon={Activity}
          label="Runs · 24h"
          value={String(counts?.runs24 ?? "—")}
          sub="across all tenants"
          tone="success"
        />
        <AdminMetricTile
          icon={Server}
          label="Runtimes"
          value={totalRuntimes ? `${onlineRuntimes}/${totalRuntimes}` : "—"}
          sub={totalRuntimes - onlineRuntimes > 0 ? `${totalRuntimes - onlineRuntimes} unreachable` : "all online"}
          tone={totalRuntimes - onlineRuntimes > 0 ? "warning" : "default"}
        />
      </div>

      <div className="mt-5 grid grid-cols-12 gap-3">
        {/* Tenants table */}
        <AdminPanel
          className="col-span-8"
          title="Workspaces"
          hint="all tenants"
          actions={<AdminButton icon={Search}>Filter</AdminButton>}
        >
          <div
            className="grid grid-cols-[1.4fr_0.6fr_0.5fr_0.5fr_0.5fr_24px] items-center gap-2 px-4 py-2 text-meta"
            style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
          >
            <span>Workspace</span>
            <span>Owner</span>
            <span className="text-right">Members</span>
            <span className="text-right">Runs 24h</span>
            <span className="text-right">Issues</span>
            <span />
          </div>
          {tenants.isLoading ? (
            <AdminLoading />
          ) : !tenants.data?.length ? (
            <AdminEmpty>No workspaces yet.</AdminEmpty>
          ) : (
            tenants.data.map((t, i) => (
              <div
                key={t.id}
                className="grid grid-cols-[1.4fr_0.6fr_0.5fr_0.5fr_0.5fr_24px] items-center gap-2 px-4 py-2.5"
                style={{ borderBottom: i === tenants.data!.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
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
                <span className="truncate text-[0.8125rem]" style={{ color: "hsl(var(--admin-text-hi))" }}>
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
                <button style={{ color: ADMIN.textMuted }}>
                  <MoreHorizontal size={13} />
                </button>
              </div>
            ))
          )}
        </AdminPanel>

        {/* System info card */}
        <section
          className="col-span-4 flex flex-col gap-3 rounded-lg p-4"
          style={{ background: ADMIN.panel, border: `1px solid ${ADMIN.border}` }}
        >
          <header>
            <h2 className="text-sm font-semibold" style={{ color: ADMIN.text }}>
              System
            </h2>
          </header>
          {system.isLoading ? (
            <AdminLoading />
          ) : (
            <div className="grid grid-cols-2 gap-x-2 gap-y-3 text-meta">
              {(
                [
                  ["Version", system.data?.version ?? "dev"],
                  ["Build", system.data?.buildSha ?? "—"],
                  ["Built at", system.data?.buildTime ?? "—"],
                  ["Tenants", String(counts?.tenants ?? "—")],
                  ["Users", String(counts?.users ?? "—")],
                  ["Profiles", String(counts?.profiles ?? "—")],
                  ["Connections", String(counts?.connections ?? "—")],
                  ["Runtimes", String(counts?.runtimes ?? "—")],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k}>
                  <div style={{ color: ADMIN.textDim }}>{k}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px]" style={{ color: ADMIN.text }}>
                    {v}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="border-t pt-3" style={{ borderColor: ADMIN.border }}>
            <AdminButton icon={FileText} className="w-full justify-center">
              View build info
            </AdminButton>
          </div>
        </section>

        {/* Users */}
        <AdminPanel
          className="col-span-7"
          title="Users"
          hint={
            counts
              ? `${counts.users} total · ${counts.admins} ${counts.admins === 1 ? "admin" : "admins"}`
              : undefined
          }
          actions={
            <AdminButton icon={Plus} onClick={() => setInviteOpen(true)}>
              Invite
            </AdminButton>
          }
        >
          <div
            className="grid grid-cols-[1.4fr_1fr_0.8fr_0.6fr_0.4fr] items-center gap-2 px-4 py-2 text-meta"
            style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
          >
            <span>Name</span>
            <span>Email</span>
            <span>Role</span>
            <span className="text-right">Workspaces</span>
            <span className="text-right">Joined</span>
          </div>
          {users.isLoading ? (
            <AdminLoading />
          ) : !users.data?.length ? (
            <AdminEmpty>No users.</AdminEmpty>
          ) : (
            users.data.slice(0, 8).map((u, i, arr) => {
              const isAdmin = u.instanceRole === "INSTANCE_ADMIN";
              const initials = (u.name ?? u.email ?? "?")
                .split(" ")
                .map((p) => p[0])
                .slice(0, 2)
                .join("");
              return (
                <div
                  key={u.id}
                  className="grid grid-cols-[1.4fr_1fr_0.8fr_0.6fr_0.4fr] items-center gap-2 px-4 py-2"
                  style={{ borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                      style={{ background: "hsl(var(--ember))" }}
                    >
                      {initials}
                    </span>
                    <span className="truncate text-[0.8125rem]" style={{ color: ADMIN.text }}>
                      {u.name ?? "—"}
                    </span>
                  </span>
                  <span className="truncate text-meta font-mono" style={{ color: ADMIN.textSoft }}>
                    {u.email}
                  </span>
                  <span className="text-meta">
                    {isAdmin ? (
                      <span style={{ color: ADMIN.ember }}>instance admin</span>
                    ) : (
                      <span style={{ color: ADMIN.textSoft }}>member</span>
                    )}
                  </span>
                  <span className="text-right font-mono text-[0.8125rem] tabular-nums" style={{ color: ADMIN.text }}>
                    {u.workspaces}
                  </span>
                  <span className="text-right text-meta" style={{ color: ADMIN.textMuted }}>
                    {relTime(u.createdAt)}
                  </span>
                </div>
              );
            })
          )}
        </AdminPanel>

        {/* Recent events */}
        <section
          className="col-span-5 flex flex-col gap-2 rounded-lg p-4"
          style={{ background: ADMIN.panel, border: `1px solid ${ADMIN.border}` }}
        >
          <header className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: ADMIN.text }}>
              Instance events
            </h2>
            <span className="text-meta" style={{ color: ADMIN.textMuted }}>
              cross-tenant
            </span>
            <a href="/admin/audit" className="ml-auto text-meta hover:underline" style={{ color: ADMIN.textSoft }}>
              Open audit →
            </a>
          </header>
          {audit.isLoading ? (
            <AdminLoading />
          ) : !audit.data?.items.length ? (
            <AdminEmpty>No recent activity.</AdminEmpty>
          ) : (
            <div className="flex flex-col">
              {audit.data.items.map((e, i, arr) => (
                <div
                  key={e.id}
                  className="flex items-start gap-2 py-1.5 text-meta"
                  style={{ borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
                >
                  <span
                    className="inline-flex shrink-0 items-center rounded px-1 text-[9px] font-bold uppercase tracking-wider"
                    style={{ background: "var(--admin-border)", color: ADMIN.textSoft }}
                  >
                    {e.workspace?.key ?? "—"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]" style={{ color: "hsl(var(--admin-text-hi))" }}>
                    {e.kind.toLowerCase()} · {e.subjectType}
                  </span>
                  <span className="tabular-nums" style={{ color: ADMIN.textDim }}>
                    {relTime(e.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* License footer */}
      <div
        className="mt-5 flex items-center gap-3 rounded-lg px-4 py-3"
        style={{ background: ADMIN.panel, border: `1px solid ${ADMIN.border}` }}
      >
        <span
          aria-hidden
          className="inline-flex h-8 w-8 items-center justify-center rounded-md"
          style={{ background: "rgba(217,119,87,0.18)", color: ADMIN.ember }}
        >
          <Shield size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[0.8125rem] font-semibold" style={{ color: ADMIN.text }}>
            License · Self-hosted
          </div>
          <div className="text-meta" style={{ color: ADMIN.textMuted }}>
            Unlimited tenants · {counts?.users ?? "—"} seats in use · version {system.data?.version ?? "dev"}
          </div>
        </div>
        <AdminButton icon={FileText}>License details</AdminButton>
      </div>

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}

/* ── Invite-user dialog (shared shape with /admin/users) ────────────── */
export function InviteUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);

  const invite = trpc.instanceAdmin.createUser.useMutation({
    onSuccess: async (result) => {
      await utils.instanceAdmin.users.invalidate();
      await utils.instanceAdmin.system.invalidate();
      toast.success(`Setup email sent to ${result.user.email}.`);
    },
    onError: (e) => toast.error(e.message),
  });

  // Reset the form whenever the dialog opens.
  function reset() {
    setEmail("");
    setName("");
    setMakeAdmin(false);
  }

  return (
    <QuickForm
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="Invite user"
      description="Creates one canonical Forge user and emails a single-use local account setup link. External login methods can be linked to the same user when instance policy allows. No workspace membership is added."
      primaryLabel="Invite"
      loading={invite.isPending}
      onSubmit={async () => {
        const trimmed = email.trim();
        if (!trimmed) return { error: "Email required." };
        try {
          await invite.mutateAsync({
            email: trimmed,
            name: name.trim() || undefined,
            instanceRole: makeAdmin ? "INSTANCE_ADMIN" : "MEMBER",
          });
          reset();
          return undefined;
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Failed to invite." };
        }
      }}
    >
      <QuickForm.Field label="Email" required>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@example.com"
          autoFocus
        />
      </QuickForm.Field>
      <QuickForm.Field label="Name" hint="Optional — shown until they set their own.">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
      </QuickForm.Field>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={makeAdmin}
          onChange={(e) => setMakeAdmin(e.target.checked)}
          className="h-3.5 w-3.5 accent-[hsl(var(--ember))]"
        />
        Grant instance-admin access
      </label>
    </QuickForm>
  );
}
