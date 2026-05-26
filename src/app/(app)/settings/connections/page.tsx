"use client";

import { PlugZap } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Spinner, EmptyState } from "@/components/ui";
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
  const { data: connections, isLoading } = trpc.connection.list.useQuery();

  return (
    <>
      <Topbar
        title="Connections"
        subtitle="OAuth identities you've authorized. These belong to you, not a workspace — workspaces map channels, repos, and webhooks onto them."
      />
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
