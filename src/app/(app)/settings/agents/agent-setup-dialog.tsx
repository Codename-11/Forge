"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CenterModal } from "@/components/ui/modal";
import { Combobox } from "@/components/ui/combobox";
import { agentSetupDestination, type AgentSetupMode } from "@/lib/agent-setup";
import {
  personalAgentCreationCopy,
  type PersonalAgentCreationPolicy,
} from "@/lib/agent-ownership-ui";

type Workspace = { id: string; slug: string; name: string; key: string; role?: string };
type Profile = {
  id: string;
  name: string;
  ownedByMe: boolean;
  instanceShared: boolean;
  ownerType?: string;
  availability: { state: string };
  bindings: Array<{ id: string; workspace: { id: string } }>;
};

export function AgentSetupDialog({
  mode,
  workspaces,
  profiles,
  initialWorkspaceId,
  isInstanceAdmin,
  personalCreationPolicy,
  onClose,
  onCreate,
}: {
  mode: AgentSetupMode;
  workspaces: Workspace[];
  profiles: Profile[];
  initialWorkspaceId?: string;
  isInstanceAdmin: boolean;
  personalCreationPolicy?: PersonalAgentCreationPolicy;
  onClose: () => void;
  onCreate: (workspaceId: string) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    workspaces.some((workspace) => workspace.id === initialWorkspaceId)
      ? initialWorkspaceId!
      : workspaces.length === 1
        ? workspaces[0].id
        : "",
  );
  const [profileId, setProfileId] = useState("");
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const profile = profiles.find((item) => item.id === profileId);
  const canManage = workspace?.role === "OWNER" || workspace?.role === "ADMIN";
  const destination = agentSetupDestination({ mode, workspace, profile });
  const binding = profile?.bindings.find((item) => item.workspace.id === workspaceId);
  const creation = personalAgentCreationCopy(personalCreationPolicy);

  return (
    <CenterModal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="md"
      title={mode === "external" ? "Connect an external client" : "Let Forge run an agent"}
      description={
        mode === "external"
          ? "Use Codex Desktop, a CLI, or another MCP client. Your client executes the work; no Forge runtime is required."
          : "Forge dispatches work to a managed execution runtime. Choose the workspace and agent before configuring its host."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {destination ? (
            <Link
              className="focus-ring inline-flex h-8 items-center rounded-md bg-ember px-3 text-xs font-medium text-ember-foreground"
              href={destination}
            >
              Continue
            </Link>
          ) : (
            <Button variant="ember" size="sm" disabled>
              Continue
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Workspace access</p>
          <Combobox
            ariaLabel="Setup workspace"
            value={workspaceId || null}
            onChange={(value) => {
              setWorkspaceId(value ?? "");
              setProfileId("");
            }}
            options={workspaces.map((item) => ({
              value: item.id,
              label: item.name,
              secondary: item.key,
            }))}
            placeholder="Choose workspace…"
            className="w-full"
          />
          <p className="text-meta text-muted-foreground">
            Credentials and permissions apply only to this workspace. You can add other workspaces
            separately.
          </p>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Acting identity</p>
          <Combobox
            ariaLabel="Setup agent identity"
            value={profileId || null}
            onChange={(value) => setProfileId(value ?? "")}
            options={[
              ...(mode === "external"
                ? [{ value: "", label: "My account", secondary: "Personal MCP token" }]
                : []),
              ...profiles
                .filter(
                  (item) =>
                    item.availability.state === "AVAILABLE" &&
                    (isInstanceAdmin || item.ownedByMe || item.instanceShared),
                )
                .map((item) => ({
                  value: item.id,
                  label: item.name,
                  secondary:
                    item.ownerType === "SERVICE"
                      ? "Service-owned"
                      : item.ownedByMe
                        ? "Owned by you"
                        : "Available agent",
                })),
            ]}
            placeholder={
              mode === "external" ? "My account · Personal MCP token" : "Choose an agent…"
            }
            className="w-full"
          />
          <p className="text-meta text-muted-foreground">
            {profile
              ? "The agent is the acting identity. The issued key also records the human operator; sharing an identity does not grant workspace access."
              : mode === "external"
                ? "Actions are attributed to your user account. Choose an agent above for a separate agent identity."
                : "Choose an existing agent or create/request a new identity below."}
          </p>
        </div>
        {workspace?.role === "GUEST" && (
          <p className="text-sm text-warning">
            Guests cannot create credentials. Ask a workspace administrator for access.
          </p>
        )}
        {workspace && mode === "managed" && !canManage && (
          <p className="text-sm text-warning">
            Managed setup requires an owner or admin of this workspace.
          </p>
        )}
        {workspace && profile && mode === "external" && (!binding || !canManage) && (
          <p className="text-sm text-muted-foreground">
            Continue to this agent’s workspace access.{" "}
            {canManage
              ? "Add it to the workspace, then choose Add MCP client."
              : "A workspace administrator must add the agent or issue its client credential."}
          </p>
        )}
        {workspace && mode === "managed" && canManage && (
          <Link
            href={`/w/${encodeURIComponent(workspace.slug)}/settings/runtimes`}
            className="focus-ring inline-flex text-sm text-ember hover:underline"
          >
            Register or inspect a runtime in {workspace.name} →
          </Link>
        )}
        <div className="border-t border-border pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={
              !workspace || workspace.role === "GUEST" || (!isInstanceAdmin && !creation.enabled)
            }
            onClick={() => onCreate(workspaceId)}
          >
            {isInstanceAdmin ? "Create a new agent" : creation.label}
          </Button>
          <p className="text-meta mt-2 text-muted-foreground">
            {isInstanceAdmin
              ? "Choose personal or service ownership when creating an identity. Workspace access and catalog sharing remain separate controls."
              : creation.description}
          </p>
        </div>
      </div>
    </CenterModal>
  );
}
