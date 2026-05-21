"use client";
import { useMemo } from "react";
import Link from "next/link";
import { Settings2, UsersRound } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { EmptyState, SkeletonList } from "@/components/ui";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { roleBreakdown } from "@/components/crews/role-chip";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";

/**
 * Crews index. A crew is a standing team — surfaces who's on it and a
 * role breakdown at a glance, plus the cap on parallel steps. Click into
 * a crew for the roster + goal history. Heavy CRUD (create / archive)
 * still lives under settings; this page links there.
 */
export default function CrewsPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.agentCrew.list.useQuery({});
  const crews = useMemo(() => data?.items ?? [], [data]);

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
          <Link
            href={`/w/${ws.slug}/settings/crews`}
            className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors hover:bg-subtle"
          >
            <Settings2 className="h-3.5 w-3.5" /> Manage
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <SkeletonList rows={3} />
        ) : crews.length === 0 ? (
          <EmptyState
            variant="page"
            icon={<UsersRound />}
            title="No crews yet"
            description="A crew is a standing team of agents — planner, workers, reviewers — that decomposes goals into plans and drives them to done. Build one to assign at goal creation."
            action={
              <Link
                href={`/w/${ws.slug}/settings/crews`}
                className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md bg-ember px-2 text-xs font-medium text-ember-foreground transition-colors hover:bg-ember/90"
              >
                Create a crew
              </Link>
            }
          />
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
    </>
  );
}
