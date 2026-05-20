"use client";
import { useMemo, useState } from "react";
import { Archive, Plus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";

const ROLES = [
  "PLANNER",
  "WORKER",
  "REVIEWER",
  "OBSERVER",
  "OPERATOR_PROXY",
] as const;
type Role = (typeof ROLES)[number];

const ROLE_TONE: Record<Role, string> = {
  PLANNER: "bg-ember/15 text-ember",
  WORKER: "bg-subtle text-foreground",
  REVIEWER: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  OBSERVER: "bg-muted/40 text-muted-foreground",
  OPERATOR_PROXY: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

/**
 * Agent crew admin. Lists each crew with its members; "+ New crew"
 * opens an inline form for naming the crew and seeding its first
 * member. Existing crews accept add/remove member edits via the
 * existing tRPC mutations.
 */
export default function CrewsSettingsPage() {
  const utils = trpc.useUtils();
  const { data: crewsData, isLoading } = trpc.agentCrew.list.useQuery({});
  const { data: agentsData } = trpc.agent.list.useQuery({ includeArchived: false });

  const crews = useMemo(() => crewsData?.items ?? [], [crewsData]);
  const agents = useMemo(() => agentsData ?? [], [agentsData]);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [seedAgentId, setSeedAgentId] = useState<string>("");
  const [seedRole, setSeedRole] = useState<Role>("PLANNER");
  const [archiveTarget, setArchiveTarget] = useState<
    { id: string; name: string } | null
  >(null);

  const createCrew = trpc.agentCrew.create.useMutation({
    onSuccess: () => {
      toast.success("Crew created");
      utils.agentCrew.list.invalidate();
      setCreating(false);
      setNewName("");
      setNewDescription("");
      setSeedAgentId("");
      setSeedRole("PLANNER");
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.agentCrew.archive.useMutation({
    onSuccess: () => {
      toast.success("Crew archived");
      utils.agentCrew.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const addMember = trpc.agentCrew.addMember.useMutation({
    onSuccess: () => {
      toast.success("Member added");
      utils.agentCrew.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const removeMember = trpc.agentCrew.removeMember.useMutation({
    onSuccess: () => {
      utils.agentCrew.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Agent crews"
        subtitle={crewsData ? `${crews.length} active` : undefined}
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
          <EmptyState
            variant="page"
            icon={<Users />}
            title="No crews yet"
            description="Bind agents into crews to run multi-step plans with planner / worker / reviewer roles. Crews can be referenced from ExecutionPlans and gate critical steps via review gates."
            action={
              <Button size="sm" variant="ember" onClick={() => setCreating(true)}>
                Create first crew
              </Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {crews.map((crew) => (
              <li
                key={crew.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium">{crew.name}</h3>
                    {crew.description ? (
                      <p className="line-clamp-2 text-meta text-muted-foreground">
                        {crew.description}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-warning"
                    onClick={() =>
                      setArchiveTarget({ id: crew.id, name: crew.name })
                    }
                    disabled={archive.isPending}
                  >
                    <Archive className="h-3 w-3" />
                  </Button>
                </div>
                <ul className="flex flex-col gap-1">
                  {crew.members.length === 0 ? (
                    <li className="rounded-md border border-dashed border-border bg-card/20 p-2 text-meta text-muted-foreground">
                      No members yet.
                    </li>
                  ) : (
                    crew.members.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/30 px-2 py-1"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span className="truncate text-sm">
                            {m.agent?.name ?? m.agent?.profileKey ?? m.agentId}
                          </span>
                          <span
                            className={`rounded px-1 py-0.5 text-[10px] uppercase ${ROLE_TONE[m.role as Role] ?? ROLE_TONE.OBSERVER}`}
                          >
                            {m.role.toLowerCase()}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeMember.mutate({ memberId: m.id })}
                          disabled={removeMember.isPending}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </li>
                    ))
                  )}
                </ul>
                <AddMemberRow
                  agents={agents}
                  busy={addMember.isPending}
                  onAdd={(agentId, role) =>
                    addMember.mutate({ crewId: crew.id, agentId, role })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <Confirm
        open={archiveTarget !== null}
        onOpenChange={(o) => {
          if (!o) setArchiveTarget(null);
        }}
        title={archiveTarget ? `Archive ${archiveTarget.name}?` : "Archive crew?"}
        description="Hides the crew from active listings. Members are preserved; you can restore later."
        primaryLabel={archiveTarget ? `Archive ${archiveTarget.name}` : "Archive crew"}
        variant="destructive"
        typeToConfirm={archiveTarget?.name}
        loading={archive.isPending}
        onConfirm={() => {
          if (!archiveTarget) return;
          archive.mutate(
            { id: archiveTarget.id },
            { onSettled: () => setArchiveTarget(null) },
          );
        }}
      />

      {creating && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setCreating(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 text-sm font-medium">New agent crew</h2>
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Crew name (e.g. Migration crew)"
              className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            />
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              rows={2}
              placeholder="Description (optional)"
              className="mt-2 w-full resize-y rounded-md border border-border bg-card/40 px-3 py-2 text-meta"
            />
            <div className="mt-2 grid grid-cols-[1fr_120px] gap-2">
              <select
                value={seedAgentId}
                onChange={(e) => setSeedAgentId(e.target.value)}
                className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
              >
                <option value="">(Skip seed member)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.profileKey}
                  </option>
                ))}
              </select>
              <select
                value={seedRole}
                onChange={(e) => setSeedRole(e.target.value as Role)}
                className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                variant="ember"
                size="sm"
                onClick={() =>
                  createCrew.mutate({
                    name: newName.trim() || "Untitled crew",
                    description: newDescription.trim() || null,
                    members: seedAgentId
                      ? [{ agentId: seedAgentId, role: seedRole }]
                      : undefined,
                  })
                }
                disabled={createCrew.isPending || !newName.trim()}
              >
                {createCrew.isPending ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AddMemberRow({
  agents,
  busy,
  onAdd,
}: {
  agents: Array<{ id: string; name: string; profileKey: string }>;
  busy: boolean;
  onAdd: (agentId: string, role: Role) => void;
}) {
  const [agentId, setAgentId] = useState<string>("");
  const [role, setRole] = useState<Role>("WORKER");
  return (
    <div className="mt-1 grid grid-cols-[1fr_110px_auto] gap-1">
      <select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        className="rounded-md border border-border bg-card/40 px-2 py-1 text-meta"
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
        onChange={(e) => setRole(e.target.value as Role)}
        className="rounded-md border border-border bg-card/40 px-2 py-1 text-meta"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r.toLowerCase()}
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
        <Plus className="h-3 w-3" />
      </Button>
    </div>
  );
}
