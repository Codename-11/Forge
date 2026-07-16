"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  ChevronDown,
  CircleDot,
  Clock,
  MessageSquare,
  Save,
  ShieldCheck,
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

          <AgentOperationsPolicy isAdmin={isAdmin} />
          <AgentOperationsAttention slug={ws.slug} />

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

type OperationsPolicy = {
  agentIdleTimeoutMinutes: number;
  assignmentSlaMinutes: number;
  agentRunStaleMinutes: number;
  agentProgressUpdateMinutes: number;
  agentRunQuietMinutes: number;
  reviewStartTimeoutMinutes: number;
  workSessionStaleMinutes: number;
  requiredAckSeconds: number;
  autoRedispatchOnStall: boolean;
  autoRedispatchOnNoack: boolean;
};

const EMPTY_OPERATIONS_POLICY: OperationsPolicy = {
  agentIdleTimeoutMinutes: 0,
  assignmentSlaMinutes: 0,
  agentRunStaleMinutes: 0,
  agentProgressUpdateMinutes: 5,
  agentRunQuietMinutes: 5,
  reviewStartTimeoutMinutes: 5,
  workSessionStaleMinutes: 120,
  requiredAckSeconds: 0,
  autoRedispatchOnStall: false,
  autoRedispatchOnNoack: false,
};

