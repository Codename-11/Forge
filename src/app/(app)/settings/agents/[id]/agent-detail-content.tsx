"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Server } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Spinner, EmptyState, Section } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { workspaceChipColor } from "@/components/global-shell/global-shell";

/**
 * Client body for the agent profile detail page. Reads
 * `agents.profiles.get({ id })`.
 */

function StatusPip({ status }: { status?: string | null }) {
  const c =
    status === "ONLINE"
      ? "hsl(var(--success))"
      : status === "BUSY"
        ? "hsl(var(--ember))"
        : status === "IDLE"
          ? "hsl(var(--warning))"
          : "hsl(var(--muted-foreground))";
  return (
    <span
      aria-hidden
      style={{ width: 6, height: 6, borderRadius: 9999, background: c, display: "inline-block" }}
    />
  );
}

function WsChipDense({ ws }: { ws: { slug: string; key: string } }) {
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

function Def({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

export function AgentDetailContent({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const { data: a, isLoading, error } = trpc.agents.profiles.get.useQuery({ id });
  const updateProfile = trpc.agents.profiles.update.useMutation({
    onSuccess: async () => {
      toast.success("Agent prompt saved");
      setPromptDraft(null);
      await utils.agents.profiles.get.invalidate({ id });
      await utils.agents.profiles.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <>
        <Topbar title="Agent" />
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </>
    );
  }

  if (error || !a) {
    return (
      <>
        <Topbar title="Agent" />
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <EmptyState
            variant="section"
            title="Profile not found"
            description={error?.message ?? "This profile doesn't exist or you don't have access."}
            action={
              <Link
                href="/settings/agents"
                className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-subtle"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to agents
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const template = a.templateMarkdown ?? "";
  const editingPrompt = promptDraft !== null;
  const promptValue = promptDraft ?? template;
  const effectiveSystemPrompt =
    `You are ${a.name}. You're chatting with the operator inside Forge, a project ` +
    `management workspace. Be concise and direct. ` +
    (a.baseCapabilities.length > 0
      ? `Your capabilities: ${a.baseCapabilities.join(", ")}.\n\n`
      : "") +
    (template ? `${template}\n` : "");

  return (
    <>
      <Topbar
        title={
          <span className="inline-flex items-center gap-2">
            <span className="text-xl">{a.avatar ?? "🤖"}</span>
            <span>{a.name}</span>
            <StatusPip
              status={
                a.bindings.some((b) => b.status === "ONLINE" || b.status === "BUSY")
                  ? "ONLINE"
                  : "OFFLINE"
              }
            />
            <span className="font-mono text-sm text-muted-foreground">@{a.profileKey}</span>
          </span>
        }
        subtitle={
          a.description ??
          "Identity-level agent profile — applies in every workspace you bind it to."
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <div>
            <Link
              href="/settings/agents"
              className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.75rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> All agents
            </Link>
          </div>

          {/* Definition */}
          <Section title="Definition" hint="Identity-level — applies in every workspace.">
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card/40 p-4">
              <Def label="Profile key">
                <span className="font-mono">@{a.profileKey}</span>
              </Def>
              <Def label="Provider">
                <span>{a.provider}</span>
                {a.runEngine && (
                  <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                    {a.runEngine}
                  </span>
                )}
              </Def>
              <Def label="Runtime">
                {a.runtime ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Server size={11} className="text-muted-foreground" />
                    {a.runtime.name}
                    <span className="text-[11px] text-muted-foreground">
                      ({a.runtime.kind.toLowerCase().replace("_", " ")})
                    </span>
                  </span>
                ) : (
                  <span className="italic text-muted-foreground">unassigned</span>
                )}
              </Def>
              <Def label="Sharing">
                {a.instanceShared ? (
                  <span className="text-success">Shared with the whole instance</span>
                ) : (
                  <span className="text-muted-foreground">Private to you</span>
                )}
              </Def>
              <div className="col-span-2">
                <div className="text-meta text-muted-foreground">Base capabilities</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {a.baseCapabilities.length === 0 ? (
                    <span className="text-meta italic text-muted-foreground">none</span>
                  ) : (
                    a.baseCapabilities.map((c) => (
                      <span
                        key={c}
                        className="text-meta inline-flex items-center rounded-md border border-border bg-background px-1.5 py-0.5"
                      >
                        {c}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          </Section>

          <Section
            title="Prompt & system context"
            hint="Profile-level prompt used by chat and active workspace bindings."
          >
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">Template markdown</div>
                  <div className="text-meta text-muted-foreground">
                    {a.bindings.length} active binding{a.bindings.length === 1 ? "" : "s"}
                  </div>
                </div>
                {a.canEdit && (
                  <div className="flex items-center gap-1.5">
                    {editingPrompt ? (
                      <>
                        <button
                          type="button"
                          className="focus-ring h-7 rounded-md border border-border px-2 text-[0.75rem] hover:bg-subtle"
                          disabled={updateProfile.isPending}
                          onClick={() => setPromptDraft(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="focus-ring h-7 rounded-md bg-ember px-2 text-[0.75rem] font-medium text-ember-foreground disabled:opacity-60"
                          disabled={updateProfile.isPending}
                          onClick={() =>
                            updateProfile.mutate({
                              id: a.id,
                              templateMarkdown: promptValue.trim() ? promptValue : null,
                            })
                          }
                        >
                          {updateProfile.isPending ? "Saving..." : "Save"}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="focus-ring h-7 rounded-md border border-border px-2 text-[0.75rem] hover:bg-subtle"
                        onClick={() => setPromptDraft(template)}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                )}
              </div>

              {editingPrompt ? (
                <textarea
                  value={promptValue}
                  onChange={(event) => setPromptDraft(event.target.value)}
                  className="min-h-44 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-[0.75rem] leading-relaxed outline-none focus:border-ember"
                  spellCheck={false}
                />
              ) : template ? (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/70 p-3 font-mono text-[0.75rem] leading-relaxed">
                  {template}
                </pre>
              ) : (
                <div className="text-meta rounded-md border border-dashed border-border bg-background/40 p-3 text-muted-foreground">
                  No profile template configured.
                </div>
              )}

              <div className="rounded-md border border-border/70 bg-background/60 p-3">
                <div className="text-meta mb-1 text-muted-foreground">
                  Effective chat system prompt preview
                </div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[0.6875rem] leading-relaxed text-foreground/85">
                  {effectiveSystemPrompt}
                </pre>
              </div>
            </div>
          </Section>

          {/* Workspace bindings */}
          <Section
            title="Workspace bindings"
            hint="Per-workspace policy: capacity, capability override, auto-dispatch eligibility."
          >
            <div className="overflow-hidden rounded-lg border border-border bg-card/40">
              <div className="text-meta grid grid-cols-[1.4fr_0.6fr_0.7fr_1.2fr_0.6fr] items-center gap-2 border-b border-border bg-subtle/40 px-3 py-2 text-muted-foreground">
                <span>Workspace</span>
                <span>Status</span>
                <span className="text-right">Max concurrent</span>
                <span>Capabilities</span>
                <span className="text-right">Auto-dispatch</span>
              </div>
              {a.bindings.length === 0 ? (
                <EmptyState
                  variant="card"
                  title="Not bound to any workspace"
                  description="Bind this profile from a workspace's agent settings."
                />
              ) : (
                a.bindings.map((b) => (
                  <div
                    key={b.id}
                    className="grid grid-cols-[1.4fr_0.6fr_0.7fr_1.2fr_0.6fr] items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0"
                  >
                    <Link
                      href={`/w/${b.workspace.slug}`}
                      className="flex min-w-0 items-center gap-2 hover:text-ember"
                    >
                      <span
                        aria-hidden
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[11px] font-bold text-white"
                        style={{ background: workspaceChipColor(b.workspace.key) }}
                      >
                        {b.workspace.key[0]}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[0.8125rem] font-medium">
                          {b.workspace.name}
                        </span>
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          {b.workspace.key}
                        </span>
                      </span>
                    </Link>
                    <span className="inline-flex items-center gap-1.5 text-[0.8125rem]">
                      <StatusPip status={b.status} />
                      {b.status.toLowerCase()}
                    </span>
                    <span className="text-right font-mono text-[0.8125rem] tabular-nums">
                      {b.maxConcurrent}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {b.capabilities.length === 0 ? (
                        <span className="text-[10px] italic text-muted-foreground">
                          inherits base
                        </span>
                      ) : (
                        b.capabilities.map((c) => (
                          <span
                            key={c}
                            className="rounded border border-border bg-background px-1 text-[10px]"
                          >
                            {c}
                          </span>
                        ))
                      )}
                    </span>
                    <span className="text-right text-[0.8125rem]">
                      {b.autoDispatchEligible ? (
                        <span className="text-success">on</span>
                      ) : (
                        <span className="text-muted-foreground">off</span>
                      )}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Section>

          {/* Recent runs */}
          <Section title="Recent runs" hint="Across all workspaces — most recent first.">
            <div className="rounded-lg border border-border bg-card/40 p-2">
              {a.recentRuns.length === 0 ? (
                <EmptyState variant="card" title="No runs yet" />
              ) : (
                <div className="flex flex-col gap-1">
                  {a.recentRuns.map((r) => (
                    <div key={r.id} className="text-meta flex items-center gap-2 px-1.5 py-1">
                      <WsChipDense ws={r.workspace} />
                      <span className="inline-flex items-center gap-1.5">
                        <StatusPip status={r.status === "ACTIVE" ? "BUSY" : r.status} />
                        <span className="text-foreground/80">{r.status.toLowerCase()}</span>
                      </span>
                      {r.issue && (
                        <span className="font-mono text-muted-foreground/90">
                          #{r.issue.number}
                        </span>
                      )}
                      <span className="flex-1 truncate text-muted-foreground">
                        {r.currentStep ?? r.issue?.title ?? ""}
                      </span>
                      <span className="tabular-nums text-muted-foreground/70">
                        {relativeTime(r.startedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
