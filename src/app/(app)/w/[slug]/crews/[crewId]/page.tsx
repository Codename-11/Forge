"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Archive,
  Check,
  ChevronLeft,
  Pencil,
  Plus,
  Target,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import {
  CREW_ROLES,
  roleBreakdown,
  roleLabel,
  type CrewRole,
} from "@/components/crews/role-chip";
import {
  GOAL_STATUS_TONE,
  isGoalLive,
  type GoalStatus,
} from "@/components/orchestration-ui/status";
import { fmtUsd } from "@/components/orchestration-ui/budget-meter";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";

/**
 * Crew detail. A crew should read like a standing team you can inspect:
 * who's on it (roster + presence + what they're working on right now),
 * what it's shipped (goal history), and how it's done overall (aggregate
 * stats). Roster edits reuse the agent-crew mutations.
 */
export default function CrewDetailPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const params = useParams<{ crewId: string }>();
  const crewId = params.crewId;
  const utils = trpc.useUtils();

  const detailQuery = trpc.agentCrew.detail.useQuery({ id: crewId });
  const statsQuery = trpc.agentCrew.stats.useQuery({ id: crewId });
  const historyQuery = trpc.agentCrew.goalHistory.useQuery({ id: crewId });
  const { data: agentsData } = trpc.agent.list.useQuery({ includeArchived: false });

  const crew = detailQuery.data;
  const stats = statsQuery.data;
  const history = useMemo(() => historyQuery.data?.items ?? [], [historyQuery.data]);
  const agents = useMemo(() => agentsData ?? [], [agentsData]);

  // Live: presence, current-step assignments, and goal status all move
  // the detail view. Invalidate the relevant queries on those events.
  useRealtime(
    () => {
      utils.agentCrew.detail.invalidate({ id: crewId });
    },
    { subjectType: ["agent", "agent-crew", "execution-step"] },
  );
  useRealtime(
    () => {
      utils.agentCrew.goalHistory.invalidate({ id: crewId });
      utils.agentCrew.stats.invalidate({ id: crewId });
    },
    { subjectType: "goal" },
  );

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editParallel, setEditParallel] = useState(1);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const update = trpc.agentCrew.update.useMutation({
    onSuccess: () => {
      toast.success("Crew updated");
      utils.agentCrew.detail.invalidate({ id: crewId });
      utils.agentCrew.list.invalidate();
      setEditing(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.agentCrew.archive.useMutation({
    onSuccess: () => {
      toast.success("Crew archived");
      utils.agentCrew.list.invalidate();
      router.push(`/w/${ws.slug}/crews`);
    },
    onError: (e) => toast.error(e.message),
  });

  const addMember = trpc.agentCrew.addMember.useMutation({
    onSuccess: () => {
      utils.agentCrew.detail.invalidate({ id: crewId });
      utils.agentCrew.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const removeMember = trpc.agentCrew.removeMember.useMutation({
    onSuccess: () => {
      utils.agentCrew.detail.invalidate({ id: crewId });
      utils.agentCrew.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setMemberRole = trpc.agentCrew.setMemberRole.useMutation({
    onSuccess: () => {
      utils.agentCrew.detail.invalidate({ id: crewId });
    },
    onError: (e) => toast.error(e.message),
  });

  function openEdit() {
    if (!crew) return;
    setEditName(crew.name);
    setEditDesc(crew.description ?? "");
    setEditParallel(crew.maxParallel);
    setEditing(true);
  }

  if (detailQuery.isLoading) {
    return (
      <>
        <Topbar title="Crew" />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SkeletonList rows={4} />
        </div>
      </>
    );
  }

  if (!crew) {
    return (
      <>
        <Topbar
          title="Crew"
          actions={
            <Button size="sm" variant="ghost" onClick={() => router.push(`/w/${ws.slug}/crews`)}>
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <EmptyState
            variant="page"
            icon={<X />}
            title="Crew not found"
            description="It may have been archived or removed."
          />
        </div>
      </>
    );
  }

  const memberCount = crew.members.length;

  return (
    <>
      <Topbar
        title={crew.name}
        subtitle={`Crew · ${memberCount} member${memberCount === 1 ? "" : "s"} · max ${crew.maxParallel === 0 ? "∞" : crew.maxParallel} parallel`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => router.push(`/w/${ws.slug}/crews`)}>
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </Button>
            <Button size="sm" variant="ghost" onClick={openEdit}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-warning"
              onClick={() => setArchiveOpen(true)}
            >
              <Archive className="h-3.5 w-3.5" /> Archive
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {crew.description ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {crew.description}
            </p>
          ) : null}

          {/* Aggregate stats */}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard
              label="Goals run"
              value={stats ? String(stats.totalGoals) : "—"}
            />
            <StatCard
              label="Success rate"
              value={
                stats && stats.successRate !== null
                  ? `${Math.round(stats.successRate * 100)}%`
                  : "—"
              }
              hint={
                stats && stats.totalGoals
                  ? `${stats.achievedGoals}/${stats.totalGoals} achieved`
                  : undefined
              }
            />
            <StatCard
              label="Avg cost / goal"
              value={
                stats && stats.avgCostPerGoal !== null
                  ? fmtUsd(stats.avgCostPerGoal)
                  : "—"
              }
              mono
            />
            <StatCard
              label="Avg steps / plan"
              value={
                stats && stats.avgStepsPerPlan !== null
                  ? stats.avgStepsPerPlan.toFixed(1)
                  : "—"
              }
              hint={stats ? `${stats.planCount} plan${stats.planCount === 1 ? "" : "s"}` : undefined}
              mono
            />
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
            {/* Roster */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-meta uppercase tracking-wide text-muted-foreground">
                  Roster
                </h2>
                {memberCount > 0 ? (
                  <span className="text-meta text-muted-foreground">
                    {roleBreakdown(crew.members)}
                  </span>
                ) : null}
              </div>

              {memberCount === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-card/20 p-4 text-meta text-muted-foreground">
                  No members yet. Add one below.
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {crew.members.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center gap-2.5 rounded-lg border border-border bg-card/40 p-2.5"
                    >
                      <span className="relative shrink-0">
                        <AgentAvatar
                          agent={m.agent ?? { name: m.agentId }}
                          size="md"
                          shape="circle"
                        />
                        <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-card p-0.5">
                          <AgentPresenceDot
                            status={m.agent?.status ?? "OFFLINE"}
                            size="md"
                            lastHeartbeatAt={m.agent?.lastHeartbeatAt ?? null}
                          />
                        </span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">
                            {m.agent?.name ?? m.agentId}
                          </span>
                          {m.agent?.profileKey ? (
                            <span className="truncate text-id text-muted-foreground">
                              @{m.agent.profileKey}
                            </span>
                          ) : null}
                        </div>
                        {m.activeSteps.length > 0 ? (
                          <Link
                            href={
                              m.activeSteps[0].plan.goalId
                                ? `/w/${ws.slug}/goals/${m.activeSteps[0].plan.goalId}`
                                : `/w/${ws.slug}/plans/${m.activeSteps[0].plan.id}`
                            }
                            className="mt-0.5 flex items-center gap-1 text-meta text-ember hover:underline"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-ember motion-safe:animate-pulse" />
                            <span className="truncate">
                              {m.activeSteps[0].status.toLowerCase()}: {m.activeSteps[0].title}
                            </span>
                          </Link>
                        ) : (
                          <span className="mt-0.5 block text-meta text-muted-foreground">
                            idle
                          </span>
                        )}
                      </div>
                      <select
                        value={m.role}
                        onChange={(e) =>
                          setMemberRole.mutate({
                            memberId: m.id,
                            role: e.target.value as CrewRole,
                          })
                        }
                        disabled={setMemberRole.isPending}
                        className="rounded-md border border-border bg-card/40 px-1.5 py-1 text-[10px] uppercase tracking-wide"
                        title="Change role"
                      >
                        {CREW_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMember.mutate({ memberId: m.id })}
                        disabled={removeMember.isPending}
                        title="Remove from crew"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <AddMemberRow
                agents={agents}
                busy={addMember.isPending}
                onAdd={(agentId, role) =>
                  addMember.mutate({ crewId, agentId, role })
                }
              />
            </section>

            {/* Goal history */}
            <section className="flex flex-col gap-2">
              <h2 className="text-meta uppercase tracking-wide text-muted-foreground">
                Goal history
              </h2>
              {historyQuery.isLoading ? (
                <SkeletonList rows={3} />
              ) : history.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-card/20 p-4 text-meta text-muted-foreground">
                  This crew hasn&apos;t run any goals yet.
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {history.map((g) => {
                    const status = g.status as GoalStatus;
                    const live = isGoalLive(g.status);
                    return (
                      <li key={g.id}>
                        <Link
                          href={`/w/${ws.slug}/goals/${g.id}`}
                          className={cn(
                            "group flex flex-col gap-1.5 rounded-lg border bg-card/40 p-2.5 transition hover:bg-subtle",
                            live ? "border-ember/30" : "border-border",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="flex items-center gap-1 text-meta uppercase tracking-wide text-muted-foreground">
                              <Target className="h-3 w-3" />
                              {live ? (
                                <span className="h-1.5 w-1.5 rounded-full bg-ember motion-safe:animate-pulse" />
                              ) : null}
                            </span>
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] uppercase",
                                GOAL_STATUS_TONE[status] ?? "bg-subtle text-muted-foreground",
                              )}
                            >
                              {g.status.toLowerCase()}
                            </span>
                          </div>
                          <span className="line-clamp-2 text-sm font-medium leading-snug group-hover:text-ember">
                            {g.title}
                          </span>
                          <div className="flex items-center justify-between text-meta text-muted-foreground">
                            <span>
                              {g._count.plans} plan{g._count.plans === 1 ? "" : "s"}
                            </span>
                            <span className="font-mono tabular-nums">
                              {fmtUsd(g.totalCostUsd ?? 0)}
                              {typeof g.maxTotalCostUsd === "number" && g.maxTotalCostUsd > 0
                                ? ` / ${fmtUsd(g.maxTotalCostUsd)}`
                                : ""}
                            </span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>

      <Confirm
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${crew.name}?`}
        description="Hides the crew from active listings. Members are preserved; goals it has run keep their history."
        primaryLabel={`Archive ${crew.name}`}
        variant="destructive"
        typeToConfirm={crew.name}
        loading={archive.isPending}
        onConfirm={() => archive.mutate({ id: crewId })}
      />

      {editing ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setEditing(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 text-sm font-medium">Edit crew</h2>
            <label className="text-meta text-muted-foreground">Name</label>
            <input
              autoFocus
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            />
            <label className="mt-2 block text-meta text-muted-foreground">Description</label>
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-meta"
            />
            <label className="mt-2 block text-meta text-muted-foreground">
              Max parallel steps (0 = unlimited)
            </label>
            <input
              type="number"
              min={0}
              max={20}
              value={editParallel}
              onChange={(e) => setEditParallel(Number(e.target.value))}
              className="mt-1 w-24 rounded-md border border-border bg-card/40 px-3 py-2 text-sm tabular-nums"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="ember"
                size="sm"
                disabled={update.isPending || !editName.trim()}
                onClick={() =>
                  update.mutate({
                    id: crewId,
                    name: editName.trim(),
                    description: editDesc.trim() || null,
                    maxParallel: editParallel,
                  })
                }
              >
                <Check className="h-3.5 w-3.5" />
                {update.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function StatCard({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card/40 p-3">
      <span className="text-meta uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn("text-lg font-medium", mono && "font-mono tabular-nums")}>
        {value}
      </span>
      {hint ? <span className="text-meta text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function AddMemberRow({
  agents,
  busy,
  onAdd,
}: {
  agents: Array<{ id: string; name: string; profileKey: string }>;
  busy: boolean;
  onAdd: (agentId: string, role: CrewRole) => void;
}) {
  const [agentId, setAgentId] = useState<string>("");
  const [role, setRole] = useState<CrewRole>("WORKER");
  return (
    <div className="mt-1 grid grid-cols-[1fr_130px_auto] gap-1.5">
      <select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        className="rounded-md border border-border bg-card/40 px-2 py-1.5 text-sm"
      >
        <option value="">+ Add member…</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name || a.profileKey}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as CrewRole)}
        className="rounded-md border border-border bg-card/40 px-2 py-1.5 text-sm"
      >
        {CREW_ROLES.map((r) => (
          <option key={r} value={r}>
            {roleLabel(r)}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || !agentId}
        onClick={() => {
          if (!agentId) return;
          onAdd(agentId, role);
          setAgentId("");
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
