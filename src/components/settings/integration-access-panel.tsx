"use client";

import { useMemo, useState } from "react";
import {
  IntegrationCapability,
  IntegrationCredentialSource,
  IntegrationGrantScope,
  IntegrationPrincipalType,
} from "@prisma/client";
import { KeyRound, LockKeyhole, Plus, ShieldCheck, UserRoundCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { EmptyState, Section } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { trpc } from "@/lib/trpc";

const CAPABILITY_COPY: Record<IntegrationCapability, { label: string; description: string }> = {
  READ: { label: "View external data", description: "Read provider records and metadata." },
  IMPORT: { label: "Import into Forge", description: "Create Forge work from external records." },
  LINK: { label: "Link records", description: "Attach external records to Forge issues." },
  SYNC: { label: "Keep in sync", description: "Reconcile linked records automatically." },
  WRITE: { label: "Write back externally", description: "Change data in the external service." },
  ADMIN: {
    label: "Manage integration",
    description: "Manage Forge mappings and reconciliation in this scope—not the provider account.",
  },
};

const CAPABILITIES = Object.values(IntegrationCapability);
const SAFE_DEFAULTS = [
  IntegrationCapability.READ,
  IntegrationCapability.LINK,
  IntegrationCapability.SYNC,
];

export function IntegrationAccessPanel({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const authorizationQuery = trpc.integrationGrant.list.useQuery(undefined, { enabled: isAdmin });
  const memberQuery = trpc.workspace.listMembers.useQuery(undefined, { enabled: isAdmin });
  const agentQuery = trpc.agent.list.useQuery({ includeArchived: false }, { enabled: isAdmin });
  const keyQuery = trpc.access.list.useQuery(undefined, { enabled: isAdmin });
  const projectQuery = trpc.project.list.useQuery(
    { archived: false, limit: 100 },
    { enabled: isAdmin },
  );
  const meQuery = trpc.workspace.me.useQuery(undefined, { enabled: isAdmin });

  const [authorizeTarget, setAuthorizeTarget] = useState<{
    mappingId: string;
    label: string;
  } | null>(null);
  const [authorizeCapabilities, setAuthorizeCapabilities] = useState<IntegrationCapability[]>([
    ...SAFE_DEFAULTS,
  ]);
  const [grantTarget, setGrantTarget] = useState<{
    authorizationId: string;
    label: string;
    ceiling: IntegrationCapability[];
  } | null>(null);
  const [principalType, setPrincipalType] = useState<IntegrationPrincipalType>(
    IntegrationPrincipalType.USER,
  );
  const [principalId, setPrincipalId] = useState("");
  const [scope, setScope] = useState<IntegrationGrantScope>(IntegrationGrantScope.PROJECT);
  const [projectId, setProjectId] = useState("");
  const [grantCapabilities, setGrantCapabilities] = useState<IntegrationCapability[]>([
    IntegrationCapability.READ,
  ]);
  const [revokeAuthorizationTarget, setRevokeAuthorizationTarget] = useState<{
    id: string;
    label: string;
    activeGrantCount: number;
  } | null>(null);
  const [revokeGrantTarget, setRevokeGrantTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const invalidate = () => utils.integrationGrant.list.invalidate();
  const authorize = trpc.integrationGrant.authorize.useMutation({
    onSuccess: async () => {
      toast.success("Credential use authorized.");
      await invalidate();
      setAuthorizeTarget(null);
    },
  });
  const revokeAuthorization = trpc.integrationGrant.revokeAuthorization.useMutation({
    onSuccess: async () => {
      toast.success("Authorization revoked and mapping paused.");
      await invalidate();
      setRevokeAuthorizationTarget(null);
    },
  });
  const upsertGrant = trpc.integrationGrant.upsertGrant.useMutation({
    onSuccess: async () => {
      toast.success("Integration access granted.");
      await invalidate();
      resetGrant();
    },
  });
  const revokeGrant = trpc.integrationGrant.revokeGrant.useMutation({
    onSuccess: async () => {
      toast.success("Integration access revoked.");
      await invalidate();
      setRevokeGrantTarget(null);
    },
  });

  const memberByUserId = useMemo(
    () => new Map((memberQuery.data ?? []).map((member) => [member.userId, member])),
    [memberQuery.data],
  );
  const agentById = useMemo(
    () => new Map((agentQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentQuery.data],
  );
  const keyById = useMemo(
    () => new Map((keyQuery.data ?? []).map((key) => [key.id, key])),
    [keyQuery.data],
  );
  const projectById = useMemo(
    () => new Map((projectQuery.data?.items ?? []).map((project) => [project.id, project])),
    [projectQuery.data],
  );

  function resetGrant() {
    setGrantTarget(null);
    setPrincipalType(IntegrationPrincipalType.USER);
    setPrincipalId("");
    setScope(IntegrationGrantScope.PROJECT);
    setProjectId("");
    setGrantCapabilities([IntegrationCapability.READ]);
  }

  if (!isAdmin) return null;

  const authorizations = authorizationQuery.data ?? [];
  return (
    <>
      <Section
        title="Credential access"
        hint="Credential-owner consent sets the ceiling. Workspace grants decide who can use it and where."
      >
        {authorizationQuery.isLoading ? (
          <Card as="div">
            <div className="p-4 text-sm text-muted-foreground">Loading credential access…</div>
          </Card>
        ) : authorizations.length === 0 ? (
          <EmptyState
            as="div"
            icon={<KeyRound />}
            title="No credential authorizations"
            description="Add a mapping first, then its credential owner can authorize how Forge may use it."
          />
        ) : (
          <div className="space-y-3">
            {authorizations.map((authorization) => {
              const mapping = authorization.connectionMapping;
              const connection = mapping.connection;
              const active = !authorization.revokedAt;
              const activeGrants = authorization.grants.filter((grant) => !grant.revokedAt);
              const isCredentialOwner = connection.ownerId === meQuery.data?.user.id;
              const label = `${connection.provider} · ${mapping.target}`;
              return (
                <Card key={authorization.id} as="div" className="overflow-visible">
                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
                        active ? "bg-success/10 text-success" : "bg-subtle text-muted-foreground"
                      }`}
                    >
                      {active ? (
                        <ShieldCheck className="h-4 w-4" aria-hidden />
                      ) : (
                        <LockKeyhole className="h-4 w-4" aria-hidden />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{label}</span>
                        <Badge>{active ? "authorized" : "revoked"}</Badge>
                        {isCredentialOwner && <Badge>your credential</Badge>}
                      </div>
                      <p className="text-meta mt-1 text-muted-foreground">
                        {authorization.credentialSource === "USER_CONNECTION"
                          ? "Personal connection"
                          : `Workspace GitHub App${authorization.githubApp?.name ? ` · ${authorization.githubApp.name}` : ""}`}
                        {` · ${mapping.direction} · ${mapping.status}`}
                      </p>
                      <CapabilityChips capabilities={authorization.capabilities} />
                    </div>
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      {active ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setGrantTarget({
                                authorizationId: authorization.id,
                                label,
                                ceiling: authorization.capabilities,
                              });
                              setGrantCapabilities(
                                authorization.capabilities.includes(IntegrationCapability.READ)
                                  ? [IntegrationCapability.READ]
                                  : [authorization.capabilities[0]],
                              );
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden /> Add grant
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setRevokeAuthorizationTarget({
                                id: authorization.id,
                                label,
                                activeGrantCount: activeGrants.length,
                              })
                            }
                          >
                            Revoke consent
                          </Button>
                        </>
                      ) : (
                        isCredentialOwner && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setAuthorizeTarget({ mappingId: mapping.id, label });
                              setAuthorizeCapabilities([...SAFE_DEFAULTS]);
                            }}
                          >
                            Re-authorize
                          </Button>
                        )
                      )}
                    </div>
                  </div>

                  {active && (
                    <div className="border-t border-border/60">
                      {activeGrants.length === 0 ? (
                        <div className="text-meta p-4 text-muted-foreground">
                          Authorized, but no person, agent, key, or automation can use it yet.
                        </div>
                      ) : (
                        activeGrants.map((grant) => {
                          const principal = principalLabel(grant, {
                            memberByUserId,
                            agentById,
                            keyById,
                          });
                          const scopeLabel =
                            grant.scope === "PROJECT"
                              ? `Project · ${projectById.get(grant.projectId ?? "")?.name ?? "Unavailable project"}`
                              : "Entire workspace";
                          return (
                            <div
                              key={grant.id}
                              className="flex flex-col gap-2 border-b border-border/60 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center"
                            >
                              <UserRoundCheck
                                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                aria-hidden
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{principal}</div>
                                <div className="text-meta text-muted-foreground">{scopeLabel}</div>
                              </div>
                              <CapabilityChips capabilities={grant.capabilities} compact />
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setRevokeGrantTarget({ id: grant.id, label: principal })
                                }
                              >
                                Remove
                              </Button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <QuickForm
        open={authorizeTarget !== null}
        onOpenChange={(open) => !open && setAuthorizeTarget(null)}
        title="Authorize credential use"
        description={authorizeTarget?.label}
        primaryLabel="Authorize"
        loading={authorize.isPending}
        onSubmit={async () => {
          if (!authorizeTarget) return;
          if (authorizeCapabilities.length === 0)
            return { error: "Choose at least one capability." };
          try {
            await authorize.mutateAsync({
              mappingId: authorizeTarget.mappingId,
              credentialSource: IntegrationCredentialSource.USER_CONNECTION,
              capabilities: authorizeCapabilities,
            });
          } catch (error) {
            return { error: error instanceof Error ? error.message : "Could not authorize." };
          }
        }}
      >
        <CapabilityPicker
          value={authorizeCapabilities}
          onChange={setAuthorizeCapabilities}
          available={CAPABILITIES}
        />
        <ImpactWarning capabilities={authorizeCapabilities} />
      </QuickForm>

      <QuickForm
        open={grantTarget !== null}
        onOpenChange={(open) => !open && resetGrant()}
        title="Grant integration access"
        description={grantTarget?.label}
        primaryLabel="Grant access"
        loading={upsertGrant.isPending}
        onSubmit={async () => {
          if (!grantTarget) return;
          if (principalType !== IntegrationPrincipalType.WORKSPACE_AUTOMATION && !principalId)
            return { error: "Choose who receives access." };
          if (scope === IntegrationGrantScope.PROJECT && !projectId)
            return { error: "Choose a project." };
          if (grantCapabilities.length === 0) return { error: "Choose at least one capability." };
          const principal =
            principalType === IntegrationPrincipalType.USER
              ? { type: principalType, userId: principalId }
              : principalType === IntegrationPrincipalType.AGENT
                ? { type: principalType, agentId: principalId }
                : principalType === IntegrationPrincipalType.API_KEY
                  ? { type: principalType, apiKeyId: principalId }
                  : { type: principalType };
          try {
            await upsertGrant.mutateAsync({
              connectionAuthorizationId: grantTarget.authorizationId,
              principal,
              scope,
              projectId: scope === IntegrationGrantScope.PROJECT ? projectId : null,
              capabilities: grantCapabilities,
            });
          } catch (error) {
            return { error: error instanceof Error ? error.message : "Could not grant access." };
          }
        }}
      >
        <QuickForm.Field label="Principal type">
          <Combobox
            ariaLabel="Principal type"
            value={principalType}
            onChange={(value) => {
              if (!value) return;
              setPrincipalType(value as IntegrationPrincipalType);
              setPrincipalId("");
            }}
            options={[
              { value: "USER", label: "Workspace member" },
              { value: "AGENT", label: "Agent" },
              { value: "API_KEY", label: "API key" },
              { value: "WORKSPACE_AUTOMATION", label: "Workspace automation" },
            ]}
          />
        </QuickForm.Field>
        {principalType !== IntegrationPrincipalType.WORKSPACE_AUTOMATION && (
          <QuickForm.Field label="Principal" required>
            <Combobox
              ariaLabel="Principal"
              value={principalId || null}
              placeholder="Choose…"
              onChange={(value) => setPrincipalId(value ?? "")}
              options={principalOptions(principalType, {
                members: memberQuery.data ?? [],
                agents: agentQuery.data ?? [],
                keys: keyQuery.data ?? [],
              })}
            />
          </QuickForm.Field>
        )}
        <QuickForm.Field label="Scope">
          <div
            role="radiogroup"
            aria-label="Integration grant scope"
            className="grid grid-cols-2 gap-2"
          >
            {[IntegrationGrantScope.WORKSPACE, IntegrationGrantScope.PROJECT].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                onClick={() => setScope(value)}
                className={`focus-ring rounded-md border px-3 py-2 text-left text-sm ${
                  scope === value ? "border-ember bg-ember/5" : "border-border bg-card/40"
                }`}
              >
                {value === "WORKSPACE" ? "Entire workspace" : "One project"}
              </button>
            ))}
          </div>
        </QuickForm.Field>
        {scope === IntegrationGrantScope.PROJECT && (
          <QuickForm.Field label="Project" required>
            <Combobox
              ariaLabel="Project"
              value={projectId || null}
              placeholder="Choose a project…"
              onChange={(value) => setProjectId(value ?? "")}
              options={(projectQuery.data?.items ?? []).map((project) => ({
                value: project.id,
                label: `${project.key} · ${project.name}`,
              }))}
            />
          </QuickForm.Field>
        )}
        <CapabilityPicker
          value={grantCapabilities}
          onChange={setGrantCapabilities}
          available={grantTarget?.ceiling ?? []}
        />
        <ImpactWarning capabilities={grantCapabilities} />
      </QuickForm>

      <Confirm
        open={revokeAuthorizationTarget !== null}
        onOpenChange={(open) => !open && setRevokeAuthorizationTarget(null)}
        title="Revoke credential consent?"
        description={`${revokeAuthorizationTarget?.label ?? "This mapping"} will be paused and ${revokeAuthorizationTarget?.activeGrantCount ?? 0} active grant${revokeAuthorizationTarget?.activeGrantCount === 1 ? "" : "s"} will stop working. The underlying account and credential are not deleted.`}
        primaryLabel="Revoke consent"
        loading={revokeAuthorization.isPending}
        onConfirm={async () => {
          if (!revokeAuthorizationTarget) return;
          await revokeAuthorization.mutateAsync({ id: revokeAuthorizationTarget.id });
        }}
      />
      <Confirm
        open={revokeGrantTarget !== null}
        onOpenChange={(open) => !open && setRevokeGrantTarget(null)}
        title={`Remove access for ${revokeGrantTarget?.label ?? "this principal"}?`}
        description="This principal can no longer use the credential in this scope. The mapping and underlying account remain intact."
        primaryLabel="Remove access"
        loading={revokeGrant.isPending}
        onConfirm={async () => {
          if (!revokeGrantTarget) return;
          await revokeGrant.mutateAsync({ id: revokeGrantTarget.id });
        }}
      />
    </>
  );
}

function CapabilityPicker({
  value,
  onChange,
  available,
}: {
  value: IntegrationCapability[];
  onChange: (value: IntegrationCapability[]) => void;
  available: IntegrationCapability[];
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs text-muted-foreground">Capabilities</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {available.map((capability) => {
          const checked = value.includes(capability);
          return (
            <label
              key={capability}
              className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 ${
                checked ? "border-ember bg-ember/5" : "border-border bg-card/40"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  onChange(
                    checked ? value.filter((item) => item !== capability) : [...value, capability],
                  )
                }
                className="mt-0.5 accent-ember"
              />
              <span>
                <span className="block text-xs font-medium">
                  {CAPABILITY_COPY[capability].label}
                </span>
                <span className="text-meta mt-0.5 block leading-relaxed text-muted-foreground">
                  {CAPABILITY_COPY[capability].description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function CapabilityChips({
  capabilities,
  compact = false,
}: {
  capabilities: IntegrationCapability[];
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap gap-1 ${compact ? "" : "mt-2"}`}
      aria-label="Granted capabilities"
    >
      {capabilities.map((capability) => (
        <Badge key={capability}>{CAPABILITY_COPY[capability].label}</Badge>
      ))}
    </div>
  );
}

function ImpactWarning({ capabilities }: { capabilities: IntegrationCapability[] }) {
  if (
    !capabilities.includes(IntegrationCapability.WRITE) &&
    !capabilities.includes(IntegrationCapability.ADMIN)
  )
    return null;
  return (
    <div
      className="rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs leading-relaxed text-foreground"
      role="status"
    >
      This access can{" "}
      {capabilities.includes(IntegrationCapability.WRITE)
        ? "change external data"
        : "manage Forge integration settings"}
      . Review the principal and scope before continuing.
    </div>
  );
}

function principalOptions(
  type: IntegrationPrincipalType,
  data: {
    members: Array<{ userId: string; name: string | null; email: string }>;
    agents: Array<{ id: string; name: string; profileKey: string }>;
    keys: Array<{ id: string; name: string; prefix: string; revokedAt: Date | string | null }>;
  },
) {
  if (type === IntegrationPrincipalType.USER)
    return data.members.map((member) => ({
      value: member.userId,
      label: member.name || member.email,
    }));
  if (type === IntegrationPrincipalType.AGENT)
    return data.agents.map((agent) => ({
      value: agent.id,
      label: `${agent.name} · @${agent.profileKey}`,
    }));
  if (type === IntegrationPrincipalType.API_KEY)
    return data.keys
      .filter((key) => !key.revokedAt)
      .map((key) => ({ value: key.id, label: `${key.name} · ${key.prefix}…` }));
  return [];
}

function principalLabel(
  grant: {
    principalType: IntegrationPrincipalType;
    principalUserId: string | null;
    principalAgentId: string | null;
    principalApiKeyId: string | null;
  },
  lookups: {
    memberByUserId: Map<string, { name: string | null; email: string }>;
    agentById: Map<string, { name: string; profileKey: string }>;
    keyById: Map<string, { name: string; prefix: string }>;
  },
) {
  if (grant.principalType === IntegrationPrincipalType.WORKSPACE_AUTOMATION)
    return "Workspace automation";
  if (grant.principalType === IntegrationPrincipalType.USER) {
    const member = lookups.memberByUserId.get(grant.principalUserId ?? "");
    return member?.name || member?.email || "Unavailable member";
  }
  if (grant.principalType === IntegrationPrincipalType.AGENT) {
    const agent = lookups.agentById.get(grant.principalAgentId ?? "");
    return agent ? `${agent.name} · @${agent.profileKey}` : "Unavailable agent";
  }
  const key = lookups.keyById.get(grant.principalApiKeyId ?? "");
  return key ? `${key.name} · ${key.prefix}…` : "Unavailable API key";
}
