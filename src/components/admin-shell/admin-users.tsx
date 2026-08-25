"use client";
import { useState } from "react";
import {
  KeyRound,
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  ShieldMinus,
  ShieldPlus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useConfirm } from "@/components/ui/modal";
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
  const { confirm, confirmElement } = useConfirm();
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

  const refresh = async () => {
    await utils.instanceAdmin.users.invalidate();
    await utils.instanceAdmin.system.invalidate();
  };
  const suspend = trpc.instanceAdmin.suspendUser.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("User suspended and active access revoked.");
    },
    onError: (e) => toast.error(e.message),
  });
  const reactivate = trpc.instanceAdmin.reactivateUser.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("User reactivated.");
    },
    onError: (e) => toast.error(e.message),
  });
  const resetPassword = trpc.instanceAdmin.issuePasswordResetToken.useMutation({
    onSuccess: () => toast.success("Password reset email sent."),
    onError: (e) => toast.error(e.message),
  });
  const revokeSessions = trpc.instanceAdmin.revokeUserSessions.useMutation({
    onSuccess: () => toast.success("All user sessions revoked."),
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.instanceAdmin.deleteUser.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("User disabled and anonymized; historical attribution was preserved.");
    },
    onError: (e) => toast.error(e.message),
  });

  const adminCount = users.data?.filter((u) => u.instanceRole === "INSTANCE_ADMIN").length ?? 0;

  function promote(userId: string) {
    setRole.mutate({ userId, role: "INSTANCE_ADMIN" });
  }
  async function demote(userId: string, name: string | null) {
    if (
      !(await confirm({
        title: `Remove instance-admin from ${name ?? "this user"}?`,
        description: "They lose access to /admin.",
        primaryLabel: "Remove",
        variant: "destructive",
      }))
    )
      return;
    setRole.mutate({ userId, role: "MEMBER" });
  }

  async function suspendUser(userId: string, name: string | null) {
    if (
      await confirm({
        title: `Suspend ${name ?? "this user"}?`,
        description:
          "Their browser sessions and API keys will be revoked, and user-owned integration mappings will be paused.",
        primaryLabel: "Suspend",
        variant: "destructive",
      })
    ) {
      suspend.mutate({ userId });
    }
  }

  async function deleteUser(userId: string, name: string | null) {
    if (
      await confirm({
        title: `Delete ${name ?? "this user"}?`,
        description:
          "This soft-deletes and anonymizes the account while preserving authored work and audit history. Ownership guards may block the action.",
        primaryLabel: "Delete account",
        variant: "destructive",
      })
    ) {
      remove.mutate({ userId });
    }
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
          className="text-meta grid grid-cols-[1.2fr_1.15fr_0.9fr_0.5fr_0.5fr_1.8fr] items-center gap-2 px-4 py-2"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Name</span>
          <span>Email</span>
          <span>Status · methods</span>
          <span className="text-right">Workspaces</span>
          <span className="text-right">Joined</span>
          <span className="text-right">Access actions</span>
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
            const isSuspended = u.status === "SUSPENDED";
            const isDeleted = u.status === "DELETED";
            const methods = [
              ...(u.loginMethods.password ? ["password"] : []),
              ...u.loginMethods.providers,
            ];
            return (
              <div
                key={u.id}
                className="grid grid-cols-[1.2fr_1.15fr_0.9fr_0.5fr_0.5fr_1.8fr] items-center gap-2 px-4 py-2"
                style={{
                  borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}`,
                }}
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
                <span className="text-meta truncate font-mono" style={{ color: ADMIN.textSoft }}>
                  {u.email}
                </span>
                <span className="text-meta min-w-0">
                  <span
                    style={{
                      color: isSuspended || isDeleted ? "hsl(var(--danger))" : ADMIN.textSoft,
                    }}
                  >
                    {u.status.toLowerCase()}
                  </span>
                  <span
                    className="mt-0.5 block truncate font-mono text-[0.625rem]"
                    style={{ color: ADMIN.textMuted }}
                  >
                    {methods.length ? methods.join(" · ") : "no login method"}
                  </span>
                </span>
                <span
                  className="text-right font-mono text-[0.8125rem] tabular-nums"
                  style={{ color: ADMIN.text }}
                >
                  {u.workspaces}
                </span>
                <span className="text-meta text-right" style={{ color: ADMIN.textMuted }}>
                  {relTime(u.createdAt)}
                </span>
                <span className="flex flex-wrap justify-end gap-1">
                  {!isDeleted &&
                    (isAdmin ? (
                      <AdminButton
                        icon={ShieldMinus}
                        tone="danger"
                        disabled={busy || lastAdmin}
                        onClick={() => demote(u.id, u.name)}
                      >
                        {lastAdmin ? "Last admin" : "Demote"}
                      </AdminButton>
                    ) : (
                      <AdminButton
                        icon={ShieldPlus}
                        tone="ember"
                        disabled={busy}
                        onClick={() => promote(u.id)}
                      >
                        Make admin
                      </AdminButton>
                    ))}
                  {!isDeleted && (
                    <AdminButton
                      icon={RotateCcw}
                      disabled={resetPassword.isPending || !u.loginMethods.password}
                      onClick={() => resetPassword.mutate({ userId: u.id })}
                    >
                      Reset
                    </AdminButton>
                  )}
                  {!isDeleted && (
                    <AdminButton
                      icon={KeyRound}
                      disabled={revokeSessions.isPending}
                      onClick={() => revokeSessions.mutate({ userId: u.id })}
                    >
                      Revoke
                    </AdminButton>
                  )}
                  {isSuspended ? (
                    <AdminButton
                      icon={PlayCircle}
                      tone="ember"
                      disabled={reactivate.isPending}
                      onClick={() => reactivate.mutate({ userId: u.id })}
                    >
                      Reactivate
                    </AdminButton>
                  ) : !isDeleted ? (
                    <AdminButton
                      icon={PauseCircle}
                      tone="danger"
                      disabled={suspend.isPending || lastAdmin}
                      onClick={() => suspendUser(u.id, u.name)}
                    >
                      Suspend
                    </AdminButton>
                  ) : null}
                  {!isDeleted && (
                    <AdminButton
                      icon={Trash2}
                      tone="danger"
                      disabled={remove.isPending || lastAdmin}
                      onClick={() => deleteUser(u.id, u.name)}
                    >
                      Delete
                    </AdminButton>
                  )}
                </span>
              </div>
            );
          })
        )}
      </AdminPanel>
      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      {confirmElement}
    </div>
  );
}