function AgentOperationsPolicy({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const { data: current } = trpc.workspace.current.useQuery();
  const [policy, setPolicy] = useState<OperationsPolicy>(EMPTY_OPERATIONS_POLICY);

  useEffect(() => {
    if (!current) return;
    setPolicy({
      agentIdleTimeoutMinutes: current.agentIdleTimeoutMinutes,
      assignmentSlaMinutes: current.assignmentSlaMinutes,
      agentRunStaleMinutes: current.agentRunStaleMinutes,
      agentProgressUpdateMinutes: current.agentProgressUpdateMinutes,
      agentRunQuietMinutes: current.agentRunQuietMinutes,
      reviewStartTimeoutMinutes: current.reviewStartTimeoutMinutes,
      workSessionStaleMinutes: current.workSessionStaleMinutes ?? 120,
      requiredAckSeconds: current.requiredAckSeconds,
      autoRedispatchOnStall: current.autoRedispatchOnStall,
      autoRedispatchOnNoack: current.autoRedispatchOnNoack,
    });
  }, [current]);

  const dirty = useMemo(() => {
    if (!current) return false;
    return (
      policy.agentIdleTimeoutMinutes !== current.agentIdleTimeoutMinutes ||
      policy.assignmentSlaMinutes !== current.assignmentSlaMinutes ||
      policy.agentRunStaleMinutes !== current.agentRunStaleMinutes ||
      policy.agentProgressUpdateMinutes !== current.agentProgressUpdateMinutes ||
      policy.agentRunQuietMinutes !== current.agentRunQuietMinutes ||
      policy.reviewStartTimeoutMinutes !== current.reviewStartTimeoutMinutes ||
      policy.workSessionStaleMinutes !== (current.workSessionStaleMinutes ?? 120) ||
      policy.requiredAckSeconds !== current.requiredAckSeconds ||
      policy.autoRedispatchOnStall !== current.autoRedispatchOnStall ||
      policy.autoRedispatchOnNoack !== current.autoRedispatchOnNoack
    );
  }, [current, policy]);

  const update = trpc.workspace.update.useMutation({
    onSuccess: () => {
      toast.success("Agent detection policy updated.");
      void utils.workspace.current.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const setNumber = (key: keyof OperationsPolicy, value: string) => {
    setPolicy((prior) => ({ ...prior, [key]: Math.max(0, Number(value) || 0) }));
  };

  const save = () => {
    if (!isAdmin || !dirty || update.isPending) return;
    update.mutate(policy);
  };

  return (
    <Section
      title="Activity detection & recovery"
      hint="Interpret connection signals without treating every quiet client as a failed agent."
      actions={
        <Button size="sm" onClick={save} disabled={!isAdmin || !dirty || update.isPending}>
          <Save className="h-3.5 w-3.5" />
          {update.isPending ? "Saving…" : "Save policy"}
        </Button>
      }
    >
      <Card as="div" className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <PolicyNumber
            label="Quiet after"
            hint="Early signal; no state change"
            suffix="min"
            value={policy.agentRunQuietMinutes}
            disabled={!isAdmin}
            onChange={(value) => setNumber("agentRunQuietMinutes", value)}
          />
          <PolicyNumber
            label="Progress cadence"
            hint="Expected status refresh"
            suffix="min"
            value={policy.agentProgressUpdateMinutes}
            disabled={!isAdmin}
            onChange={(value) => setNumber("agentProgressUpdateMinutes", value)}
          />
          <PolicyNumber
            label="Delivery lease"
            hint="Branch ownership timeout"
            suffix="min"
            value={policy.workSessionStaleMinutes}
            disabled={!isAdmin}
            onChange={(value) => setNumber("workSessionStaleMinutes", value)}
          />
        </div>

        <div className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="text-meta text-muted-foreground">
            <span className="font-medium text-foreground">Transport-aware recovery.</span> Managed
            runtimes may be confirmed stalled from lifecycle signals. MCP silence is shown as status
            unconfirmed and never triggers redispatch by itself.
          </div>
        </div>

        <details className="group rounded-md border border-border/70 bg-background/40">
          <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-xs font-medium">
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            Advanced detection policy
            <span className="text-meta ml-auto font-normal text-muted-foreground">
              0 disables a threshold
            </span>
          </summary>
          <div className="grid gap-3 border-t border-border/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <PolicyNumber
              label="Presence timeout"
              hint="Heartbeat connections"
              suffix="min"
              value={policy.agentIdleTimeoutMinutes}
              disabled={!isAdmin}
              onChange={(value) => setNumber("agentIdleTimeoutMinutes", value)}
            />
            <PolicyNumber
              label="Assignment SLA"
              hint="No issue movement"
              suffix="min"
              value={policy.assignmentSlaMinutes}
              disabled={!isAdmin}
              onChange={(value) => setNumber("assignmentSlaMinutes", value)}
            />
            <PolicyNumber
              label="Confirmed run stall"
              hint="Lifecycle-capable runs"
              suffix="min"
              value={policy.agentRunStaleMinutes}
              disabled={!isAdmin}
              onChange={(value) => setNumber("agentRunStaleMinutes", value)}
            />
            <PolicyNumber
              label="Review acknowledgement"
              hint="Reviewer start window"
              suffix="min"
              value={policy.reviewStartTimeoutMinutes}
              disabled={!isAdmin}
              onChange={(value) => setNumber("reviewStartTimeoutMinutes", value)}
            />
            <PolicyNumber
              label="Dispatch acknowledgement"
              hint="After assignment"
              suffix="sec"
              value={policy.requiredAckSeconds}
              disabled={!isAdmin}
              onChange={(value) => setNumber("requiredAckSeconds", value)}
            />
            <PolicyToggle
              label="Redispatch confirmed stalls"
              hint="Only when failure evidence is conclusive"
              checked={policy.autoRedispatchOnStall}
              disabled={!isAdmin}
              onChange={(checked) =>
                setPolicy((prior) => ({ ...prior, autoRedispatchOnStall: checked }))
              }
            />
            <PolicyToggle
              label="Redispatch missed acknowledgements"
              hint="After the acknowledgement window"
              checked={policy.autoRedispatchOnNoack}
              disabled={!isAdmin}
              onChange={(checked) =>
                setPolicy((prior) => ({ ...prior, autoRedispatchOnNoack: checked }))
              }
            />
          </div>
        </details>

        {!isAdmin && (
          <div className="text-meta flex items-center gap-1.5 text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" /> Workspace admin access is required to edit
            detection policy.
          </div>
        )}
      </Card>
    </Section>
  );
}

function AgentOperationsAttention({ slug }: { slug: string }) {
  const { data: sessions, isLoading } = trpc.workSession.active.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const concerns = useMemo(
    () =>
      (sessions ?? []).flatMap((session) => {
        const connection = session.ownerConnection;
        const mismatch = Boolean(
          connection?.agent && session.ownerAgent && connection.agent.id !== session.ownerAgent.id,
        );
        if (mismatch) {
          return [
            {
              session,
              label: "Attribution mismatch",
              detail: `${session.ownerAgent?.name ?? "Recorded owner"} owns delivery; ${connection?.agent.name ?? "another agent"} owns the connection.`,
              tone: "text-danger",
            },
          ];
        }
        if (connection?.status === "DISCONNECTED" || connection?.status === "REVOKED") {
          return [
            {
              session,
              label: "Connection unavailable",
              detail: `The ${connection.kind.toLowerCase().replaceAll("_", " ")} endpoint is ${connection.status.toLowerCase()}.`,
              tone: "text-danger",
            },
          ];
        }
        if (
          connection?.kind === "MCP_CLIENT" &&
          (connection.status === "QUIET" || connection.confidence === "UNCONFIRMED")
        ) {
          return [
            {
              session,
              label: "MCP status unconfirmed",
              detail: "Delivery remains owned; silence alone will not redispatch it.",
              tone: "text-warning",
            },
          ];
        }
        if (!connection && session.ownerAgent) {
          return [
            {
              session,
              label: "Legacy provenance",
              detail: "The logical agent is known, but the executing client was not registered.",
              tone: "text-muted-foreground",
            },
          ];
        }
        return [];
      }),
    [sessions],
  );

  return (
    <Section
      title="Operational attention"
      hint="Connection and ownership conditions that need an operator decision—not a generic stale alarm."
      actions={
        !isLoading ? (
          <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
            {concerns.length} concern{concerns.length === 1 ? "" : "s"}
          </span>
        ) : undefined
      }
    >
      {isLoading ? (
        <Card as="div" className="text-meta p-4 text-muted-foreground">
          Checking execution ownership…
        </Card>
      ) : concerns.length === 0 ? (
        <Card as="div" className="text-meta flex items-center gap-2 p-4 text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-success" /> No connection or delivery ownership
          concerns.
        </Card>
      ) : (
        <Card as="div" className="divide-y divide-border/60 p-0">
          {concerns.map(({ session, label, detail, tone }) => (
            <Link
              key={`${session.id}-${label}`}
              href={`/w/${slug}/issues/${session.issue.id}`}
              className="focus-ring flex items-start gap-3 px-3 py-2.5 hover:bg-subtle/50"
            >
              <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-xs font-medium">
                  <span className="text-id text-muted-foreground">
                    {session.issue.workspace.key}-{session.issue.number}
                  </span>
                  <span className="truncate">{session.issue.title}</span>
                </span>
                <span className="text-meta mt-0.5 block text-muted-foreground">
                  <span className={tone}>{label}</span> · {detail}
                </span>
              </span>
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </Card>
      )}
    </Section>
  );
}

function PolicyNumber({
  label,
  hint,
  suffix,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  suffix: string;
  value: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <PolicyField label={label} hint={hint}>
      <div className="relative">
        <Input
          type="number"
          min={0}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 pr-10 font-mono"
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[0.625rem] uppercase text-muted-foreground">
          {suffix}
        </span>
      </div>
    </PolicyField>
  );
}

function PolicyToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <PolicyField label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="focus-ring flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={
            "inline-flex h-4 w-7 items-center rounded-full transition-colors motion-reduce:transition-none " +
            (checked ? "bg-ember" : "bg-subtle")
          }
        >
          <span
            className={
              "h-3 w-3 rounded-full bg-background transition-transform motion-reduce:transition-none " +
              (checked ? "translate-x-3.5" : "translate-x-0.5")
            }
          />
        </span>
        {checked ? "Enabled" : "Off"}
      </button>
    </PolicyField>
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
