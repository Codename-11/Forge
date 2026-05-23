"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Info, Plus, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { roleBreakdown, type CrewRole } from "@/components/crews/role-chip";
import { RolePicker } from "@/components/crews/role-picker";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";

/**
 * Crews index. A crew is a standing team — surfaces who's on it and a
 * role breakdown at a glance, plus the cap on parallel steps. Click into
 * a crew for the roster + goal history. Creation lives here (rich role
 * picker) so the operator never has to detour through settings.
 */
export default function CrewsPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.agentCrew.list.useQuery({});
  const crews = useMemo(() => data?.items ?? [], [data]);

  const [creating, setCreating] = useState(false);

  // Auto-open the "New crew" modal when navigated with ?new (the
  // command palette "Create crew" action lands here).
  useEffect(() => {
    if (searchParams?.has("new")) {
      setCreating(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("new");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
  }, [searchParams, pathname, router]);

  // Live presence + roster churn: re-pull the list on agent + crew events.
  useRealtime(
    () => {
      utils.agentCrew.list.invalidate();
    },
    { subjectType: ["agent", "agent-crew"] },
  );

  return (
    <>
      <Topbar
        title="Crews"
        subtitle={data ? `${crews.length} active` : undefined}
        actions={
          <Button size="sm" variant="ember" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New crew
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <SkeletonList rows={3} />
        ) : crews.length === 0 ? (
          <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-6">
            <EmptyState
              variant="page"
              icon={<UsersRound />}
              title="No crews yet"
              description="A crew is a standing team of agents — planner, workers, reviewers — that decomposes a goal into a plan and drives it to done. Build one, then assign it when you create a goal."
              action={
                <Button size="sm" variant="ember" onClick={() => setCreating(true)}>
                  <Plus className="h-3.5 w-3.5" /> Create a crew
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {crews.map((crew) => {
              const memberCount = crew.members.length;
              const planCount = crew._count?.executionPlans ?? 0;
              return (
                <li key={crew.id}>
                  <Link
                    href={`/w/${ws.slug}/crews/${crew.id}`}
                    className="group flex h-full flex-col gap-3 rounded-lg border border-border bg-card/40 p-3 transition hover:border-ember/40 hover:bg-subtle"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-medium group-hover:text-ember">
                          {crew.name}
                        </h3>
                        {crew.description ? (
                          <p className="line-clamp-2 text-meta text-muted-foreground">
                            {crew.description}
                          </p>
                        ) : null}
                      </div>
                      <UsersRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </div>

                    {/* Avatar stack */}
                    {memberCount > 0 ? (
                      <div className="flex items-center -space-x-1.5">
                        {crew.members.slice(0, 6).map((m) => (
                          <span key={m.id} className="relative">
                            <AgentAvatar
                              agent={m.agent ?? { name: m.agentId }}
                              size="sm"
                              shape="circle"
                              className="ring-2 ring-card"
                            />
                          </span>
                        ))}
                        {memberCount > 6 ? (
                          <span className="ml-2.5 text-meta text-muted-foreground">
                            +{memberCount - 6}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-meta text-muted-foreground">
                        No members yet.
                      </p>
                    )}

                    <div className="mt-auto flex flex-col gap-1 pt-1 text-meta text-muted-foreground">
                      {memberCount > 0 ? (
                        <span className="truncate">{roleBreakdown(crew.members)}</span>
                      ) : null}
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-mono tabular-nums">
                          max {crew.maxParallel === 0 ? "∞" : crew.maxParallel} parallel
                        </span>
                        {planCount > 0 ? (
                          <span aria-hidden>·</span>
                        ) : null}
                        {planCount > 0 ? (
                          <span className="font-mono tabular-nums">
                            {planCount} plan{planCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {creating ? (
        <CreateCrewModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            utils.agentCrew.list.invalidate();
            router.push(`/w/${ws.slug}/crews/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Crew creation modal. Names the crew and optionally seeds a first
 * member with a role chosen from the explanatory RolePicker (rather than
 * a bare dropdown), so the operator understands what the role does.
 */
function CreateCrewModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (crewId: string) => void;
}) {
  const { data: agentsData } = trpc.agent.list.useQuery({ includeArchived: false });
  const agents = useMemo(() => agentsData ?? [], [agentsData]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [seedAgentId, setSeedAgentId] = useState<string>("");
  const [seedRole, setSeedRole] = useState<CrewRole>("PLANNER");

  const createCrew = trpc.agentCrew.create.useMutation({
    onSuccess: (result) => {
      toast.success("Crew created");
      onCreated(result.id);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium">New crew</h2>
        <p className="mt-1 flex items-start gap-1.5 text-meta text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
          A crew is a reusable team you assign to a goal. The roles below
          decide who plans, who does the work, and who reviews it.
        </p>

        <label className="mt-3 block text-meta text-muted-foreground">Name</label>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Migration crew"
          className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-meta text-muted-foreground">
          Description (optional)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What this crew is for"
          className="mt-1 w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-meta"
        />

        <label className="mt-3 block text-meta text-muted-foreground">
          First member (optional — add more after)
        </label>
        <select
          value={seedAgentId}
          onChange={(e) => setSeedAgentId(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
        >
          <option value="">Skip — create an empty crew</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.profileKey}
            </option>
          ))}
        </select>

        {seedAgentId ? (
          <div className="mt-2">
            <span className="mb-1 block text-meta text-muted-foreground">Role</span>
            <RolePicker value={seedRole} onChange={setSeedRole} />
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="ember"
            size="sm"
            disabled={createCrew.isPending || !name.trim()}
            onClick={() =>
              createCrew.mutate({
                name: name.trim(),
                description: description.trim() || null,
                members: seedAgentId
                  ? [{ agentId: seedAgentId, role: seedRole }]
                  : undefined,
              })
            }
          >
            {createCrew.isPending ? "Creating…" : "Create crew"}
          </Button>
        </div>
      </div>
    </div>
  );
}
