"use client";
import { useState } from "react";
import { Check, Globe, GlobeLock, Power, PowerOff, Trash2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useConfirm } from "@/components/ui/modal";
import { ADMIN, AdminPanel, AdminLoading, AdminEmpty, AdminButton, relTime } from "./admin-ui";

/**
 * Instance agent-policy surface for `/admin/agents`. Lists global agent
 * profiles (`agents.profiles.list`) and exposes the two instance-admin
 * governance toggles: instance-shared (`setInstanceShared`) and
 * force-disable (`setDisabled`). Per-workspace bindings are configured in
 * each workspace's Settings → Agents — this page is policy only.
 * Part of the multi-workspace restructure.
 */
export function AdminAgents() {
  const utils = trpc.useUtils();
  const { confirm, confirmElement } = useConfirm();
  const profiles = trpc.agents.profiles.list.useQuery();
  const pending = trpc.agents.profiles.listPending.useQuery();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);

  async function invalidateAll() {
    await Promise.all([
      utils.agents.profiles.list.invalidate(),
      utils.agents.profiles.listPending.invalidate(),
    ]);
  }

  const approve = trpc.agents.profiles.approve.useMutation({
    onMutate: (v) => setReviewId(v.id),
    onSuccess: async () => {
      await invalidateAll();
      toast.success("Profile request approved.");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setReviewId(null),
  });
  const reject = trpc.agents.profiles.reject.useMutation({
    onMutate: (v) => setReviewId(v.id),
    onSuccess: async () => {
      await invalidateAll();
      toast.success("Profile request rejected.");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setReviewId(null),
  });

  const setShared = trpc.agents.profiles.setInstanceShared.useMutation({
    onMutate: (v) => setPendingId(v.id),
    onSuccess: async () => {
      await utils.agents.profiles.list.invalidate();
      toast.success("Profile sharing updated.");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setPendingId(null),
  });
  const setDisabled = trpc.agents.profiles.setDisabled.useMutation({
    onMutate: (v) => setPendingId(v.id),
    onSuccess: async () => {
      await utils.agents.profiles.list.invalidate();
      toast.success("Profile state updated.");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setPendingId(null),
  });
  const removeProfile = trpc.agents.profiles.remove.useMutation({
    onMutate: (v) => setPendingId(v.id),
    onSuccess: async (res) => {
      await invalidateAll();
      toast.success(
        res.action === "deleted"
          ? `Removed ${res.name}.`
          : `Archived ${res.name} — ${res.boundAgents} workspace binding${res.boundAgents === 1 ? "" : "s"} still reference it, so it was hidden instead of deleted.`,
      );
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setPendingId(null),
  });

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      <div className="mb-4 text-meta" style={{ color: ADMIN.textMuted }}>
        Agent definitions are owned globally; instance admins decide which are shared to every workspace&apos;s
        bind-catalog and which are force-disabled across the instance.
      </div>
      {/* Pending profile requests — members request, admins approve/reject. */}
      {(pending.isLoading || (pending.data?.length ?? 0) > 0) && (
        <div className="mb-6">
          <AdminPanel
            title="Pending requests"
            hint={pending.data?.length ? `${pending.data.length} awaiting review` : undefined}
          >
            {pending.isLoading ? (
              <AdminLoading />
            ) : !pending.data?.length ? (
              <AdminEmpty>No pending profile requests.</AdminEmpty>
            ) : (
              pending.data.map((p, i, arr) => {
                const busy = reviewId === p.id;
                const requester = p.requestedBy?.name ?? p.requestedBy?.email ?? "Unknown";
                return (
                  <div
                    key={p.id}
                    className="grid grid-cols-[1.6fr_1fr_0.6fr_1fr] items-center gap-2 px-4 py-2.5"
                    style={{ borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className="text-lg leading-none">
                        {p.avatar ?? "🤖"}
                      </span>
                      <span className="min-w-0">
                        <span className="truncate text-[0.8125rem] font-medium" style={{ color: ADMIN.text }}>
                          {p.name}
                        </span>
                        <span className="block text-[10px] font-mono" style={{ color: ADMIN.textDim }}>
                          @{p.profileKey}
                        </span>
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-meta" style={{ color: ADMIN.textSoft }}>
                      <UserPlus size={11} />
                      <span className="truncate">{requester}</span>
                      <span style={{ color: ADMIN.textDim }}>· {relTime(p.requestedAt)}</span>
                    </span>
                    <span className="flex min-w-0 flex-wrap gap-1">
                      {p.baseCapabilities.length === 0 ? (
                        <span className="text-meta" style={{ color: ADMIN.textDim }}>
                          no capabilities
                        </span>
                      ) : (
                        p.baseCapabilities.slice(0, 4).map((c) => (
                          <span
                            key={c}
                            className="rounded px-1 py-0.5 font-mono text-[10px]"
                            style={{ background: "var(--admin-border-soft)", color: ADMIN.textSoft }}
                          >
                            {c}
                          </span>
                        ))
                      )}
                    </span>
                    <span className="flex justify-end gap-1.5">
                      <AdminButton
                        icon={Check}
                        tone="ember"
                        disabled={busy}
                        onClick={() => approve.mutate({ id: p.id })}
                      >
                        Approve
                      </AdminButton>
                      <AdminButton
                        icon={X}
                        tone="danger"
                        disabled={busy}
                        onClick={() => reject.mutate({ id: p.id })}
                      >
                        Reject
                      </AdminButton>
                    </span>
                  </div>
                );
              })
            )}
          </AdminPanel>
        </div>
      )}

      <AdminPanel title="Agent profiles" hint={profiles.data ? `${profiles.data.length} global` : undefined}>
        <div
          className="grid grid-cols-[1.6fr_0.7fr_0.6fr_0.5fr_1.2fr] items-center gap-2 px-4 py-2 text-meta"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Profile</span>
          <span>Provider</span>
          <span>Runtime</span>
          <span className="text-right">Bindings</span>
          <span className="text-right">Instance policy</span>
        </div>
        {profiles.isLoading ? (
          <AdminLoading />
        ) : !profiles.data?.length ? (
          <AdminEmpty>No global agent profiles defined.</AdminEmpty>
        ) : (
          profiles.data.map((p, i, arr) => {
            const disabled = !!p.disabledAt;
            const busy = pendingId === p.id;
            return (
              <div
                key={p.id}
                className="grid grid-cols-[1.6fr_0.7fr_0.6fr_0.5fr_1.2fr] items-center gap-2 px-4 py-2.5"
                style={{ borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="text-lg leading-none">
                    {p.avatar ?? "🤖"}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[0.8125rem] font-medium" style={{ color: ADMIN.text }}>
                        {p.name}
                      </span>
                      {disabled && (
                        <span
                          className="rounded px-1 text-[9px] font-bold uppercase tracking-wider"
                          style={{ background: "rgba(239,68,68,0.18)", color: "hsl(var(--danger))" }}
                        >
                          disabled
                        </span>
                      )}
                      {p.instanceShared && (
                        <span
                          className="rounded px-1 text-[9px] font-bold uppercase tracking-wider"
                          style={{ background: "rgba(217,119,87,0.18)", color: ADMIN.ember }}
                        >
                          shared
                        </span>
                      )}
                    </span>
                    <span className="block text-[10px] font-mono" style={{ color: ADMIN.textDim }}>
                      @{p.profileKey}
                    </span>
                  </span>
                </span>
                <span className="truncate text-meta" style={{ color: ADMIN.textSoft }}>
                  {p.provider.toLowerCase()}
                </span>
                <span className="truncate text-meta font-mono" style={{ color: ADMIN.textSoft }}>
                  {p.runtime?.name ?? "—"}
                </span>
                <span className="text-right font-mono text-[0.8125rem] tabular-nums" style={{ color: ADMIN.text }}>
                  {p.bindings.length}
                </span>
                <span className="flex justify-end gap-1.5">
                  <AdminButton
                    icon={p.instanceShared ? GlobeLock : Globe}
                    tone={p.instanceShared ? "default" : "ember"}
                    disabled={busy}
                    onClick={() => setShared.mutate({ id: p.id, instanceShared: !p.instanceShared })}
                  >
                    {p.instanceShared ? "Unshare" : "Share"}
                  </AdminButton>
                  <AdminButton
                    icon={disabled ? Power : PowerOff}
                    tone={disabled ? "default" : "danger"}
                    disabled={busy}
                    onClick={() => setDisabled.mutate({ id: p.id, disabled: !disabled })}
                  >
                    {disabled ? "Enable" : "Disable"}
                  </AdminButton>
                  <AdminButton
                    icon={Trash2}
                    tone="danger"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Remove ${p.name}?`,
                          description:
                            "If any workspace still has this profile bound, it's archived (hidden, bindings kept intact). If nothing references it, it's permanently deleted. You can re-create a profile with the same key later.",
                          primaryLabel: "Remove",
                          variant: "destructive",
                        })
                      ) {
                        removeProfile.mutate({ id: p.id });
                      }
                    }}
                  >
                    Remove
                  </AdminButton>
                </span>
              </div>
            );
          })
        )}
      </AdminPanel>
      {confirmElement}
    </div>
  );
}
