"use client";
import { useState } from "react";
import { toast } from "sonner";
import { LayoutTemplate } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

type Form = {
  id?: string;
  name: string;
  suggestedKey: string;
  description: string;
  color: string;
  icon: string;
};

const empty: Form = {
  name: "",
  suggestedKey: "",
  description: "",
  color: DEFAULT_COLORS[0],
  icon: "",
};

export function ProjectTemplatesPanel() {
  const { data: rows, refetch } = trpc.projectTemplate.list.useQuery();
  const [editing, setEditing] = useState<Form | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const create = trpc.projectTemplate.create.useMutation({
    onSuccess: () => {
      toast.success("Template created.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.projectTemplate.update.useMutation({
    onSuccess: () => {
      toast.success("Template saved.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.projectTemplate.delete.useMutation({
    onSuccess: () => {
      toast.success("Template deleted.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <div className="flex items-center justify-end px-5 py-3">
        <Button variant="ember" size="sm" onClick={() => setEditing({ ...empty })}>
          New template
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-6 pb-6">
          <Section
            title="Project templates"
            hint="Pre-configured starting points for new projects — a name, an issue-id key, a color, and an icon — so spinning up a new project doesn't mean re-deciding the basics each time."
          >
          <Card>
            {(rows ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: r.color ?? "#78716c" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {r.icon && <span>{r.icon}</span>}
                    <span className="font-medium">{r.name}</span>
                    <Badge>{r.suggestedKey}</Badge>
                  </div>
                  {r.description && (
                    <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
                      {r.description}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setEditing({
                      id: r.id,
                      name: r.name,
                      suggestedKey: r.suggestedKey,
                      description: r.description ?? "",
                      color: r.color ?? DEFAULT_COLORS[0],
                      icon: r.icon ?? "",
                    })
                  }
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleteTarget({ id: r.id, name: r.name })}
                >
                  Delete
                </Button>
              </li>
            ))}
            {rows?.length === 0 && (
              <EmptyState
                icon={LayoutTemplate}
                title="No project templates yet"
                hint="Define a starter once — name, suggested key, color, icon — and new projects begin half-configured instead of empty. Handy when you spin up similar projects often."
                action={
                  <Button variant="ember" size="sm" onClick={() => setEditing({ ...empty })}>
                    New template
                  </Button>
                }
              />
            )}
          </Card>
          </Section>
        </div>
      </div>

      <Dialog open={!!editing} onClose={() => setEditing(null)} className="max-w-lg">
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing.name.trim() || !editing.suggestedKey.trim())
                return toast.error("Name and key are required.");
              const payload = {
                name: editing.name.trim(),
                suggestedKey: editing.suggestedKey.trim().toUpperCase(),
                description: editing.description.trim() || null,
                color: editing.color || null,
                icon: editing.icon.trim() || null,
              };
              if (editing.id) update.mutate({ id: editing.id, ...payload });
              else create.mutate(payload);
            }}
            className="space-y-3 p-5"
          >
            <div className="text-sm font-semibold">
              {editing.id ? "Edit project template" : "New project template"}
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Name</label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Suggested key</label>
                <Input
                  value={editing.suggestedKey}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      suggestedKey: e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase(),
                    })
                  }
                  maxLength={8}
                  placeholder="FRG"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Description</label>
              <textarea
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                rows={3}
                className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={editing.color}
                    onChange={(e) => setEditing({ ...editing, color: e.target.value })}
                    className="h-8 w-10 cursor-pointer rounded border border-input bg-background"
                  />
                  <div className="flex flex-wrap gap-1">
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
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Icon (emoji)</label>
                <Input
                  value={editing.icon}
                  onChange={(e) => setEditing({ ...editing, icon: e.target.value })}
                  maxLength={8}
                />
              </div>
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

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title={`Delete template "${deleteTarget?.name}"?`}
        description="This action cannot be undone."
        primaryLabel="Delete"
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
