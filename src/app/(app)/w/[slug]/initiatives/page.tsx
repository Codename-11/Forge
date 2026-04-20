"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Target, Plus } from "lucide-react";
import { InitiativeStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/settings/empty-state";
import { InitiativeCard } from "@/components/initiatives/initiative-card";
import { NewInitiativeDialog } from "@/components/initiatives/new-initiative-dialog";
import { trpc } from "@/lib/trpc";

export default function InitiativesPage() {
  const utils = trpc.useUtils();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data, isLoading } = trpc.initiative.list.useQuery({});
  const [createOpen, setCreateOpen] = useState(false);

  // Auto-open the "New initiative" dialog when navigated with ?new
  // (wired to the `g n` chord from the sidebar).
  useEffect(() => {
    if (searchParams?.has("new")) {
      setCreateOpen(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("new");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
  }, [searchParams, pathname, router]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const reorder = trpc.initiative.reorder.useMutation({
    onMutate: async ({ ids }) => {
      await utils.initiative.list.cancel();
      const prev = utils.initiative.list.getData({});
      utils.initiative.list.setData({}, (old) => {
        if (!old) return old;
        const byId = new Map(old.map((i) => [i.id, i]));
        const next = ids.map((id) => byId.get(id)!).filter(Boolean);
        // Append anything not in the list (defensive).
        for (const i of old) if (!ids.includes(i.id)) next.push(i);
        return next.map((i, idx) => ({ ...i, position: idx }));
      });
      return { prev };
    },
    onError: (_e, _i, ctx) => {
      if (ctx?.prev) utils.initiative.list.setData({}, ctx.prev);
      toast.error("Reorder failed.");
    },
    onSettled: () => utils.initiative.list.invalidate(),
  });

  const active = useMemo(
    () =>
      (data ?? []).filter((i) => i.status !== InitiativeStatus.COMPLETED),
    [data],
  );
  const completed = useMemo(
    () =>
      (data ?? []).filter((i) => i.status === InitiativeStatus.COMPLETED),
    [data],
  );

  function onDragStart(id: string) {
    setDraggingId(id);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }
  function onDrop(targetId: string) {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      setOverId(null);
      return;
    }
    const ids = active.map((i) => i.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    setDraggingId(null);
    setOverId(null);
    reorder.mutate({ ids: next });
  }

  const [showCompleted, setShowCompleted] = useState(false);

  return (
    <>
      <Topbar
        title="Initiatives"
        subtitle={data ? `${active.length} active` : undefined}
        actions={
          <Button
            variant="ember"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            New initiative
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : active.length === 0 && completed.length === 0 ? (
          <EmptyState
            as="div"
            icon={Target}
            title="No initiatives yet"
            hint="Initiatives group related projects under a strategic theme — quarterly bets, epics, or long-lived programs."
            action={
              <Button
                variant="ember"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                Create first initiative
              </Button>
            }
          />
        ) : (
          <>
            <ul
              className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3"
              onDragOver={onDragOver}
            >
              {active.map((i) => (
                <li
                  key={i.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverId(i.id);
                  }}
                  onDragLeave={() =>
                    setOverId((o) => (o === i.id ? null : o))
                  }
                >
                  <InitiativeCard
                    initiative={i}
                    draggable
                    onDragStart={onDragStart}
                    onDrop={onDrop}
                    isDragTarget={overId === i.id && draggingId !== i.id}
                  />
                </li>
              ))}
            </ul>

            {completed.length > 0 && (
              <div className="mt-6 rounded-lg border border-border bg-card/20">
                <button
                  type="button"
                  onClick={() => setShowCompleted((v) => !v)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-subtle/60"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-success"
                    aria-hidden
                  />
                  Completed
                  <span className="ml-auto font-mono text-[10px]">
                    {completed.length}
                  </span>
                  <span className="font-mono text-[10px]">
                    {showCompleted ? "▾" : "▸"}
                  </span>
                </button>
                {showCompleted && (
                  <ul className="grid grid-cols-1 gap-2 p-2 md:grid-cols-2 lg:grid-cols-3">
                    {completed.map((i) => (
                      <li key={i.id}>
                        <InitiativeCard initiative={i} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <NewInitiativeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
