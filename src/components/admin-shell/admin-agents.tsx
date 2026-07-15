"use client";
import { useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, Globe, GlobeLock, Power, PowerOff, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
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
  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      <div className="text-meta mb-4" style={{ color: ADMIN.textMuted }}>
        <span
          className="mr-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style={{ background: "var(--admin-border-soft)", color: ADMIN.textSoft }}
        >
          Instance policy
        </span>
        Approve requests, control instance sharing, and force-disable profiles. Routine identity,
        binding, archive, and removal work lives in Mission Control.
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
                    style={{
                      borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}`,
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className="text-lg leading-none">
                        {p.avatar ?? "🤖"}
                      </span>
                      <span className="min-w-0">
                        <span
                          className="truncate text-[0.8125rem] font-medium"
                          style={{ color: ADMIN.text }}
                        >
                          {p.name}
                        </span>
                        <span
                          className="block font-mono text-[10px]"
                          style={{ color: ADMIN.textDim }}
                        >
                          @{p.profileKey}
                        </span>
                      </span>
                    </span>
                    <span
                      className="text-meta flex min-w-0 items-center gap-1.5"
                      style={{ color: ADMIN.textSoft }}
                    >
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
                            style={{
                              background: "var(--admin-border-soft)",
                              color: ADMIN.textSoft,
                            }}
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

      <AdminPanel
        title="Agent profiles"
        hint={profiles.data ? `${profiles.data.length} global` : undefined}
      >
        <div
          className="text-meta grid grid-cols-[1.6fr_0.7fr_0.6fr_0.5fr_1.2fr] items-center gap-2 px-4 py-2"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Profile</span>
          <span>Provider</span>
          <span>Runtime</span>
          <span className="text-right">Bindings</span>
          <span className="text-right">Governance</span>
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
                style={{
                  borderBottom: i === arr.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}`,
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="text-lg leading-none">
                    {p.avatar ?? "🤖"}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="truncate text-[0.8125rem] font-medium"
                        style={{ color: ADMIN.text }}
                      >
                        {p.name}
                      </span>
                      {disabled && (
                        <span
                          className="rounded px-1 text-[9px] font-bold uppercase tracking-wider"
                          style={{
                            background: "rgba(239,68,68,0.18)",
                            color: "hsl(var(--danger))",
                          }}
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
                    <span className="block font-mono text-[10px]" style={{ color: ADMIN.textDim }}>
                      @{p.profileKey}
                    </span>
                  </span>
                </span>
                <span className="text-meta truncate" style={{ color: ADMIN.textSoft }}>
                  {p.provider.toLowerCase()}
                </span>
                <span className="text-meta truncate font-mono" style={{ color: ADMIN.textSoft }}>
                  {p.runtime?.name ?? "—"}
                </span>
                <span
                  className="text-right font-mono text-[0.8125rem] tabular-nums"
                  style={{ color: ADMIN.text }}
                >
                  {p.bindings.length}
                </span>
                <span className="flex justify-end gap-1.5">
                  <AdminButton
                    icon={p.instanceShared ? GlobeLock : Globe}
                    tone={p.instanceShared ? "default" : "ember"}
                    disabled={busy}
                    onClick={() =>
                      setShared.mutate({ id: p.id, instanceShared: !p.instanceShared })
                    }
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
                  <Link
                    href={`/agents/${p.id}`}
                    className="inline-flex h-7 items-center gap-1.5 rounded px-2 text-[0.6875rem] font-medium"
                    style={{
                      background: "var(--admin-border-soft)",
                      color: ADMIN.textSoft,
                      border: `1px solid ${ADMIN.border}`,
                    }}
                  >
                    <ExternalLink size={11} /> Manage
                  </Link>
                </span>
              </div>
            );
          })
        )}
      </AdminPanel>
    </div>
  );
}
