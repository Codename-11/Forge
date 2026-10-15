"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Confirm } from "@/components/ui/modal";
import {
  type PersonalAgentCreationPolicy,
  personalAgentCreationCopy,
} from "@/lib/agent-ownership-ui";
import { AdminLoading, AdminPanel } from "./admin-ui";

export function PersonalAgentPolicy() {
  const policy = trpc.agents.profiles.policy.useQuery();
  const [draft, setDraft] = useState<PersonalAgentCreationPolicy | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = trpc.useUtils();
  const save = trpc.agents.profiles.setPolicy.useMutation({
    onSuccess: async () => {
      await utils.agents.profiles.policy.invalidate();
      setDraft(null);
      setConfirmOpen(false);
      toast.success("Personal agent creation policy updated.");
    },
    onError: (error) => toast.error(error.message),
  });
  const value = draft ?? policy.data?.personalAgentCreation;
  return (
    <AdminPanel
      title="Personal agent creation"
      hint="Instance-wide policy for new user-owned identities"
    >
      {policy.isLoading ? (
        <AdminLoading />
      ) : policy.isError ? (
        <p className="p-4 text-sm text-danger">
          Could not load creation policy. Refresh before changing it.
        </p>
      ) : (
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Combobox
              ariaLabel="Personal agent creation policy"
              value={value ?? null}
              onChange={(next) => setDraft(next as PersonalAgentCreationPolicy)}
              options={[
                { value: "DISABLED", label: "Disabled", secondary: "Admins create identities" },
                {
                  value: "APPROVAL_REQUIRED",
                  label: "Approval required",
                  secondary: "Members request · admins review",
                },
                {
                  value: "SELF_SERVICE",
                  label: "Self-service",
                  secondary: "Users create their own agents",
                },
              ]}
              className="min-w-64"
            />
            <Button
              size="sm"
              variant="ember"
              disabled={!draft || draft === policy.data?.personalAgentCreation || save.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              Save policy
            </Button>
          </div>
          <p className="text-meta text-muted-foreground">
            {personalAgentCreationCopy(value).description}
          </p>
          <p className="text-meta text-muted-foreground">
            This controls new personal identities only. Existing identities and pending requests
            remain unchanged. Service identities, catalog sharing, workspace access, and credentials
            retain their separate administrator controls.
          </p>
        </div>
      )}
      <Confirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Change personal agent creation policy?"
        description={`${personalAgentCreationCopy(value).description} This applies instance-wide to new personal identity creation. It does not approve existing requests or grant workspace membership.`}
        primaryLabel="Apply policy"
        loading={save.isPending}
        onConfirm={async () => {
          if (draft) await save.mutateAsync({ personalAgentCreation: draft });
        }}
      />
    </AdminPanel>
  );
}
