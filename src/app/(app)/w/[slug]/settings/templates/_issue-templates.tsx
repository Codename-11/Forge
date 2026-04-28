"use client";
import { useState } from "react";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

type Form = {
  id?: string;
  name: string;
  projectId: string;
  titleTemplate: string;
  descriptionTemplate: string;
  defaultPriority: Priority;
  labelIds: string[];
};

const empty: Form = {
  name: "",
  projectId: "",
  titleTemplate: "",
  descriptionTemplate: "",
  defaultPriority: "NONE",
  labelIds: [],
};

export function IssueTemplatesPanel() {
  const { data: templates, refetch } = trpc.template.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: labels } = trpc.label.list.useQuery();
  const [editing, setEditing] = useState<Form | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const create = trpc.template.create.useMutation({
    onSuccess: () => {
      toast.success("Template created.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.template.update.useMutation({
    onSuccess: () => {
      toast.success("Template saved.");
      refetch();
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.template.delete.useMutation({
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
        <div className="mx-auto max-w-3xl space-y-6 px-6 pb-6">
          <Card>
            {(templates ?? []).map((t) => (
              <li key={t.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge>{t.defaultPriority}</Badge>
                    {t.project && (
                      <Badge color={t.project.color ?? undefined}>{t.project.key}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
                    {t.titleTemplate}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setEditing({
                      id: t.id,
                      name: t.name,
                      projectId: t.projectId ?? "",
                      titleTemplate: t.titleTemplate,
                      descriptionTemplate: t.descriptionTemplate ?? "",
                      defaultPriority: t.defaultPriority as Priority,
                      labelIds: t.labelIds,
                    })
                  }
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleteTarget({ id: t.id, name: t.name })}
                >
                  Delete
                </Button>
              </li>
            ))}
            {templates?.length === 0 && (
              <EmptyState
                icon={FileText}
                title="No templates yet"
                hint="Create one so new issues start with structure instead of a blank page."
              />
            )}
          </Card>
        </div>
      </div>

      <Dialog open={!!editing} onClose={() => setEditing(null)} className="max-w-xl">
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing.name.trim() || !editing.titleTemplate.trim())
                return toast.error("Name and title template required.");
              const payload = {
                name: editing.name.trim(),
                projectId: editing.projectId || null,
                titleTemplate: editing.titleTemplate.trim(),
                descriptionTemplate: editing.descriptionTemplate.trim() || null,
                defaultPriority: editing.defaultPriority,
                labelIds: editing.labelIds,
              };
              if (editing.id) update.mutate({ id: editing.id, ...payload });
              else create.mutate(payload);
            }}
            className="space-y-3 p-5"
          >
            <div className="text-sm font-semibold">
              {editing.id ? "Edit template" : "New template"}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                autoFocus
                placeholder="e.g. Bug report"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Title template</label>
              <Input
                value={editing.titleTemplate}
                onChange={(e) => setEditing({ ...editing, titleTemplate: e.target.value })}
                placeholder="Bug: …"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Description template</label>
              <textarea
                value={editing.descriptionTemplate}
                onChange={(e) =>
                  setEditing({ ...editing, descriptionTemplate: e.target.value })
                }
                rows={6}
                className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
                placeholder="## Steps to reproduce&#10;1. ...&#10;&#10;## Expected&#10;&#10;## Actual"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Project</label>
                <select
                  value={editing.projectId}
                  onChange={(e) => setEditing({ ...editing, projectId: e.target.value })}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">Any project</option>
                  {projects?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Priority</label>
                <select
                  value={editing.defaultPriority}
                  onChange={(e) =>
                    setEditing({ ...editing, defaultPriority: e.target.value as Priority })
                  }
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Labels</label>
              <div className="flex flex-wrap gap-1">
                {(labels ?? []).map((l) => {
                  const on = editing.labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() =>
                        setEditing({
                          ...editing,
                          labelIds: on
                            ? editing.labelIds.filter((x) => x !== l.id)
                            : [...editing.labelIds, l.id],
                        })
                      }
                      className={
                        "focus-ring rounded-sm border px-1.5 py-0.5 text-[0.6875rem] " +
                        (on ? "border-ember/50 bg-ember/10" : "border-transparent")
                      }
                    >
                      <Badge color={l.color}>{l.name}</Badge>
                    </button>
                  );
                })}
                {labels?.length === 0 && (
                  <span className="text-[0.6875rem] text-muted-foreground">
                    Create labels in Settings → Labels.
                  </span>
                )}
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
