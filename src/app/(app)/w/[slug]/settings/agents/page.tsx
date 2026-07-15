"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Activity,
  ArrowRight,
  Bot,
  ChevronDown,
  CircleDot,
  Clock,
  KeyRound,
  MessageSquare,
  Plus,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { EngagementMode } from "@prisma/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Topbar } from "@/components/topbar";
import { useWorkspace } from "@/hooks/use-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { trpc } from "@/lib/trpc";
import { RequestProfileDialog } from "./request-profile-dialog";

/**
 * Workspace · Agents — the **binding** surface.
 *
 * Agent *definitions* (profile key, provider, runtime, base capabilities)
 * live globally at the account level. This page is where a workspace
 * adopts a profile and sets per-workspace policy: capacity, capability
 * overrides, auto-dispatch eligibility, engagement mode. An `Agent` row
 * IS the binding. Reads are workspace-scoped; bind / unbind / policy edits
 * are admin-gated server-side. Part of the multi-workspace restructure;
 * mirrors `WorkspaceAgentsBindingScreen` in the design handoff.
 */

const ENGAGEMENT_OPTIONS: { value: "INHERIT" | EngagementMode; label: string }[] = [
  { value: "INHERIT", label: "Inherit · workspace default" },
  { value: "EXECUTE", label: "Execute" },
  { value: "RESEARCH", label: "Research" },
  { value: "REVIEW", label: "Review" },
  { value: "DISCUSS", label: "Discuss" },
];

