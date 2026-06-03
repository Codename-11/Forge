"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Tags } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { LabelChip } from "@/components/ui/label-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/settings/section";
import { trpc } from "@/lib/trpc";

const DEFAULT_COLORS = [
  "#d97706", "#ca8a04", "#65a30d", "#0ea5e9", "#7c3aed", "#be185d", "#78716c",
];

type Editing = { id?: string; name: string; color: string } | null;

export default function LabelsPage() {
  const { data: labels, refetch } = trpc.label.list.useQuery();
  const [editing, setEditing] = useState<Editing>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    attached: number;
  } | null>(null);

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
        subtitle="Colored tags for issues. Use them sparingly — the best label sets stay below ~10."
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
        <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
          <Section
            title="Labels"
            hint="Tag issues with a color and name to slice and filter your work. Recolor or rename any time — changes apply everywhere the label is used."
            actions={
              labels && labels.length > 0 ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {labels.length} label{labels.length === 1 ? "" : "s"}
                </span>
              ) : undefined
            }
          >
            <Card>
              {(labels ?? []).map((l) => (
                <li key={l.id} className="group flex items-center gap-3 px-4 py-3">
                  <LabelChip label={{ name: l.name, color: l.color }} />
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {l._count.issues} issue{l._count.issues === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
                    {l.color}
                  </span>
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
                      onClick={() =>
                        setDeleteTarget({
                          id: l.id,
                          name: l.name,
                          attached: l._count.issues,
                        })
                      }
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
              {labels?.length === 0 && (
                <EmptyState
                  icon={Tags}
                  title="No labels yet"
                  hint="Labels are colored tags you attach to issues — handy for things like bug, design, or needs-review. Create your first one to get started."
                  action={
                    <Button
                      variant="ember"
                      size="sm"
                      onClick={() => setEditing({ name: "", color: DEFAULT_COLORS[0] })}
                    >
                      New label
                    </Button>
                  }
                />
              )}
            </Card>
          </Section>

          <Section
            title="Palette"
            hint="Suggested colors. The create and edit dialogs default to these swatches, but the color picker accepts any hex value."
          >
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 p-5">
              {DEFAULT_COLORS.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1"
                >
                  <span className="h-4 w-4 rounded" style={{ backgroundColor: c }} />
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">{c}</span>
                </span>
              ))}
            </div>
          </Section>
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
            <div className="flex flex-wrap justify-end gap-2">
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

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title={`Delete label "${deleteTarget?.name}"?`}
        description={
          deleteTarget && deleteTarget.attached > 0
            ? `This label will be removed from ${deleteTarget.attached} issue${
                deleteTarget.attached === 1 ? "" : "s"
              }. This action cannot be undone.`
            : "This action cannot be undone."
        }
        primaryLabel="Delete"
        typeToConfirm={
          deleteTarget && deleteTarget.attached > 0 ? deleteTarget.name : undefined
        }
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync({ id: deleteTarget.id });
          setDeleteTarget(null);
        }}
      />
    </>
  );
}
