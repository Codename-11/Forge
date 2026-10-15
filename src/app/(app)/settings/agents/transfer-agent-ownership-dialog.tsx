"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { CenterModal } from "@/components/ui/modal";
import { agentOwnerLabel } from "@/lib/agent-ownership-ui";

type Profile = {
  id: string;
  name: string;
  ownerType: string;
  ownerId: string | null;
  owner: { name: string | null } | null;
  updatedAt: Date;
  instanceShared: boolean;
  bindingCount: number;
  runtime: { name: string } | null;
};

export function TransferAgentOwnershipDialog({
  profile,
  onClose,
}: {
  profile: Profile;
  onClose: () => void;
}) {
  // Hold the reviewed ownership snapshot. A background refetch must not silently
  // accept a different owner or updated profile during confirmation.
  const [snapshot] = useState(profile);
  const currentOwnerType =
    snapshot.ownerType === "PERSONAL" || snapshot.ownerType === "SERVICE"
      ? snapshot.ownerType
      : null;
  const [ownerType, setOwnerType] = useState<"PERSONAL" | "SERVICE">(
    currentOwnerType ?? "PERSONAL",
  );
  const [ownerId, setOwnerId] = useState(snapshot.ownerId ?? "");
  const [clearRuntime, setClearRuntime] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [stale, setStale] = useState(false);
  const targets = trpc.agents.profiles.ownershipCandidates.useQuery();
  const utils = trpc.useUtils();
  const transfer = trpc.agents.profiles.transferOwnership.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.agents.profiles.get.invalidate({ id: snapshot.id }),
        utils.agents.profiles.list.invalidate(),
      ]);
      toast.success(
        "Agent ownership transferred. Workspace access and credentials were not transferred.",
      );
      onClose();
    },
    onError: (error) => {
      toast.error(error.message);
      if (error.data?.code === "CONFLICT") {
        setStale(true);
        void utils.agents.profiles.get.invalidate({ id: snapshot.id });
      }
    },
  });
  const selectedUser = targets.data?.find((user) => user.id === ownerId);
  const changed =
    snapshot.ownerType !== ownerType || (ownerType === "PERSONAL" && snapshot.ownerId !== ownerId);
  const canSubmit =
    !!currentOwnerType &&
    changed &&
    acknowledged &&
    !stale &&
    !transfer.isPending &&
    (ownerType === "SERVICE" || !!selectedUser);

  function submit() {
    if (!canSubmit || !currentOwnerType) return;
    transfer.mutate({
      id: snapshot.id,
      ownerType,
      ownerId: ownerType === "PERSONAL" ? ownerId : undefined,
      expectedOwnerType: currentOwnerType,
      expectedOwnerId: snapshot.ownerId,
      expectedUpdatedAt: snapshot.updatedAt,
      clearRuntime,
    });
  }

  return (
    <CenterModal
      open
      onOpenChange={(open) => {
        if (!open && !transfer.isPending) onClose();
      }}
      title={`Transfer ownership · ${snapshot.name}`}
      description="Change who manages this agent identity. Review the impact before confirming."
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={transfer.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="ember" size="sm" disabled={!canSubmit} onClick={submit}>
            {transfer.isPending ? "Transferring…" : "Confirm transfer"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">
          Current owner: <span className="font-medium">{agentOwnerLabel(snapshot)}</span>
        </p>
        <Combobox
          ariaLabel="New agent ownership type"
          disabled={transfer.isPending || stale}
          value={ownerType}
          onChange={(value) => {
            setOwnerType(value === "SERVICE" ? "SERVICE" : "PERSONAL");
            setAcknowledged(false);
          }}
          options={[
            { value: "PERSONAL", label: "Personal · active user" },
            { value: "SERVICE", label: "Service-owned · instance administrators" },
          ]}
          className="w-full"
        />
        {ownerType === "PERSONAL" && (
          <div className="space-y-1.5">
            <Combobox
              ariaLabel="New agent owner"
              disabled={transfer.isPending || stale}
              value={ownerId || null}
              onChange={(value) => {
                setOwnerId(value ?? "");
                setAcknowledged(false);
              }}
              searchable
              loading={targets.isLoading}
              options={(targets.data ?? []).map((user) => ({
                value: user.id,
                label: user.name ?? user.email ?? "Unnamed user",
                secondary: user.email ?? undefined,
              }))}
              placeholder="Choose an active user…"
              className="w-full"
            />
            <p className="text-meta text-muted-foreground">
              Only active accounts can receive personal ownership.
            </p>
            {targets.isError && (
              <p className="text-meta text-danger">
                Owner choices could not load. Close and retry before transferring.
              </p>
            )}
          </div>
        )}
        <div className="text-meta space-y-2 rounded-md border border-border bg-card/40 p-3 text-muted-foreground">
          <p>
            {ownerType === "SERVICE"
              ? "Instance administrators will manage this service identity. It will no longer belong to a human account."
              : `${selectedUser?.name ?? "The selected user"} will manage this identity. Previous personal owner rights are removed unless they are also an instance administrator.`}
          </p>
          <p>
            {snapshot.bindingCount} workspace access grants remain unchanged. Catalog availability
            stays {snapshot.instanceShared ? "instance-shared" : "restricted"}. Credential owners,
            scopes, history, and creator attribution remain unchanged.
          </p>
          <p>Ownership does not grant access to workspace data or transfer secret credentials.</p>
        </div>
        {snapshot.runtime && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={clearRuntime}
              disabled={transfer.isPending || stale}
              onChange={(event) => {
                setClearRuntime(event.target.checked);
                setAcknowledged(false);
              }}
              className="mt-1"
            />
            <span>
              Clear managed runtime assignment: {snapshot.runtime.name}
              <span className="text-meta mt-1 block text-muted-foreground">
                Select this if the host cannot be retained by the new owner. Inherited workspace
                runtime assignments are also cleared; managed dispatch must be configured again. The
                runtime itself and its credentials are not deleted or transferred.
              </span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={transfer.isPending || stale}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-1"
          />
          <span>I reviewed the ownership change and its impact on runtime configuration.</span>
        </label>
        {stale && (
          <p className="text-sm text-warning">
            The agent changed after this dialog opened. Close it and review the refreshed ownership
            before trying again.
          </p>
        )}
      </div>
    </CenterModal>
  );
}
