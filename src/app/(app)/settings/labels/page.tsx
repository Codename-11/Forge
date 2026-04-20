"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Tags } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";

const DEFAULT_COLORS = [
  "#d97706", "#ca8a04", "#65a30d", "#0ea5e9", "#7c3aed", "#be185d", "#78716c",
];

type Editing = { id?: string; name: string; color: string } | null;

export default function LabelsPage() {
  const { data: labels, refetch } = trpc.label.list.useQuery();
  const [editing, setEditing] = useState<Editing>(null);

  const create = trpc.label.create.useMutation({
    onSuccess: () => {
      toast.success("Label created.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.label.update.useMutation({
    onSuccess: () => {
      toast.success("Label updated.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.label.delete.useMutation({
    onSuccess: () => {
      toast.success("Label deleted.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Labels"
        subtitle="Colored tags for issues."
        actions={
          <Button
            variant="ember"
            size="sm"
            onClick={() => setEditing({ name: "", color: DEFAULT_COLORS[0] })}
          >
            New label
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card>
            {(labels ?? []).map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-4 py-3">
                <Badge color={l.color}>{l.name}</Badge>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {l._count.issues} issue{l._count.issues === 1 ? "" : "s"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing({ id: l.id, name: l.name, color: l.color })}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm(`Delete label "${l.name}"? It's removed from ${l._count.issues} issue(s).`))
                      remove.mutate({ id: l.id });
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
            {labels?.length === 0 && (
              <EmptyState
                icon={Tags}
                title="No labels yet"
                hint="Create one to tag issues with a color and name."
              />
            )}
          </Card>
        </div>
      </div>

      <Dialog open={!!editing} onClose={() => setEditing(null)} className="max-w-sm">
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing.name.trim()) return toast.error("Name required.");
              if (editing.id)
                update.mutate({ id: editing.id, name: editing.name.trim(), color: editing.color });
              else create.mutate({ name: editing.name.trim(), color: editing.color });
            }}
            className="space-y-3 p-5"
          >
            <div className="text-sm font-semibold">{editing.id ? "Edit label" : "New label"}</div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                autoFocus
                maxLength={40}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={editing.color}
                  onChange={(e) => setEditing({ ...editing, color: e.target.value })}
                  className="h-8 w-10 cursor-pointer rounded border border-input bg-background"
                />
                <div className="flex gap-1">
                  {DEFAULT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setEditing({ ...editing, color: c })}
                      className="h-5 w-5 rounded border border-border"
                      style={{ backgroundColor: c }}
                      aria-label={c}
                    />
                  ))}
                </div>
              </div>
              <Badge color={editing.color}>{editing.name || "preview"}</Badge>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="ember" disabled={create.isPending || update.isPending}>
                {editing.id ? "Save" : "Create"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
