"use client";
import { useState } from "react";
import { toast } from "sonner";
import { AgentProvider, RunEngine } from "@prisma/client";
import { CenterModal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

/**
 * Member-facing "Request a profile" form on the workspace binding page.
 * Non-admins can't define profiles globally, so this collects the
 * definition essentials and calls `agents.profiles.request` to create a
 * PENDING profile. An instance admin approves/rejects it from
 * `/admin/agents`. On success we invalidate the bind-catalog so the profile
 * appears once approved.
 */
export function RequestProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
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
    onSuccess: () => {
      toast.success("Profile requested — an instance admin will review it.");
      void utils.agents.bindings.catalog.invalidate();
      void utils.agents.profiles.list.invalidate();
      reset();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  function submit() {
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
      runEngine: runEngine === "DEFAULT" ? null : runEngine,
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
      title="Request an agent profile"
      description="Profiles are defined globally and need an instance admin's approval before they can be bound to a workspace. Submit the definition essentials here — you'll see it in the catalog once it's approved."
      primaryLabel="Submit request"
      onPrimary={submit}
      loading={request.isPending}
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
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as AgentProvider)}
              className="focus-ring h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {Object.values(AgentProvider).map((p) => (
                <option key={p} value={p}>
                  {p.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Run engine" hint="Default = integration's choice">
            <select
              value={runEngine}
              onChange={(e) => setRunEngine(e.target.value as "DEFAULT" | RunEngine)}
              className="focus-ring h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="DEFAULT">Default</option>
              {Object.values(RunEngine).map((r) => (
                <option key={r} value={r}>
                  {r.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Avatar" hint="Optional emoji">
            <Input
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              placeholder="🤖"
            />
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
