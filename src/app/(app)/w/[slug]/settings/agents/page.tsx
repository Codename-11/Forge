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
  MessageSquare,
  X,
} from "lucide-react";
import type { EngagementMode } from "@prisma/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Topbar } from "@/components/topbar";
import { useWorkspace } from "@/hooks/use-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { trpc } from "@/lib/trpc";

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

  function invalidate() {
    void utils.agents.bindings.list.invalidate();
  }

  const setPolicy = trpc.agents.bindings.setPolicy.useMutation({
    onSuccess: () => {
      toast.success("Policy updated.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const boundRows = bound ?? [];

  return (
    <>
      <Topbar
        title="Agent policy"
        subtitle={`Workspace · ${ws.name} · capacity, routing, engagement, and approvals.`}
        actions={
          <Link href={`/agents?workspace=${ws.id}`}>
            <Button size="sm" variant="ghost">
              <ArrowRight className="h-3.5 w-3.5" />
              Manage fleet
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
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                Workspace agent policy
                <span className="rounded border border-border/70 bg-background px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  Workspace · {ws.name}
                </span>
              </div>
              <p className="text-meta mt-0.5 text-muted-foreground">
                Profiles and bindings live in Mission Control. This page only changes how a bound
                agent works inside {ws.name}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/agents?workspace=${ws.id}`}>
                <Button size="sm" variant="outline">
                  Manage profiles & bindings
                </Button>
              </Link>
              <Link href={`/w/${ws.slug}/settings/access`}>
                <Button size="sm" variant="outline">
                  Agent access & permissions
                </Button>
              </Link>
            </div>
          </div>

          {/* Bound agents */}
          <Section
            title="Bound agents"
            hint="Policy for profiles already bound to this workspace. Binding and identity management live in Mission Control."
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
                hint="Bind a global profile from Mission Control. Workspace-specific capacity, routing, and approval controls will appear here afterward."
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
                  />
                ))}
              </Card>
            )}
          </Section>
        </div>
      </div>
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
                href={agent.profile?.id ? `/agents/${agent.profile.id}` : "/agents"}
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                open global profile →
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
