"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Bot, ChevronRight, Plus, Shield } from "lucide-react";
import { AgentProvider, RunEngine } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CenterModal } from "@/components/ui/modal";
import { Spinner, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { workspaceChipColor } from "@/components/global-shell/global-shell";

/**
 * Client body for the global agent profiles list. Each card links to its
 * detail page. Reads from `agents.profiles.list` (mounted under
 * `trpc.agents.profiles.*`).
 */

type Workspace = { id: string; slug: string; name: string; key: string };

function StatusPip({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 9999,
        background: online ? "hsl(var(--success))" : "hsl(var(--muted-foreground))",
        display: "inline-block",
      }}
    />
  );
}

function WsChipDense({ ws }: { ws: Workspace }) {
  return (
    <span className="inline-flex items-center gap-1 text-meta">
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] text-[8px] font-bold text-white"
        style={{ background: workspaceChipColor(ws.key) }}
      >
        {ws.key[0]}
      </span>
      <span className="text-foreground/85">{ws.key}</span>
    </span>
  );
}

export function AgentsContent({ isInstanceAdmin }: { isInstanceAdmin: boolean }) {
  const { data: profiles, isLoading } = trpc.agents.profiles.list.useQuery();
  const utils = trpc.useUtils();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [profileKey, setProfileKey] = useState("");
  const [provider, setProvider] = useState<AgentProvider>(AgentProvider.HERMES);
  const [runEngine, setRunEngine] = useState<"DEFAULT" | RunEngine>("DEFAULT");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState("");
  const [capsText, setCapsText] = useState("");
  const [instanceShared, setInstanceShared] = useState(true);

  function resetCreate() {
    setName("");
    setProfileKey("");
    setProvider(AgentProvider.HERMES);
    setRunEngine("DEFAULT");
    setDescription("");
    setAvatar("");
    setCapsText("");
    setInstanceShared(true);
  }

  const createProfile = trpc.agents.profiles.create.useMutation({
    onSuccess: () => {
      toast.success("Agent profile created.");
      void utils.agents.profiles.list.invalidate();
      resetCreate();
      setCreateOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  function submitCreate() {
    if (!name.trim() || !profileKey.trim()) {
      toast.error("Name and profile key are required.");
      return;
    }
    const baseCapabilities = capsText
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    createProfile.mutate({
      name: name.trim(),
      profileKey: profileKey.trim(),
      provider,
      runEngine: runEngine === "DEFAULT" ? null : runEngine,
      description: description.trim() || undefined,
      avatar: avatar.trim() || undefined,
      baseCapabilities,
      instanceShared,
    });
  }

  return (
    <>
      <Topbar
        title="Agents"
        subtitle="Profiles you've defined. Each profile is a global identity — the same agent reaches every workspace you bind it to."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-5 p-6">
          {/* Create affordance / admin-gated hint */}
          <div className="flex items-center gap-3 rounded-md border border-ember/30 bg-ember/5 p-3">
            <Shield size={14} className="shrink-0 text-ember" />
            <div className="min-w-0 flex-1 text-[0.8125rem]">
              <span className="font-medium">New agent profiles are instance-admin-gated.</span>
              <span className="ml-1 text-muted-foreground">
                {isInstanceAdmin
                  ? "You can create and share profiles across the instance."
                  : "Members can request a profile; an instance admin approves it."}
              </span>
            </div>
            {isInstanceAdmin ? (
              <Button
                type="button"
                variant="ember"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={12} />
                New profile
              </Button>
            ) : (
              <span className="rounded border border-border/70 bg-card/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                requires instance admin
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : (profiles?.length ?? 0) === 0 ? (
            <EmptyState
              variant="section"
              icon={<Bot />}
              title="No agent profiles yet"
              description="Agent profiles are global identities you bind into workspaces."
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card/40">
              {profiles!.map((a) => (
                <Link
                  key={a.id}
                  href={`/settings/agents/${a.id}`}
                  className="group flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 hover:bg-subtle"
                >
                  <span className="text-xl">{a.avatar ?? "🤖"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[0.8125rem] font-semibold">{a.name}</span>
                      <StatusPip online={a.online} />
                      <span className="font-mono text-[10px] text-muted-foreground">@{a.profileKey}</span>
                      {a.instanceShared && (
                        <span className="rounded border border-border/70 bg-card/60 px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                          instance
                        </span>
                      )}
                      {!a.ownedByMe && (
                        <span className="rounded border border-border/70 bg-card/60 px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                          shared
                        </span>
                      )}
                    </div>
                    {a.description && (
                      <div className="mt-0.5 truncate text-meta text-muted-foreground">{a.description}</div>
                    )}
                  </div>
                  <div className="hidden w-28 shrink-0 sm:block">
                    <div className="text-[0.8125rem] font-medium">{a.provider.toLowerCase()}</div>
                    {a.runEngine && (
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {a.runEngine.toLowerCase()}
                      </div>
                    )}
                  </div>
                  <div className="hidden w-32 shrink-0 truncate md:block">
                    {a.runtime ? (
                      <>
                        <div className="truncate text-[0.8125rem] font-medium">{a.runtime.name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {a.runtime.kind.toLowerCase().replace("_", " ")}
                        </div>
                      </>
                    ) : (
                      <span className="text-[0.8125rem] italic text-muted-foreground">unassigned</span>
                    )}
                  </div>
                  <div className="hidden w-36 shrink-0 lg:block">
                    <div className="mb-0.5 text-[10px] text-muted-foreground">
                      {a.bindings.length} binding{a.bindings.length === 1 ? "" : "s"}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {a.bindings.length === 0 ? (
                        <span className="text-[10px] italic text-muted-foreground">none</span>
                      ) : (
                        a.bindings.slice(0, 3).map((b) => <WsChipDense key={b.id} ws={b.workspace} />)
                      )}
                      {a.bindings.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{a.bindings.length - 3}</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight
                    size={14}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      <CenterModal
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) resetCreate();
          setCreateOpen(open);
        }}
        size="md"
        title="Create agent profile"
        description="Define the global profile first. Bind it to workspaces and provision keys or runtime hosts after creation."
        primaryLabel="Create profile"
        onPrimary={submitCreate}
        loading={createProfile.isPending}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ProfileField label="Name" hint="Display name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Review Bot"
                autoFocus
              />
            </ProfileField>
            <ProfileField label="Profile key" hint="Lowercase, digits, - or _">
              <Input
                value={profileKey}
                onChange={(e) =>
                  setProfileKey(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ""))
                }
                placeholder="review-bot"
                className="font-mono"
              />
            </ProfileField>
            <ProfileField label="Provider">
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
            </ProfileField>
            <ProfileField label="Run engine" hint="Default = provider choice">
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
            </ProfileField>
            <ProfileField label="Avatar" hint="Optional">
              <Input
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                placeholder="VI"
              />
            </ProfileField>
            <ProfileField label="Capabilities" hint="Comma-separated tags">
              <Input
                value={capsText}
                onChange={(e) => setCapsText(e.target.value)}
                placeholder="review, terminal, code"
                className="font-mono"
              />
            </ProfileField>
          </div>
          <ProfileField label="Description" hint="Optional">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What this profile is for..."
              className="focus-ring w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 text-sm"
            />
          </ProfileField>
          <label className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={instanceShared}
              onChange={(e) => setInstanceShared(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block font-medium text-foreground">
                Share in every workspace catalog
              </span>
              <span className="block text-meta text-muted-foreground">
                Turn this off for a private profile that only the owner can bind.
              </span>
            </span>
          </label>
        </div>
      </CenterModal>
    </>
  );
}

function ProfileField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
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
