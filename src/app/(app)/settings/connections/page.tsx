"use client";

import * as React from "react";
import { Github, PlugZap, KeyRound, RotateCw, Plus } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Spinner, EmptyState, Button, Input, QuickForm, toast } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { workspaceChipColor } from "@/components/global-shell/global-shell";

/**
 * Global connections — the user-owned external OAuth/OIDC identities
 * (GitHub login, Slack auth, an OIDC identity). Defined once at the
 * account level; workspaces map channels/repos/webhooks onto them.
 * Reads from `connection.list`. Renders inside the settings layout
 * `SettingsRail`. Part of the multi-workspace restructure.
 */

type Workspace = { id: string; slug: string; name: string; key: string };

const PROVIDER_META: Record<string, { label: string; glyph: string; color: string }> = {
  GITHUB: { label: "GitHub", glyph: "GH", color: "#24292f" },
  SLACK: { label: "Slack", glyph: "S", color: "#4A154B" },
  GOOGLE: { label: "Google", glyph: "G", color: "#4285F4" },
  OIDC: { label: "OIDC", glyph: "ID", color: "#3b6ea8" },
  CUSTOM: { label: "Custom", glyph: "•", color: "#6b7280" },
};

const PROVIDER_OPTIONS: { value: string; label: string; needsIssuer?: boolean }[] = [
  { value: "GITHUB", label: "GitHub" },
  { value: "GOOGLE", label: "Google" },
  { value: "SLACK", label: "Slack" },
  { value: "OIDC", label: "OIDC (issuer discovery)", needsIssuer: true },
  { value: "CUSTOM", label: "Custom OAuth", needsIssuer: true },
];

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

function statusStyle(status: string) {
  if (status === "CONNECTED")
    return { cls: "bg-success/10 text-success", dot: "hsl(var(--success))" };
  if (status === "DEGRADED")
    return { cls: "bg-warning/10 text-warning", dot: "hsl(var(--warning))" };
  return { cls: "bg-subtle text-muted-foreground", dot: "hsl(var(--muted-foreground))" };
}

