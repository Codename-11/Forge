"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Columns3 } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";

const CATEGORIES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "CANCELED",
] as const;
type Category = (typeof CATEGORIES)[number];

type Row = {
  id: string;
  name: string;
  category: Category;
  color: string;
  position: number;
  isDefault: boolean;
};

export default function StatusesPage() {
  const { data: statuses, refetch } = trpc.status.list.useQuery();
  const [rows, setRows] = useState<Row[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("TODO");
  const [color, setColor] = useState("#a8a29e");

  useEffect(() => {
    if (statuses) setRows(statuses.map((s) => ({ ...s, category: s.category as Category })));
  }, [statuses]);

  const create = trpc.status.create.useMutation({
    onSuccess: () => {
      toast.success("Status added.");
      setOpen(false);
      setName("");
      setCategory("TODO");
      setColor("#a8a29e");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const reorder = trpc.status.reorder.useMutation({
    onSuccess: () => refetch(),
    onError: (e) => {
      toast.error(e.message);
      refetch();
    },
  });

  function commitOrder(next: Row[]) {
    setRows(next);
    reorder.mutate(next.map((r, idx) => ({ id: r.id, position: idx })));
  }

  function onDragStart(id: string) {
    setDragId(id);
  }
  function onDragOver(targetId: string, e: React.DragEvent) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    const from = rows.findIndex((r) => r.id === dragId);
    const to = rows.findIndex((r) => r.id === targetId);
    if (from === -1 || to === -1) return;
    const next = rows.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRows(next);
  }
  function onDrop() {
    if (dragId) commitOrder(rows);
    setDragId(null);
  }

  return (
    <>
      <Topbar
        title="Statuses"
        subtitle="Workflow columns used across issues and the kanban board. Drag to reorder."
        actions={
          <Button variant="ember" size="sm" onClick={() => setOpen(true)}>
            Add status
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
            {rows.map((s) => (
              <li
                key={s.id}
                draggable
                onDragStart={() => onDragStart(s.id)}
                onDragOver={(e) => onDragOver(s.id, e)}
                onDragEnd={() => setDragId(null)}
                className={
                  "flex cursor-grab items-center gap-3 px-4 py-3 active:cursor-grabbing " +
                  (dragId === s.id ? "opacity-50" : "")
                }
              >
                <span
                  className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground"
                  aria-hidden
                >
                  ⋮⋮
                </span>
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: s.color }}
                />
                <span className="font-medium">{s.name}</span>
                <Badge>{s.category}</Badge>
                {s.isDefault && <Badge color="#d97706">default</Badge>}
                <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
                  pos {s.position}
                </span>
              </li>
            ))}
            {rows.length === 0 && (
              <EmptyState
                icon={Columns3}
                title="No statuses configured"
                hint="Add a status to define a workflow column for issues."
              />
            )}
          </Card>
        </div>
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return toast.error("Name required.");
            create.mutate({ name: name.trim(), category, color, position: rows.length });
          }}
          className="space-y-3 p-5"
        >
          <div className="text-sm font-semibold">Add status</div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
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
              <Input value={color} onChange={(e) => setColor(e.target.value)} className="flex-1" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="ember" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
