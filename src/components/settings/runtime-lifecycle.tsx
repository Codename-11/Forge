"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { canConfirmRuntimeLifecycle, runtimeOwnershipLabel } from "@/lib/runtime-ownership";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { CenterModal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui";

type RuntimeLifecycleMode = "transfer" | "remove" | "prepare";

/** Instance-only controls; backend independently enforces authority and snapshot freshness. */
export function RuntimeLifecycleActions({
  id,
  canManage,
  onChanged,
}: {
  id: string;
  canManage: boolean;
  onChanged?: (mode: RuntimeLifecycleMode) => void;
}) {
  const [mode, setMode] = useState<RuntimeLifecycleMode | null>(null);
  if (!canManage) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setMode("prepare")}>
          Archive & disable
        </Button>
        <Button size="sm" variant="outline" onClick={() => setMode("transfer")}>
          Transfer ownership / home
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode("remove")}>
          Remove registration
        </Button>
      </div>
      {mode && (
        <RuntimeLifecycleDialog
          id={id}
          mode={mode}
          onClose={() => setMode(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

function RuntimeLifecycleDialog({
  id,
  mode,
  onClose,
  onChanged,
}: {
  id: string;
  mode: RuntimeLifecycleMode;
  onClose: () => void;
  onChanged?: (mode: RuntimeLifecycleMode) => void;
}) {
  const utils = trpc.useUtils();
  const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
  const [ownerType, setOwnerType] = useState<"PERSONAL" | "SERVICE" | null>(null);
  const [ownerId, setOwnerId] = useState<string | null | undefined>(undefined);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const impact = trpc.runtime.lifecycleImpact.useQuery(
    { id, targetWorkspaceId: targetWorkspaceId || undefined },
    { staleTime: 0, refetchOnMount: "always" },
  );
  const workspaces = trpc.instanceAdmin.tenants.useQuery(undefined, {
    enabled: mode === "transfer",
  });
  const users = trpc.instanceAdmin.users.useQuery(undefined, { enabled: mode === "transfer" });
  const transfer = trpc.runtime.lifecycleTransfer.useMutation();
  const remove = trpc.runtime.lifecycleRemove.useMutation();
  const prepare = trpc.runtime.lifecyclePrepare.useMutation();
  const pending = transfer.isPending || remove.isPending || prepare.isPending;
  const snapshot = impact.data?.runtime;
  const effectiveOwnerType =
    ownerType ??
    (snapshot?.ownerType === "PERSONAL" || snapshot?.ownerType === "SERVICE"
      ? snapshot.ownerType
      : null);
  const effectiveOwnerId = ownerId === undefined ? (snapshot?.ownerId ?? null) : ownerId;
  const effectiveWorkspaceId = targetWorkspaceId || snapshot?.workspaceId || "";
  const hasTransferChange =
    !!snapshot &&
    (effectiveWorkspaceId !== snapshot.workspaceId ||
      effectiveOwnerType !== snapshot.ownerType ||
      (effectiveOwnerType === "PERSONAL" ? effectiveOwnerId : null) !== snapshot.ownerId);
  const blockers =
    (mode === "prepare"
      ? []
      : mode === "remove"
        ? impact.data?.removeBlockers
        : impact.data?.transferBlockers) ?? [];
  const destinationReady =
    mode !== "transfer" ||
    (!!effectiveOwnerType &&
      hasTransferChange &&
      !workspaces.isLoading &&
      !workspaces.isError &&
      !!workspaces.data?.some((workspace) => workspace.id === effectiveWorkspaceId) &&
      (effectiveOwnerType !== "PERSONAL" ||
        (!users.isLoading &&
          !users.isError &&
          !!users.data?.some(
            (user) =>
              user.id === effectiveOwnerId &&
              user.status === "ACTIVE" &&
              !user.disabledAt &&
              !user.deletedAt,
          ))));
  const allowed =
    !!snapshot &&
    !(mode === "prepare" && snapshot.archivedAt && snapshot.disabledAt) &&
    destinationReady &&
    canConfirmRuntimeLifecycle({
      name: snapshot.name,
      confirmation,
      blockers,
      fetching: impact.isFetching || impact.isError,
      pending,
      ownerRequired: mode === "transfer" && effectiveOwnerType === "PERSONAL",
      ownerId: effectiveOwnerId,
    });

  async function submit() {
    if (!snapshot || !allowed) return;
    setError(null);
    const expected = {
      id,
      expectedWorkspaceId: snapshot.workspaceId,
      expectedOwnerType: snapshot.ownerType,
      expectedOwnerId: snapshot.ownerId,
      expectedUpdatedAt: snapshot.updatedAt,
      confirmName: confirmation,
    };
    try {
      if (mode === "prepare") {
        await prepare.mutateAsync(expected);
        toast.success(
          "Registration archived and disabled in Forge. The external host was not stopped.",
        );
      } else if (mode === "remove") {
        await remove.mutateAsync(expected);
        toast.success("Runtime registration removed. The external host was not stopped.");
      } else {
        if (!effectiveOwnerType) return;
        await transfer.mutateAsync({
          ...expected,
          targetWorkspaceId: effectiveWorkspaceId,
          ownerType: effectiveOwnerType,
          ownerId: effectiveOwnerType === "PERSONAL" ? effectiveOwnerId : null,
        });
        toast.success("Runtime ownership and registration home updated.");
      }
      await Promise.all([
        utils.runtime.list.invalidate(),
        ...(mode === "remove" ? [] : [utils.runtime.byId.invalidate({ id })]),
        utils.global.runtimes.invalidate(),
        utils.global.runtimeOptions.invalidate(),
        utils.instanceAdmin.runtimes.invalidate(),
      ]);
      onClose();
      onChanged?.(mode);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The change could not be applied.");
      setConfirmation("");
      void impact.refetch();
    }
  }

  return (
    <CenterModal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      size="md"
      title={
        mode === "prepare"
          ? "Archive & disable runtime"
          : mode === "remove"
            ? "Remove runtime registration"
            : "Transfer runtime ownership / home"
      }
      description="Instance-administrator action. Review the current impact before confirming."
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={mode === "remove" ? "danger" : "ember"}
            disabled={!allowed}
            onClick={() => void submit()}
          >
            {pending
              ? "Applying…"
              : mode === "prepare"
                ? "Archive & disable"
                : mode === "remove"
                  ? "Remove registration"
                  : "Confirm transfer"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="rounded-md border border-border bg-subtle/40 p-3 text-muted-foreground">
          {mode === "prepare"
            ? "This archives and disables the registration in Forge, preventing future managed use. It does not stop the external host or finish existing runs and delivery sessions. Resolve that work separately before transfer or removal."
            : mode === "remove"
              ? "This permanently deletes Forge's registration only. It does not stop or uninstall the external host, erase its files, or revoke credentials outside Forge."
              : "Ownership is separate from registration home and workspace access. Transfer does not grant workspace membership, move credentials silently, or restart the external host."}
        </p>
        {impact.isLoading ? (
          <Spinner />
        ) : impact.isError ? (
          <div role="alert" className="space-y-2 text-danger">
            <p>Could not load the impact preview: {impact.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void impact.refetch()}>
              Retry preview
            </Button>
          </div>
        ) : (
          snapshot && (
            <>
              <dl className="text-meta grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border p-3">
                <dt className="text-muted-foreground">Runtime</dt>
                <dd className="break-words font-medium">{snapshot.name}</dd>
                <dt className="text-muted-foreground">Current ownership</dt>
                <dd>{runtimeOwnershipLabel(snapshot)}</dd>
                <dt className="text-muted-foreground">Registration home</dt>
                <dd className="break-words">{snapshot.workspace.name}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  {snapshot.archivedAt ? "Archived" : "Not archived"} ·{" "}
                  {snapshot.disabledAt ? "Disabled" : "Enabled"}
                </dd>
              </dl>
              {mode === "prepare" && snapshot.archivedAt && snapshot.disabledAt && (
                <p className="text-meta text-muted-foreground">
                  This registration is already archived and disabled. Review transfer or removal to
                  see its remaining blockers.
                </p>
              )}
              {mode === "transfer" && (
                <fieldset className="space-y-3" disabled={pending}>
                  <legend className="mb-2 font-medium">Destination</legend>
                  <div>
                    <div className="text-meta mb-1 text-muted-foreground">Registration home</div>
                    <Combobox
                      ariaLabel="Registration home"
                      value={effectiveWorkspaceId}
                      options={(workspaces.data ?? []).map((workspace) => ({
                        value: workspace.id,
                        label: workspace.name,
                        secondary: workspace.key,
                      }))}
                      searchable
                      loading={workspaces.isLoading}
                      onChange={(value) => {
                        setTargetWorkspaceId(value ?? "");
                        setConfirmation("");
                      }}
                    />
                  </div>
                  <div>
                    <div className="text-meta mb-1 text-muted-foreground">Ownership</div>
                    <Combobox
                      ariaLabel="Ownership type"
                      value={effectiveOwnerType}
                      options={[
                        { value: "PERSONAL", label: "Personal", secondary: "Owned by one user" },
                        {
                          value: "SERVICE",
                          label: "Service-owned",
                          secondary: "Managed by instance administrators",
                        },
                      ]}
                      onChange={(value) => {
                        if (value === "PERSONAL" || value === "SERVICE") setOwnerType(value);
                        setConfirmation("");
                      }}
                    />
                  </div>
                  {effectiveOwnerType === "PERSONAL" && (
                    <div>
                      <div className="text-meta mb-1 text-muted-foreground">Personal owner</div>
                      <Combobox
                        ariaLabel="Personal owner"
                        value={effectiveOwnerId}
                        searchable
                        loading={users.isLoading}
                        placeholder="Choose an active user"
                        options={(users.data ?? [])
                          .filter(
                            (user) =>
                              user.status === "ACTIVE" && !user.disabledAt && !user.deletedAt,
                          )
                          .map((user) => ({
                            value: user.id,
                            label: user.name ?? user.email,
                            secondary: user.email,
                          }))}
                        onChange={(value) => {
                          setOwnerId(value);
                          setConfirmation("");
                        }}
                      />
                      <p className="text-meta mt-1 text-muted-foreground">
                        The personal owner must already be a member of the destination workspace.
                        This action does not add membership.
                      </p>
                    </div>
                  )}
                  {(users.isError || workspaces.isError) && (
                    <p role="alert" className="text-meta text-danger">
                      Could not load transfer destinations. Close and retry before transferring.
                    </p>
                  )}
                  {!hasTransferChange && (
                    <p className="text-meta text-muted-foreground">
                      Choose a different owner or registration home to transfer this registration.
                    </p>
                  )}
                </fieldset>
              )}
              <details className="rounded-md border border-border p-3">
                <summary className="focus-ring cursor-pointer font-medium">
                  Registration impact · linked records
                </summary>
                <dl className="text-meta mt-3 grid grid-cols-2 gap-2">
                  {Object.entries(impact.data?.counts ?? {}).map(([label, count]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{label.replace(/([A-Z])/g, " $1")}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
              </details>
              {mode === "remove" && impact.data && (
                <p className="text-meta rounded-md border border-danger/30 bg-danger/5 p-3">
                  Permanent removal also deletes this registration&apos;s Forge configuration,
                  including {impact.data.counts.secrets} stored secret(s) and{" "}
                  {impact.data.counts.repos} repository setting(s). External credentials are not
                  revoked.
                </p>
              )}
              {blockers.length > 0 && (
                <div role="status" className="rounded-md border border-warning/40 bg-warning/5 p-3">
                  <p className="font-medium">
                    Resolve before {mode === "remove" ? "removal" : "transfer"}
                  </p>
                  <ul className="text-meta mt-2 list-disc space-y-1 pl-5">
                    {blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <label htmlFor={`runtime-confirm-${id}`} className="text-meta block">
                  Type <strong>{snapshot.name}</strong> exactly to confirm
                </label>
                <Input
                  id={`runtime-confirm-${id}`}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  disabled={pending || blockers.length > 0}
                  className="mt-1"
                />
              </div>
              <p className="text-meta text-muted-foreground">
                Forge rechecks this snapshot when you confirm. A changed registration or new
                dependency requires another review.
              </p>
            </>
          )
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
    </CenterModal>
  );
}