export default function ConnectionsPage() {
  const utils = trpc.useUtils();
  const { data: connections, isLoading } = trpc.connection.list.useQuery();
  const [addOpen, setAddOpen] = React.useState(false);
  const [provider, setProvider] = React.useState("GITHUB");

  const createM = trpc.connection.create.useMutation();

  // Surface the OAuth callback result (?connection_connected / ?connection_error)
  // as a toast, then strip the query params from the URL.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const ok = url.searchParams.get("connection_connected");
    const err = url.searchParams.get("connection_error");
    if (!ok && !err) return;
    if (ok) toast({ variant: "success", title: "Connection authorized", description: ok });
    if (err) toast({ variant: "error", title: "Authorization failed", description: err });
    url.searchParams.delete("connection_connected");
    url.searchParams.delete("connection_error");
    window.history.replaceState({}, "", url.pathname + url.search);
    void utils.connection.list.invalidate();
  }, [utils]);

  /** Create the connection, then hand the browser to the authorize route. */
  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const label = String(fd.get("label") ?? "").trim();
    const clientId = String(fd.get("clientId") ?? "").trim();
    const clientSecret = String(fd.get("clientSecret") ?? "").trim();
    const issuer = String(fd.get("issuer") ?? "").trim();
    const scopesRaw = String(fd.get("scopes") ?? "").trim();
    if (!label || !clientId) return { error: "Label and client ID are required." };
    const scopes = scopesRaw ? scopesRaw.split(/[\s,]+/).filter(Boolean) : [];
    try {
      const created = await createM.mutateAsync({
        provider: provider as never,
        label,
        scopes,
        config: {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          ...(issuer ? { issuer } : {}),
        },
      });
      await utils.connection.list.invalidate();
      setAddOpen(false);
      // Kick off the live OAuth flow immediately.
      window.location.href = `/api/connections/${created.id}/authorize`;
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Could not create connection." };
    }
  }

  const needsIssuer = PROVIDER_OPTIONS.find((p) => p.value === provider)?.needsIssuer;

  return (
    <>
      <Topbar
        title="Connections"
        subtitle="OAuth identities you've authorized. These belong to you, not a workspace — workspaces map channels, repos, and webhooks onto them."
        actions={
          <div className="flex items-center gap-2">
            <a
              href="/api/connections/github/install"
              className="focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-ember px-2 text-xs font-medium text-ember-foreground hover:bg-ember/90"
            >
              <Github className="h-3.5 w-3.5" /> Install GitHub App
            </a>
            <Button size="sm" variant="subtle" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add OAuth
            </Button>
          </div>
        }
      />

      <QuickForm
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add connection"
        description="Register an OAuth/OIDC client, then authorize it. The client secret is encrypted at rest and never shown again."
        primaryLabel="Create & authorize"
        onSubmit={handleAdd}
        loading={createM.isPending}
      >
        <label className="block text-meta text-muted-foreground">
          Provider
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="focus-ring mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-meta text-muted-foreground">
          Label
          <Input name="label" placeholder="github.com/bailey" className="mt-1" autoFocus />
        </label>
        {needsIssuer && (
          <label className="block text-meta text-muted-foreground">
            Issuer URL (OIDC discovery)
            <Input name="issuer" placeholder="https://auth.example.com" className="mt-1" />
          </label>
        )}
        <label className="block text-meta text-muted-foreground">
          Client ID
          <Input name="clientId" placeholder="client id" className="mt-1 font-mono" />
        </label>
        <label className="block text-meta text-muted-foreground">
          Client secret <span className="opacity-60">(optional for public/PKCE clients)</span>
          <Input name="clientSecret" type="password" placeholder="••••••••" className="mt-1 font-mono" />
        </label>
        <label className="block text-meta text-muted-foreground">
          Scopes <span className="opacity-60">(space or comma separated)</span>
          <Input name="scopes" placeholder="openid email profile" className="mt-1 font-mono" />
        </label>
      </QuickForm>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : (connections?.length ?? 0) === 0 ? (
            <EmptyState
              variant="section"
              icon={<PlugZap />}
              title="No connections yet"
              description="Authorize an external identity (GitHub, Slack, an OIDC provider) to map into your workspaces."
            />
          ) : (
            connections!.map((cn) => {
              const meta = PROVIDER_META[cn.provider] ?? PROVIDER_META.CUSTOM;
              const st = statusStyle(cn.status);
              return (
                <div key={cn.id} className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4">
                  <header className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="inline-flex h-10 w-10 items-center justify-center rounded-md text-sm font-bold text-white"
                      style={{ background: meta.color }}
                    >
                      {meta.glyph}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{meta.label}</span>
                        {cn.account && (
                          <span className="font-mono text-[11px] text-muted-foreground">{cn.account}</span>
                        )}
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta ${st.cls}`}
                        >
                          <span
                            aria-hidden
                            style={{ width: 6, height: 6, borderRadius: 9999, background: st.dot, display: "inline-block" }}
                          />
                          {cn.status.toLowerCase()}
                        </span>
                      </div>
                      <div className="mt-0.5 text-meta text-muted-foreground">
                        {cn.label} · added {relativeTime(cn.createdAt)}
                        {cn.error && <span className="ml-2 text-warning">· {cn.error}</span>}
                      </div>
                      {cn.scopes.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {cn.scopes.map((s) => (
                            <span
                              key={s}
                              className="inline-flex items-center rounded border border-border/70 bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <a
                      href={`/api/connections/${cn.id}/authorize`}
                      className="focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-subtle px-2 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      {cn.status === "CONNECTED" ? (
                        <>
                          <RotateCw className="h-3.5 w-3.5" /> Re-authorize
                        </>
                      ) : (
                        <>
                          <KeyRound className="h-3.5 w-3.5" /> Authorize
                        </>
                      )}
                    </a>
                  </header>

                  {cn.mappings.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                      <span className="text-meta text-muted-foreground">Used in:</span>
                      {cn.mappings.map((m) => (
                        <span
                          key={m.id}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/70 px-2 py-0.5 text-meta"
                        >
                          <WsChipDense ws={m.workspace} />
                          <span className="text-muted-foreground">
                            {m.kind.toLowerCase()}
                            {m.target ? ` · ${m.target}` : ""}
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 border-t border-border/60 pt-3 text-meta italic text-muted-foreground">
                      Not used by any workspace yet — workspace admins can map this connection from their
                      settings.
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
