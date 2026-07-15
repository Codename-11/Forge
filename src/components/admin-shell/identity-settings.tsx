"use client";
import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Plus, Trash2, Pencil, ShieldAlert, Shield, CheckCircle2, XCircle } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CenterModal, Confirm } from "@/components/ui/modal";
import { Section } from "@/components/settings/section";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";

type SsoTypeT = "OIDC" | "GITHUB" | "GOOGLE";
const SSO_TYPES: { value: SsoTypeT; label: string; hint: string }[] = [
  { value: "OIDC", label: "OpenID Connect", hint: "Authelia, Authentik, Keycloak, Okta, Azure AD — any OIDC IdP." },
  { value: "GITHUB", label: "GitHub", hint: "GitHub OAuth app." },
  { value: "GOOGLE", label: "Google", hint: "Google OAuth client." },
];

type Draft = {
  id?: string;
  type: SsoTypeT;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowLinking: boolean;
  enabled: boolean;
};

const BLANK: Draft = {
  type: "OIDC",
  name: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "",
  allowLinking: false,
  enabled: false,
};

function originForCallback(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

export default function IdentitySettings() {
  const utils = trpc.useUtils();
  const list = trpc.sso.list.useQuery(undefined, { retry: false });

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<{ ok: boolean; msg: string } | null>(null);

  const invalidate = () => utils.sso.list.invalidate();

  const create = trpc.sso.create.useMutation({
    onSuccess: () => {
      toast.success("Provider added.");
      setModalOpen(false);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.sso.update.useMutation({
    onSuccess: () => {
      toast.success("Provider updated.");
      setModalOpen(false);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const setEnabled = trpc.sso.setEnabled.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.sso.remove.useMutation({
    onSuccess: () => {
      toast.success("Provider removed.");
      setDeleteId(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const testDiscovery = trpc.sso.testDiscovery.useMutation({
    onSuccess: (r) =>
      setDiscovery(
        r.ok
          ? { ok: true, msg: `Reachable — token endpoint ${r.tokenEndpoint}` }
          : { ok: false, msg: r.error },
      ),
    onError: (e) => setDiscovery({ ok: false, msg: e.message }),
  });

  // Instance-admin gate surfaces as a FORBIDDEN from the tRPC procedure.
  if (list.error?.data?.code === "FORBIDDEN") {
    return (
      <div className="flex h-full flex-col">
        <Topbar title="Identity & sign-in" subtitle="Instance authentication providers" />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            as="div"
            icon={ShieldAlert}
            title="Instance admin only"
            hint="Sign-in providers are global to this Forge instance. Only the instance admin (the operator set via ADMIN_EMAIL) can manage them."
          />
        </div>
      </div>
    );
  }

  const providers = list.data ?? [];
  const isOidc = draft.type === "OIDC";
  const editing = Boolean(draft.id);

  function openCreate() {
    setDraft(BLANK);
    setDiscovery(null);
    setModalOpen(true);
  }
  function openEdit(p: (typeof providers)[number]) {
    setDraft({
      id: p.id,
      type: p.type as SsoTypeT,
      name: p.name,
      issuer: p.issuer ?? "",
      clientId: p.clientId,
      clientSecret: "",
      scopes: p.scopes ?? "",
      allowLinking: p.allowLinking,
      enabled: p.enabled,
    });
    setDiscovery(null);
    setModalOpen(true);
  }

  function submit() {
    if (!draft.name.trim() || !draft.clientId.trim()) {
      toast.error("Name and client ID are required.");
      return;
    }
    if (draft.type === "OIDC" && !draft.issuer.trim()) {
      toast.error("OIDC providers need an issuer URL.");
      return;
    }
    if (editing) {
      update.mutate({
        id: draft.id!,
        name: draft.name,
        issuer: draft.issuer,
        clientId: draft.clientId,
        clientSecret: draft.clientSecret, // empty = unchanged
        scopes: draft.scopes,
        allowLinking: draft.allowLinking,
      });
    } else {
      if (!draft.clientSecret.trim()) {
        toast.error("Client secret is required.");
        return;
      }
      create.mutate({
        type: draft.type,
        name: draft.name,
        issuer: draft.issuer || undefined,
        clientId: draft.clientId,
        clientSecret: draft.clientSecret,
        scopes: draft.scopes || undefined,
        allowLinking: draft.allowLinking,
        enabled: draft.enabled,
      });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar
        title="Identity & sign-in"
        subtitle="Sign-in providers for this instance"
        actions={
          <Button size="sm" variant="ember" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" /> Add provider
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Instance-admin notice — these providers are global to the
              Forge instance, not per-workspace. */}
          <div className="flex items-start gap-3 rounded-md border border-ember/30 bg-ember/5 p-3 text-xs">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
            <div>
              <span className="font-medium text-foreground">Instance admin only.</span>{" "}
              <span className="text-muted-foreground">
                Sign-in providers are global to this Forge instance. Changes apply
                within ~30 seconds without a redeploy.
              </span>
            </div>
          </div>

          <Section
            title="Providers"
            hint="Email + password is always available. Add SSO providers below — OIDC covers any OpenID-Connect IdP, including self-hosted Authelia."
            actions={
              providers.length > 0 ? (
                <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
                  {providers.length} configured · {providers.filter((p) => p.enabled).length} enabled
                </span>
              ) : undefined
            }
          >
            {providers.length === 0 ? (
              <EmptyState
                as="div"
                icon={KeyRound}
                title="No SSO providers yet"
                hint="Add an OIDC provider to let people sign in with your identity provider."
                action={
                  <Button size="sm" variant="ember" onClick={openCreate}>
                    <Plus className="h-3.5 w-3.5" /> Add provider
                  </Button>
                }
              />
            ) : (
              <Card>
                {providers.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 p-3.5">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded bg-subtle font-mono text-xs font-semibold">
                      {p.type === "OIDC" ? p.name.slice(0, 2).toUpperCase() : p.type === "GITHUB" ? "GH" : "G"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{p.name}</span>
                        <Badge>{p.type}</Badge>
                        {p.enabled ? (
                          <Badge className="bg-success/15 text-success">enabled</Badge>
                        ) : (
                          <Badge className="text-muted-foreground">disabled</Badge>
                        )}
                        {p.allowLinking && (
                          <Badge className="bg-ember/10 text-ember">links by email</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[0.6875rem] text-muted-foreground">
                        callback: {p.callbackPath}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={p.enabled ? "subtle" : "ember"}
                      onClick={() => setEnabled.mutate({ id: p.id, enabled: !p.enabled })}
                      disabled={setEnabled.isPending}
                    >
                      {p.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(p)} aria-label="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleteId(p.id)}
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </Card>
            )}
          </Section>

          {/* Teach: what you can connect. Mirrors the SSO_TYPES catalog so
              the copy stays in sync with the create modal's type picker. */}
          <Section
            title="What you can connect"
            hint="Forge handles OIDC discovery automatically — paste the issuer and it pulls the endpoints."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {SSO_TYPES.map((t) => (
                <div key={t.value} className="rounded-lg border border-border bg-card/40 p-3">
                  <div className="text-sm font-semibold">{t.label}</div>
                  <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                    {t.hint}
                  </p>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* Add / edit modal */}
      <CenterModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={editing ? "Edit provider" : "Add sign-in provider"}
        description={
          editing
            ? "Update this provider. Leave the client secret blank to keep the stored one."
            : "Configure an SSO provider. OIDC auto-discovers endpoints from the issuer."
        }
        primaryLabel={editing ? "Save" : "Add provider"}
        onPrimary={submit}
        loading={create.isPending || update.isPending}
      >
        <div className="grid gap-4">
          {!editing && (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">Type</span>
              <select
                className="focus-ring h-9 rounded-md border border-input bg-background px-2.5 text-sm"
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as SsoTypeT })}
              >
                {SSO_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">
                {SSO_TYPES.find((t) => t.value === draft.type)?.hint}
              </span>
            </label>
          )}

          <label className="grid gap-1.5">
            <span className="text-xs font-medium">Display name</span>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={isOidc ? "Company SSO" : draft.type === "GITHUB" ? "GitHub" : "Google"}
            />
          </label>

          {isOidc && (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">Issuer URL</span>
              <div className="flex gap-2">
                <Input
                  value={draft.issuer}
                  onChange={(e) => setDraft({ ...draft, issuer: e.target.value })}
                  placeholder="https://auth.example.com"
                  className="font-mono"
                />
                <Button
                  variant="outline"
                  size="default"
                  onClick={() => draft.issuer && testDiscovery.mutate({ issuer: draft.issuer })}
                  disabled={!draft.issuer || testDiscovery.isPending}
                >
                  Test
                </Button>
              </div>
              {discovery && (
                <span
                  className={`flex items-center gap-1.5 text-xs ${discovery.ok ? "text-success" : "text-danger"}`}
                >
                  {discovery.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  {discovery.msg}
                </span>
              )}
            </label>
          )}

          <label className="grid gap-1.5">
            <span className="text-xs font-medium">Client ID</span>
            <Input
              value={draft.clientId}
              onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
              className="font-mono"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium">
              Client secret{editing && <span className="text-muted-foreground"> (leave blank to keep)</span>}
            </span>
            <Input
              type="password"
              value={draft.clientSecret}
              onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
              placeholder={editing ? "••••••••" : ""}
              className="font-mono"
            />
          </label>

          {isOidc && (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">
                Scopes <span className="text-muted-foreground">(optional)</span>
              </span>
              <Input
                value={draft.scopes}
                onChange={(e) => setDraft({ ...draft, scopes: e.target.value })}
                placeholder="openid profile email"
                className="font-mono"
              />
            </label>
          )}

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={draft.allowLinking}
              onChange={(e) => setDraft({ ...draft, allowLinking: e.target.checked })}
              className="mt-0.5 accent-ember"
            />
            <span className="text-xs">
              Link accounts by email
              <span className="block text-muted-foreground">
                Allow this provider to sign in to an existing user with the same email. Only enable
                if you trust the IdP to assert verified emails.
              </span>
            </span>
          </label>

          {!editing && (
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                className="accent-ember"
              />
              <span className="text-xs">Enable immediately</span>
            </label>
          )}

          <p className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
            After saving, add this redirect URI to your provider:{" "}
            <code className="font-mono text-foreground">
              {originForCallback(
                isOidc
                  ? "/api/auth/callback/<id>"
                  : `/api/auth/callback/${draft.type.toLowerCase()}`,
              )}
            </code>
            {isOidc && " — the exact id is shown on the provider row after it's created."}
          </p>
        </div>
      </CenterModal>

      <Confirm
        open={Boolean(deleteId)}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Remove provider?"
        description="People will no longer be able to sign in with this provider. This can't be undone."
        primaryLabel="Remove"
        variant="destructive"
        loading={remove.isPending}
        onConfirm={async () => {
          if (deleteId) await remove.mutateAsync({ id: deleteId });
        }}
      />
    </div>
  );
}
