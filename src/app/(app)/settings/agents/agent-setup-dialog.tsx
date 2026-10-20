"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CenterModal } from "@/components/ui/modal";
import { Combobox } from "@/components/ui/combobox";
import {
  agentSetupDestination,
  type AgentSetupMode,
  type ManagedSetupTask,
} from "@/lib/agent-setup";
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
  const [managedTask, setManagedTask] = useState<ManagedSetupTask>("runtime");
  const choosingRuntime = mode === "managed" && managedTask === "runtime";
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const profile = profiles.find((item) => item.id === profileId);
  const canManage = workspace?.role === "OWNER" || workspace?.role === "ADMIN";
  const destination = agentSetupDestination({ mode, workspace, profile, managedTask });
  const binding = profile?.bindings.find((item) => item.workspace.id === workspaceId);
  const creation = personalAgentCreationCopy(personalCreationPolicy);

  return (
    <CenterModal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="md"
      title={mode === "external" ? "Connect an external client" : "Set up managed execution"}
      description={
        mode === "external"
          ? "Use Codex Desktop, a CLI, or another MCP client. Your client executes the work; no Forge runtime is required."
          : "Connect a Hermes or Codex execution host first, or configure an agent identity to use a runtime. These are separate steps."
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
              {choosingRuntime ? "Connect runtime" : "Continue"}
            </Link>
          ) : (
            <Button variant="ember" size="sm" disabled>
              {choosingRuntime ? "Connect runtime" : "Continue"}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {mode === "managed" && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What would you like to set up?</legend>
            {(
              [
                [
                  "runtime",
                  "Connect a runtime",
                  "Register a Hermes, Codex, or other supported host. No agent identity is required yet.",
                ],
                [
                  "agent",
                  "Configure an agent",
                  "Choose or create an identity, then give it workspace access and an execution runtime.",
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 hover:bg-subtle/40"
              >
                <input
                  type="radio"
                  name="managed-setup-task"
                  value={value}
                  checked={managedTask === value}
                  onChange={() => {
                    setManagedTask(value);
                    setProfileId("");
                  }}
                  className="mt-0.5 accent-[hsl(var(--ember))]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="text-meta block text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="space-y-1.5">
          <p className="text-sm font-medium">
            {choosingRuntime ? "Runtime home workspace" : "Workspace access"}
          </p>
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
            {choosingRuntime
              ? "Choose where to register and manage the host. Registration alone does not grant agents access or start any work."
              : "Credentials and permissions apply only to this workspace. You can add other workspaces separately."}
          </p>
        </div>
        {!choosingRuntime && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">
              {mode === "external" ? "Act as · agent identity is optional" : "Agent identity"}
            </p>
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
                ? mode === "external"
                  ? "The agent is the acting identity. The issued key also records the human operator; sharing an identity does not grant workspace access."
                  : "This is who does the work, not the host that executes it. Continue to review workspace access and its runtime."
                : mode === "external"
                  ? "Actions are attributed to your user account. Choose an agent above for a separate agent identity."
                  : "Choose an existing agent or create/request a new identity below."}
            </p>
          </div>
        )}
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
            View existing runtimes in {workspace.name} →
          </Link>
        )}
        {!choosingRuntime && (
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
        )}
      </div>
    </CenterModal>
  );
}
