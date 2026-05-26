"use client";

import Link from "next/link";
import { Bot, ChevronRight, Plus, Shield } from "lucide-react";
import { Topbar } from "@/components/topbar";
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
              <span className="inline-flex items-center gap-1 rounded border border-ember/30 bg-ember/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ember">
                <Plus size={11} /> New profile
              </span>
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
    </>
  );
}
