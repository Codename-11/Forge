"use client";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { Topbar } from "@/components/topbar";
import { Card } from "@/components/settings/card";
import { Server, Terminal, MonitorPlay, Code2, Webhook } from "lucide-react";

const ICONS = { Server, Terminal, MonitorPlay, Code2, Webhook } as const;

export default function IntegrationsPage() {
  const ws = useWorkspace();
  const { data: adapters, isLoading } = trpc.integration.list.useQuery();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        title="Integrations"
        subtitle="Runtime adapters — connect agents and tools to Forge."
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {isLoading && (
            <div className="rounded-md border border-border bg-card/40 p-4 text-meta text-muted-foreground">
              Loading integrations…
            </div>
          )}
          {(adapters ?? []).map((a) => {
            const Icon = ICONS[a.iconKey as keyof typeof ICONS] ?? Webhook;
            return (
              <Card key={`${a.kind}-${a.presence}`} as="div">
                <div className="flex items-start gap-3 p-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-subtle/40 text-foreground/80">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{a.title}</h3>
                      <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                        {a.defaultRuntimeMode === "PERSISTENT" ? "persistent" : "session"}
                      </span>
                      {a.agents.length > 0 && (
                        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-emerald-700">
                          installed · {a.agents.length}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[0.8125rem] text-muted-foreground">{a.tagline}</p>
                    {a.agents.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {a.agents.map((ag) => (
                          <Link
                            key={ag.id}
                            href={`/w/${ws.slug}/agents/${ag.profileKey}`}
                            className="rounded-md border border-border bg-card/40 px-2 py-0.5 font-mono text-[0.625rem] text-foreground/80 hover:border-ember/40"
                          >
                            @{ag.profileKey}
                          </Link>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      <Link
                        href={`/w/${ws.slug}/settings/access?kind=${a.defaultKeyKind}`}
                        className="rounded-md border border-border bg-card/40 px-2.5 py-1 text-[0.75rem] text-foreground hover:border-ember/40"
                      >
                        {a.agents.length > 0 ? "Manage keys" : "Generate key"}
                      </Link>
                      <Link
                        href={`/w/${ws.slug}/settings/integrations/deliveries`}
                        className="text-[0.75rem] text-muted-foreground hover:text-foreground"
                      >
                        Deliveries →
                      </Link>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
