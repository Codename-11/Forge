"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Target, Plus } from "lucide-react";
import { InitiativeStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/settings/empty-state";
import { InitiativeCard } from "@/components/initiatives/initiative-card";
import { trpc } from "@/lib/trpc";

const DEFAULT_COLORS = [
  "#d97706",
  "#ca8a04",
  "#65a30d",
  "#0ea5e9",
  "#7c3aed",
  "#be185d",
  "#78716c",
];

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

      <CreateInitiativeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          utils.initiative.list.invalidate();
          setCreateOpen(false);
        }}
      />
    </>
  );
}

function CreateInitiativeDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [color, setColor] = useState(DEFAULT_COLORS[0]);

  const create = trpc.initiative.create.useMutation({
    onSuccess: () => {
      toast.success("Initiative created.");
      setName("");
      setSlug("");
      setDescription("");
      setTargetDate("");
      setColor(DEFAULT_COLORS[0]);
      onCreated();
    },
    onError: (e) => toast.error(e.message),
  });

  function onNameChange(v: string) {
    setName(v);
    if (!slug) {
      const suggested = v
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 48);
      setSlug(suggested);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            toast.error("Name required.");
            return;
          }
          create.mutate({
            name: name.trim(),
            slug: slug.trim() || undefined,
            description: description.trim() || undefined,
            targetDate: targetDate ? new Date(targetDate) : undefined,
            color,
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="text-sm font-semibold">New initiative</div>
        <div className="grid grid-cols-[1fr_200px] gap-2">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Slug</label>
            <Input
              value={slug}
              onChange={(e) =>
                setSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/-+/g, "-")
                    .slice(0, 48),
                )
              }
              placeholder="q2-launch"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Target date</label>
            <Input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded border border-input bg-background"
              />
              <div className="flex flex-wrap gap-1">
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className="h-5 w-5 rounded border border-border"
                    style={{ backgroundColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="ember" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
