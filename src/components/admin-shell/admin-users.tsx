"use client";
import { useState } from "react";
import { ShieldPlus, ShieldMinus, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ADMIN, AdminPanel, AdminLoading, AdminEmpty, AdminButton, relTime } from "./admin-ui";
import { InviteUserDialog } from "./admin-overview";

/**
 * Users table for `/admin/users` with an inline instance-role control
 * wired to `instanceAdmin.setInstanceRole`. Promote is one click; demote
 * confirms first (and the server refuses the last admin). Part of the
 * multi-workspace restructure.
 */
export function AdminUsers() {
  const utils = trpc.useUtils();
  const users = trpc.instanceAdmin.users.useQuery();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const setRole = trpc.instanceAdmin.setInstanceRole.useMutation({
    onMutate: (vars) => setPendingId(vars.userId),
    onSuccess: async () => {
      await utils.instanceAdmin.users.invalidate();
      await utils.instanceAdmin.system.invalidate();
      toast.success("Instance role updated.");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setPendingId(null),
  });

  const adminCount = users.data?.filter((u) => u.instanceRole === "INSTANCE_ADMIN").length ?? 0;

  function promote(userId: string) {
    setRole.mutate({ userId, role: "INSTANCE_ADMIN" });
  }
  function demote(userId: string, name: string | null) {
    if (!window.confirm(`Remove instance-admin from ${name ?? "this user"}? They lose access to /admin.`)) return;
    setRole.mutate({ userId, role: "MEMBER" });
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      <AdminPanel
        title="Users"
        hint={
          users.data
            ? `${users.data.length} total · ${adminCount} ${adminCount === 1 ? "admin" : "admins"}`
            : undefined
        }
        actions={
          <AdminButton icon={Plus} tone="ember" onClick={() => setInviteOpen(true)}>
            Invite
          </AdminButton>
        }
      >
        <div
          className="grid grid-cols-[1.4fr_1.2fr_0.7fr_0.5fr_0.5fr_0.9fr] items-center gap-2 px-4 py-2 text-meta"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Name</span>
          <span>Email</span>
          <span>Role</span>
          <span className="text-right">Workspaces</span>
          <span className="text-right">Joined</span>
          <span className="text-right">Instance role</span>
        </div>
        {users.isLoading ? (
          <AdminLoading />
        ) : !users.data?.length ? (
          <AdminEmpty>No users.</AdminEmpty>
        ) : (
          users.data.map((u, i, arr) => {
            const isAdmin = u.instanceRole === "INSTANCE_ADMIN";
            const initials = (u.name ?? u.email ?? "?")
              .split(" ")
              .map((p) => p[0])
              .slice(0, 2)
              .join("");
            const busy = pendingId === u.id;
            const lastAdmin = isAdmin && adminCount <= 1;
            return (
              <div
                key={u.id}
                className="grid grid-cols-[1.4fr_1.2fr_0.7fr_0.5fr_0.5fr_0.9fr] items-center gap-2 px-4 py-2"
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
                <span className="flex justify-end">
                  {isAdmin ? (
                    <AdminButton
                      icon={ShieldMinus}
                      tone="danger"
                      disabled={busy || lastAdmin}
                      onClick={() => demote(u.id, u.name)}
                    >
                      {lastAdmin ? "Last admin" : "Demote"}
                    </AdminButton>
                  ) : (
                    <AdminButton icon={ShieldPlus} tone="ember" disabled={busy} onClick={() => promote(u.id)}>
                      Make admin
                    </AdminButton>
                  )}
                </span>
              </div>
            );
          })
        )}
      </AdminPanel>
      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}
