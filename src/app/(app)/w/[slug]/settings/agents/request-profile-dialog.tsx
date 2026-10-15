"use client";
import { useState } from "react";
import { toast } from "sonner";
import { AgentProvider, RunEngine } from "@prisma/client";
import { CenterModal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { trpc } from "@/lib/trpc";
import { personalAgentCreationCopy } from "@/lib/agent-ownership-ui";

/**
 * Member-facing "Request a profile" form launched from Mission Control.
 * Non-admins can't define profiles globally, so this collects the
 * definition essentials and calls `agents.profiles.request` to create a
 * PENDING profile. An instance admin approves/rejects it from
 * `/admin/agents`. On success we invalidate the bind-catalog so the profile
 * appears once approved.
 */
export function RequestProfileDialog({
  open,
  onOpenChange,
  onCreated,
  setupMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (profile: { id: string; approvedAt: Date | null }) => void;
  setupMode?: "external" | "managed";
}) {
  const utils = trpc.useUtils();
  const policy = trpc.agents.profiles.policy.useQuery(undefined, { enabled: open });
  const creation = personalAgentCreationCopy(policy.data?.personalAgentCreation);
  const [name, setName] = useState("");
  const [profileKey, setProfileKey] = useState("");
  const [provider, setProvider] = useState<AgentProvider>(AgentProvider.HERMES);
  const [runEngine, setRunEngine] = useState<"DEFAULT" | RunEngine>("DEFAULT");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState("");
  const [capsText, setCapsText] = useState("");

  function reset() {
    setName("");
    setProfileKey("");
    setProvider(AgentProvider.HERMES);
    setRunEngine("DEFAULT");
    setDescription("");
    setAvatar("");
    setCapsText("");
  }

  const request = trpc.agents.profiles.request.useMutation({
    onSuccess: (profile) => {
      toast.success(
        profile.approvedAt
          ? "Personal agent created. Add workspace access to continue."
          : "Profile requested — an instance admin will review it.",
      );
      void utils.agents.bindings.catalog.invalidate();
      void utils.agents.profiles.list.invalidate();
      reset();
      onOpenChange(false);
      onCreated?.(profile);
    },
    onError: (e) => toast.error(e.message),
  });

  function submit() {
    if (!creation.enabled) {
      toast.error("Personal agent creation is not available under the current instance policy.");
      return;
    }
    if (!name.trim() || !profileKey.trim()) {
      toast.error("Name and profile key are required.");
      return;
    }
    const baseCapabilities = capsText
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    request.mutate({
      name: name.trim(),
      profileKey: profileKey.trim(),
      provider,
      runEngine: setupMode === "external" || runEngine === "DEFAULT" ? null : runEngine,
      description: description.trim() || undefined,
      avatar: avatar.trim() || undefined,
      baseCapabilities,
    });
  }

  return (
    <CenterModal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      size="md"
      title={creation.label}
      description={creation.description}
      primaryLabel={
        policy.data?.personalAgentCreation === "SELF_SERVICE" ? "Create my agent" : "Submit request"
      }
      onPrimary={submit}
      loading={request.isPending || policy.isLoading}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={request.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="ember"
            disabled={!creation.enabled || request.isPending || policy.isLoading}
            onClick={submit}
          >
            {policy.data?.personalAgentCreation === "SELF_SERVICE"
              ? "Create my agent"
              : "Submit request"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Display name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Research Bot"
              autoFocus
            />
          </Field>
          <Field label="Profile key" hint="Lowercase, digits, - or _">
            <Input
              value={profileKey}
              onChange={(e) =>
                setProfileKey(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ""))
              }
              placeholder="research-bot"
              className="font-mono"
            />
          </Field>
          <Field label="Provider">
            <Combobox
              ariaLabel="Personal agent provider"
              value={provider}
              onChange={(value) => {
                if (value) setProvider(value as AgentProvider);
              }}
              options={Object.values(AgentProvider).map((value) => ({
                value,
                label: value.toLowerCase(),
              }))}
              className="h-9 w-full"
            />
          </Field>
          {setupMode !== "external" && (
            <Field label="Run engine" hint="Default = integration's choice">
              <Combobox
                ariaLabel="Personal agent run engine"
                value={runEngine}
                onChange={(value) => setRunEngine((value ?? "DEFAULT") as "DEFAULT" | RunEngine)}
                options={[
                  { value: "DEFAULT", label: "Default" },
                  ...Object.values(RunEngine).map((value) => ({
                    value,
                    label: value.toLowerCase(),
                  })),
                ]}
                className="h-9 w-full"
              />
            </Field>
          )}
          <Field label="Avatar" hint="Optional emoji">
            <Input value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="🤖" />
          </Field>
          <Field label="Capabilities" hint="Comma-separated tags">
            <Input
              value={capsText}
              onChange={(e) => setCapsText(e.target.value)}
              placeholder="research, triage"
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Description" hint="Optional">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What this agent is for…"
            className="focus-ring w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 text-sm"
          />
        </Field>
      </div>
    </CenterModal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[0.6875rem] font-medium text-foreground">{label}</span>
        {hint && <span className="text-[0.625rem] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