export default function AgentsBindingPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const isAdmin = ws.role === "OWNER" || ws.role === "ADMIN";

  const { data: bound, isLoading: boundLoading } = trpc.agents.bindings.list.useQuery();
  const { data: catalog, isLoading: catalogLoading } = trpc.agents.bindings.catalog.useQuery();

  const [unbindTarget, setUnbindTarget] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);

  function invalidate() {
    void utils.agents.bindings.list.invalidate();
    void utils.agents.bindings.catalog.invalidate();
  }

  const setPolicy = trpc.agents.bindings.setPolicy.useMutation({
    onSuccess: () => {
      toast.success("Policy updated.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bind = trpc.agents.bindings.bind.useMutation({
    onSuccess: () => {
      toast.success("Agent bound to this workspace.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const unbind = trpc.agents.bindings.unbind.useMutation({
    onSuccess: () => {
      toast.success("Agent unbound. History is preserved.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = trpc.agent.remove.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.action === "deleted"
          ? `Deleted ${res.name}.`
          : `Archived ${res.name} — it has history, so it was hidden instead of deleted.`,
      );
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const boundRows = bound ?? [];
  const catalogRows = catalog ?? [];

  return (
    <>
      <Topbar
        title="Agents"
        subtitle="Workspace bindings only: capacity, routing, engagement, and approval policy."
        actions={
          <Link href="/settings/agents">
            <Button size="sm" variant="ghost">
              <ArrowRight className="h-3.5 w-3.5" />
              Open Agent Studio
            </Button>
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3 sm:flex-row sm:items-center">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ember/10 text-ember">
              <Bot className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">Workspace binding policy</div>
              <p className="text-meta mt-0.5 text-muted-foreground">
                Identity and the primary execution runtime live in Agent Studio. This page only
                changes how an agent works inside {ws.name}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/settings/agents">
                <Button size="sm" variant="outline">
                  Agent Studio
                </Button>
              </Link>
              <Link href={`/w/${ws.slug}/settings/access`}>
                <Button size="sm" variant="outline">
                  <KeyRound className="h-3.5 w-3.5" /> Agent access
                </Button>
              </Link>
            </div>
          </div>

          {/* Bound agents */}
          <Section
            title="Bound agents"
            hint="Profiles currently configured for this workspace. Each row's controls only affect Forge."
            actions={
              boundRows.length > 0 ? (
                <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
                  {boundRows.length} bound
                </span>
              ) : undefined
            }
          >
            {!boundLoading && boundRows.length === 0 ? (
              <EmptyState
                as="div"
                icon={Bot}
                title="No agents bound yet"
                hint="Bind a globally-defined profile below to give this workspace an agent. Binding copies the definition and lets you set per-workspace policy without touching the global profile."
              />
            ) : (
              <Card as="div" className="divide-y-0">
                {boundRows.map((a, i) => (
                  <BoundAgentRow
                    key={a.id}
                    agent={a}
                    first={i === 0}
                    slug={ws.slug}
                    isAdmin={isAdmin}
                    saving={setPolicy.isPending}
                    onSavePolicy={(patch) => setPolicy.mutate({ agentId: a.id, ...patch })}
                    onUnbind={() => setUnbindTarget({ agentId: a.id, name: a.name })}
                    onDelete={() => setRemoveTarget({ agentId: a.id, name: a.name })}
                  />
                ))}
              </Card>
            )}
          </Section>

          {/* Available to bind — catalog */}
          <Section
            title="Available to bind"
            hint="Profiles you've defined globally (or that the instance admin has shared) that aren't yet bound here."
          >
            <Card as="div">
              {catalogRows.map((p, i) => (
                <div
                  key={p.id}
                  className={
                    "flex items-center gap-3 p-3 " + (i > 0 ? "border-t border-border/60" : "")
                  }
                >
                  <AgentAvatar agent={p} size="md" title={null} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[0.8125rem] font-semibold">{p.name}</span>
                      <span className="text-id text-muted-foreground">@{p.profileKey}</span>
                      {p.instanceShared && (
                        <span className="rounded border border-border/70 bg-card/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                          instance-shared
                        </span>
                      )}
                      {p.ownedByMe && (
                        <span className="rounded border border-border/70 bg-card/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                          yours
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <div className="text-meta mt-0.5 text-muted-foreground">{p.description}</div>
                    )}
                    {p.baseCapabilities.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.baseCapabilities.slice(0, 4).map((c) => (
                          <span
                            key={c}
                            className="rounded border border-border/70 bg-background px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ember"
                    disabled={!isAdmin || bind.isPending}
                    title={!isAdmin ? "Admins only." : undefined}
                    onClick={() => bind.mutate({ profileId: p.id })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Bind
                  </Button>
                </div>
              ))}
              {!catalogLoading && catalogRows.length === 0 && (
                <div className="text-meta p-6 text-center text-muted-foreground">
                  No unbound profiles available. Define a new profile globally from{" "}
                  <Link
                    href="/settings/agents"
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    your agent definitions
                  </Link>
                  , or connect an ephemeral CLI from{" "}
                  <Link
                    href={`/w/${ws.slug}/settings/access?create=session`}
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    Agent access
                  </Link>
                  .
                </div>
              )}
              {isAdmin ? (
                <Link
                  href="/settings/agents"
                  className="flex items-center gap-2 border-t border-border/60 p-3 text-[0.8125rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  Define a new profile globally
                  <span className="ml-auto rounded border border-ember/30 bg-ember/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ember">
                    requires instance admin
                  </span>
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => setRequestOpen(true)}
                  className="flex w-full items-center gap-2 border-t border-border/60 p-3 text-left text-[0.8125rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  Request a profile
                  <span className="ml-auto rounded border border-border/70 bg-card/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    needs admin approval
                  </span>
                </button>
              )}
              <Link
                href={`/w/${ws.slug}/settings/access`}
                className="flex items-center gap-2 border-t border-border/60 p-3 text-[0.8125rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
              >
                <Terminal className="h-3 w-3" />
                Connect Claude Code, Codex CLI, or a session client
                <span className="ml-auto rounded border border-border/70 bg-card/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  MCP
                </span>
              </Link>
            </Card>
          </Section>
        </div>
      </div>

      <RequestProfileDialog open={requestOpen} onOpenChange={setRequestOpen} />

      <Confirm
        open={!!unbindTarget}
        onOpenChange={(v) => !v && setUnbindTarget(null)}
        variant="destructive"
        title={`Unbind ${unbindTarget?.name}?`}
        description="The agent stops being available in this workspace. Runs, chats, and history are preserved — re-bind any time to restore it."
        primaryLabel="Unbind"
        loading={unbind.isPending}
        onConfirm={async () => {
          if (!unbindTarget) return;
          await unbind.mutateAsync({ agentId: unbindTarget.agentId });
          setUnbindTarget(null);
        }}
      />

      <Confirm
        open={!!removeTarget}
        onOpenChange={(v) => !v && setRemoveTarget(null)}
        variant="destructive"
        title={`Delete ${removeTarget?.name}?`}
        description="Permanently deletes the agent when it has no history. If it has runs, comments, keys, or past assignments, it's archived instead (hidden, history kept) — the same result as Unbind, but not reversible by re-binding once deleted."
        primaryLabel="Delete"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!removeTarget) return;
          await remove.mutateAsync({ id: removeTarget.agentId });
          setRemoveTarget(null);
        }}
      />
    </>
  );
}

/* ── A single bound agent with inline per-binding policy ────────────── */
type BoundAgent = inferRouterOutputs<AppRouter>["agents"]["bindings"]["list"][number];

function BoundAgentRow({
  agent,
  first,
  slug,
  isAdmin,
  saving,
  onSavePolicy,
  onUnbind,
  onDelete,
}: {
  agent: BoundAgent;
  first: boolean;
  slug: string;
  isAdmin: boolean;
  saving: boolean;
  onSavePolicy: (patch: {
    maxConcurrent?: number;
    autoDispatchEligible?: boolean;
    engagementMode?: EngagementMode | null;
    requireApprovalBeforeStart?: boolean;
    capabilities?: string[];
  }) => void;
  onUnbind: () => void;
  onDelete: () => void;
}) {
  // Local mirror of max-concurrent so the input is editable, committed on blur.
  const [maxConcurrent, setMaxConcurrent] = useState(String(agent.maxConcurrent));
  const [expanded, setExpanded] = useState(false);

  const baseCaps = agent.profile?.baseCapabilities ?? [];
  const activeCaps = new Set(agent.capabilities);
  const capacityLabel = agent.maxConcurrent === 0 ? "unlimited" : agent.maxConcurrent;

  function commitMax() {
    const next = Number.parseInt(maxConcurrent || "0", 10);
    if (!Number.isFinite(next) || next < 0) {
      setMaxConcurrent(String(agent.maxConcurrent));
      return;
    }
    if (next !== agent.maxConcurrent) onSavePolicy({ maxConcurrent: next });
  }

  function toggleCap(cap: string) {
    if (!isAdmin) return;
    const next = new Set(activeCaps);
    if (next.has(cap)) next.delete(cap);
    else next.add(cap);
    onSavePolicy({ capabilities: Array.from(next) });
  }

  return (
    <div className={"p-4 " + (first ? "" : "border-t border-border/60")}>
      {/* Profile row */}
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="flex min-w-0 items-start gap-3 sm:flex-1">
          <AgentAvatar agent={agent} size="md" title={null} className="h-9 w-9 text-base" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{agent.name}</span>
              <AgentPresenceDot
                status={agent.status}
                size="sm"
                lastHeartbeatAt={agent.lastHeartbeatAt}
              />
              <span className="text-id text-muted-foreground">@{agent.profileKey}</span>
              <span className="rounded border border-border/70 bg-background px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                defined globally
              </span>
            </div>
            <div className="text-meta mt-0.5 text-muted-foreground">
              {(agent.provider ?? "custom").toLowerCase()}
              {agent.runtime && (
                <>
                  {" "}
                  · runtime: <span className="font-mono">{agent.runtime.name}</span>
                </>
              )}{" "}
              ·{" "}
              <Link
                href={
                  agent.profile?.id ? `/settings/agents/${agent.profile.id}` : "/settings/agents"
                }
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                edit definition →
              </Link>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
          <Button
            size="sm"
            variant={expanded ? "outline" : "ghost"}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            Configure
            <ChevronDown
              className={"h-3.5 w-3.5 transition-transform " + (expanded ? "rotate-180" : "")}
            />
          </Button>
          <Link href={`/w/${slug}/agents/${agent.profileKey}`}>
            <Button size="sm" variant="ghost">
              <MessageSquare className="h-3.5 w-3.5" />
              Chat
            </Button>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isAdmin}
            title={
              !isAdmin ? "Admins only." : "Remove from this workspace — reversible, history kept"
            }
            onClick={onUnbind}
          >
            <X className="h-3.5 w-3.5" />
            Unbind
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isAdmin}
            title={!isAdmin ? "Admins only." : "Delete permanently if unused, otherwise archive"}
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      </header>

      {/* Per-binding policy */}
      {expanded && (
        <div className="mt-4 grid grid-cols-1 gap-4 rounded-md border border-border/70 bg-background/60 p-3 sm:grid-cols-4">
          <PolicyField label="Max concurrent" hint="0 = unlimited">
            <Input
              value={maxConcurrent}
              disabled={!isAdmin || saving}
              inputMode="numeric"
              onChange={(e) => setMaxConcurrent(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commitMax}
              className="h-8 font-mono"
            />
          </PolicyField>

          <PolicyField label="Engagement mode" hint="Override workspace default">
            <select
              value={agent.engagementMode ?? "INHERIT"}
              disabled={!isAdmin || saving}
              onChange={(e) =>
                onSavePolicy({
                  engagementMode:
                    e.target.value === "INHERIT" ? null : (e.target.value as EngagementMode),
                })
              }
              className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {ENGAGEMENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </PolicyField>

          <PolicyField label="Auto-dispatch" hint="Eligible for routing matrix">
            <div className="flex h-8 items-center">
              <button
                type="button"
                role="switch"
                aria-checked={agent.autoDispatchEligible}
                aria-label="Toggle auto-dispatch eligibility"
                disabled={!isAdmin || saving}
                onClick={() => onSavePolicy({ autoDispatchEligible: !agent.autoDispatchEligible })}
                className={
                  "focus-ring inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 " +
                  (agent.autoDispatchEligible ? "bg-ember" : "bg-subtle")
                }
              >
                <span
                  className={
                    "inline-block h-3 w-3 rounded-full bg-background transition-transform " +
                    (agent.autoDispatchEligible ? "translate-x-3.5" : "translate-x-0.5")
                  }
                />
              </button>
              <span className="ml-2 text-[0.8125rem] text-muted-foreground">
                {agent.autoDispatchEligible ? "eligible" : "manual only"}
              </span>
            </div>
          </PolicyField>

          {/* Per-binding require-approval gate. Lane B: wired to
            agents.bindings.setPolicy({ requireApprovalBeforeStart }) —
            the field rides on the binding (Agent) row from bindings.list.
            For workspace-wide / rule-level approval policy, see the
            dispatch-rules page linked under the toggle. */}
          <PolicyField label="Require approval" hint="Gate this agent before a run starts">
            <div className="flex h-8 items-center">
              <button
                type="button"
                role="switch"
                aria-checked={agent.requireApprovalBeforeStart}
                aria-label="Toggle require-approval before start"
                disabled={!isAdmin || saving}
                onClick={() =>
                  onSavePolicy({
                    requireApprovalBeforeStart: !agent.requireApprovalBeforeStart,
                  })
                }
                className={
                  "focus-ring inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 " +
                  (agent.requireApprovalBeforeStart ? "bg-ember" : "bg-subtle")
                }
              >
                <span
                  className={
                    "inline-block h-3 w-3 rounded-full bg-background transition-transform " +
                    (agent.requireApprovalBeforeStart ? "translate-x-3.5" : "translate-x-0.5")
                  }
                />
              </button>
              <span className="ml-2 text-[0.8125rem] text-muted-foreground">
                {agent.requireApprovalBeforeStart ? "approval required" : "auto-start"}
              </span>
            </div>
          </PolicyField>

          <div className="sm:col-span-4">
            <PolicyField
              label="Capabilities (override)"
              hint="Inherits from definition; toggle to add or remove for this workspace only."
            >
              <div className="flex flex-wrap items-center gap-1">
                {baseCaps.map((c) => {
                  const included = activeCaps.has(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      disabled={!isAdmin || saving}
                      onClick={() => toggleCap(c)}
                      className={
                        "text-meta inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors disabled:opacity-60 " +
                        (included
                          ? "border-ember/30 bg-ember/10 text-foreground"
                          : "border-dashed border-border bg-background text-muted-foreground line-through")
                      }
                    >
                      {c}
                    </button>
                  );
                })}
                {/* Workspace-only capabilities (not in the base set) */}
                {agent.capabilities
                  .filter((c) => !baseCaps.includes(c))
                  .map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={!isAdmin || saving}
                      onClick={() => toggleCap(c)}
                      className="text-meta inline-flex items-center gap-1 rounded-md border border-ember/30 bg-ember/10 px-1.5 py-0.5 text-foreground transition-colors disabled:opacity-60"
                      title="Workspace-only capability — click to remove"
                    >
                      {c}
                      <X className="h-2.5 w-2.5" />
                    </button>
                  ))}
                {baseCaps.length === 0 && agent.capabilities.length === 0 && (
                  <span className="text-[0.6875rem] text-muted-foreground/70">
                    No capabilities declared.
                  </span>
                )}
              </div>
            </PolicyField>
          </div>
        </div>
      )}

      {/* Live use rollup */}
      <div className="text-meta mt-3 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Activity className="h-3 w-3" /> {agent.runs24} run
          {agent.runs24 === 1 ? "" : "s"} · last 24h
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <CircleDot className="h-3 w-3" /> {agent._count?.assignedIssues ?? 0} assigned ·{" "}
          {agent.activeRuns} active
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" /> cap {capacityLabel}
        </span>
        <Link
          href={`/w/${slug}/agents/${agent.profileKey}`}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          Open in Activity →
        </Link>
      </div>
    </div>
  );
}

function PolicyField({
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
