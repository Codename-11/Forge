"use client";

import Link from "next/link";
import { Bot, Server, Settings, Sparkles, Terminal } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Spinner, EmptyState } from "@/components/ui";
import { RuntimeToolSurfaceBadges } from "@/components/runtime-tool-surface";
import { RuntimeSelfTestBadge, RuntimeSelfTestLine } from "@/components/settings/runtime-self-test";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { workspaceChipColor } from "@/components/global-shell/global-shell";

/**
 * Global runtimes — the compute hosts the user has registered (local
 * daemons, remote HTTP boxes, cloud runners). Per-host cards with the
 * bound agents and the workspaces each runtime is in use by. CPU/mem
 * telemetry isn't collected yet, so it's shown as "—". Reads from
 * `global.runtimes`. Renders inside the settings layout `SettingsRail`.
 */

type Workspace = { id: string; slug: string; name: string; key: string };

function StatusPip({ tone }: { tone: "success" | "warning" | "danger" | "muted" }) {
  const bg =
    tone === "success"
      ? "hsl(var(--success))"
      : tone === "danger"
        ? "hsl(var(--danger))"
        : tone === "warning"
          ? "hsl(var(--warning))"
          : "hsl(var(--muted-foreground))";
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 9999,
        background: bg,
        display: "inline-block",
      }}
    />
  );
}

function WsChipDense({ ws }: { ws: Workspace }) {
  return (
    <span className="text-meta inline-flex items-center gap-1">
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

export default function RuntimesPage() {
  const { data: runtimes, isLoading } = trpc.global.runtimes.useQuery();

  return (
    <>
      <Topbar
        title="Runtimes"
        subtitle="Managed compute hosts you've registered — local daemons, remote HTTP boxes, cloud runners."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6">
          <div className="text-meta flex items-center gap-3 rounded-md border border-border bg-card/40 p-3">
            <Bot size={14} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-foreground">Most runtimes auto-register.</span>
              <span className="ml-1 text-muted-foreground">
                Run{" "}
                <code className="rounded bg-subtle px-1 py-0.5 text-[10.5px]">
                  forge daemon start
                </code>{" "}
                on the host — it calls{" "}
                <code className="rounded bg-subtle px-1 py-0.5 text-[10.5px]">
                  runtimes.register
                </code>{" "}
                via MCP, then heartbeats every 60s.
              </span>
            </div>
          </div>
          <div className="text-meta flex flex-wrap items-center gap-3 rounded-md border border-ember/30 bg-ember/5 p-3">
            <Terminal size={14} className="shrink-0 text-ember" />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-foreground">
                Claude Code, Codex CLI, and one-off MCP sessions live under Agent access.
              </span>
              <span className="ml-1 text-muted-foreground">
                Runtime hosts are for managed compute that Forge dials or monitors.
              </span>
            </div>
            <Link
              href="/settings/access"
              className="focus-ring inline-flex h-7 items-center justify-center rounded-md border border-border bg-card/60 px-2 text-xs font-medium text-foreground hover:bg-subtle"
            >
              Open Agent access
            </Link>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : (runtimes?.length ?? 0) === 0 ? (
            <EmptyState
              variant="section"
              icon={<Server />}
              title="No runtimes registered"
              description="Run `forge daemon start` on a host to register your first runtime."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {runtimes!.map((r) => {
                const Ico = r.kind === "CLOUD" ? Sparkles : r.kind === "REMOTE_HTTP" ? Server : Bot;
                const tone =
                  r.health.kind === "online"
                    ? "border-success/30 bg-success/5"
                    : r.health.tone === "danger"
                      ? "border-danger/30 bg-danger/5"
                      : r.health.tone === "warning"
                        ? "border-warning/30 bg-warning/5"
                        : "border-border bg-card/40";
                // Runtime detail authorization is currently home-workspace
                // scoped. Until a canonical global detail exists, always use
                // that authoritative workspace rather than an arbitrary
                // workspace where the runtime happened to run.
                const settingsWorkspace = r.homeWorkspace;
                return (
                  <div key={r.id} className={`flex flex-col gap-3 rounded-lg border p-4 ${tone}`}>
                    <header className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background"
                      >
                        <Ico size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{r.name}</span>
                          <StatusPip tone={r.health.tone} />
                          <span className="text-meta text-muted-foreground">{r.health.label}</span>
                          <RuntimeSelfTestBadge selfTest={r.selfTest} />
                        </div>
                        {r.endpoint && (
                          <div className="text-meta truncate text-muted-foreground">
                            {r.endpoint}
                          </div>
                        )}
                      </div>
                      {settingsWorkspace && (
                        <Link
                          href={`/w/${settingsWorkspace.slug}/settings/runtimes/${r.id}`}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
                          title="Open runtime settings"
                          aria-label={`Open settings for ${r.name}`}
                        >
                          <Settings size={14} />
                        </Link>
                      )}
                    </header>

                    <div className="text-meta grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-muted-foreground">Last signal</div>
                        <div className="mt-0.5">{r.health.lastSignal}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Probe / sweep</div>
                        <div className="mt-0.5">{r.health.sweepExpectation}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Adapter</div>
                        <div className="mt-0.5 font-mono text-[11px]">{r.health.adapter}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Self-test</div>
                        <div className="mt-0.5">
                          <RuntimeSelfTestLine selfTest={r.selfTest} />
                        </div>
                      </div>
                    </div>
                    <div className="text-meta rounded-md border border-border/60 bg-background/40 px-2.5 py-2 text-muted-foreground">
                      {r.health.reason}
                    </div>
                    <RuntimeToolSurfaceBadges
                      adapterKey={r.adapterKey}
                      config={r.config}
                      configStatus={r.configStatus}
                    />

                    {/* Bound agents + workspaces */}
                    <div className="flex items-start gap-2 border-t border-border/60 pt-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-meta text-muted-foreground">Bound agents</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.boundAgents.length === 0 ? (
                            <span className="text-meta italic text-muted-foreground">none</span>
                          ) : (
                            r.boundAgents.map((p) => (
                              <span
                                key={p.id}
                                className="text-meta inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5"
                              >
                                <span className="font-mono text-[10px]">@{p.profileKey}</span>
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-meta text-right text-muted-foreground">In use by</div>
                        <div className="mt-1 flex flex-wrap justify-end gap-1">
                          {r.workspacesInUse.length === 0 ? (
                            <span className="text-meta italic text-muted-foreground">—</span>
                          ) : (
                            r.workspacesInUse.map((ws) => <WsChipDense key={ws.id} ws={ws} />)
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="text-meta border-t border-border/60 pt-2 text-muted-foreground">
                      Registered {relativeTime(r.registeredAt)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="text-meta text-muted-foreground">
            Runtimes are global to your account, not a workspace concern.{" "}
            <Link href="/settings/agents" className="underline hover:text-foreground">
              Bind agents
            </Link>{" "}
            to put them to work.
          </div>
        </div>
      </div>
    </>
  );
}
