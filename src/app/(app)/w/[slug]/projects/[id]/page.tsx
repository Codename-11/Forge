"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { IssueBoard } from "@/components/issue-board";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, Skeleton } from "@/components/ui";
import { ViewToggle, useViewPref } from "@/components/view-toggle";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const { data: project, error, refetch } = trpc.project.byId.useQuery({ id });
  const { data: ws } = trpc.workspace.current.useQuery();
  const [view, setView] = useViewPref(`project:${id}`, "board");
  const [editOpen, setEditOpen] = useState(false);

  const archive = trpc.project.archive.useMutation({
    onSuccess: () => {
      toast.success("Project archived.");
      router.push(`/w/${slug}/projects`);
    },
    onError: (e) => toast.error(e.message),
  });

  const del = trpc.project.softDelete.useMutation({
    onSuccess: () => {
      toast.success("Project deleted.");
      router.push(`/w/${slug}/projects`);
    },
    onError: (e) => toast.error(e.message),
  });

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          variant="page"
          title="Project not found"
          description={error.message}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/w/${slug}/projects`)}
            >
              Back to projects
            </Button>
          }
        />
      </div>
    );
  }

  if (!project)
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  return (
    <>
      <Topbar
        title={
          <span className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: project.color ?? "#78716c" }}
            />
            {project.icon && <span>{project.icon}</span>}
            {project.name}
          </span>
        }
        subtitle={project.key}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ember"
              size="sm"
              data-quick-create
              data-quick-create-project={project.id}
            >
              New issue
            </Button>
            <ViewToggle value={view} onChange={setView} />
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={archive.isPending || project.archived}
              onClick={() => {
                if (confirm(`Archive "${project.name}"? Its issues stay intact.`))
                  archive.mutate({ id: project.id });
              }}
            >
              {project.archived ? "Archived" : "Archive"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={del.isPending}
              onClick={() => {
                if (
                  confirm(
                    `Delete "${project.name}"? Issues are preserved but unlinked from this project.`,
                  )
                )
                  del.mutate({ id: project.id });
              }}
            >
              Delete
            </Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <section className="border-b border-border px-5 py-3 text-xs text-muted-foreground">
          {project.description ? (
            <p className="max-w-4xl whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/80">
              {project.description}
            </p>
          ) : (
            <span>No description.</span>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {project.startDate && <span>Starts {relativeTime(project.startDate)}</span>}
            {project.targetDate && <span>Target {relativeTime(project.targetDate)}</span>}
            <span>Updated {relativeTime(project.updatedAt)}</span>
            {project.archived && <Badge color="#d97706">archived</Badge>}
          </div>
        </section>
        <div className="min-h-0 flex-1 overflow-hidden">
          {view === "list" ? (
            <div className="h-full overflow-y-auto">
              <IssueList workspaceKey={ws?.key ?? "—"} projectId={project.id} includeDone />
            </div>
          ) : (
            <IssueBoard workspaceKey={ws?.key ?? "—"} projectId={project.id} />
          )}
        </div>
      </div>

      <EditProjectDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        onSaved={() => refetch()}
      />
    </>
  );
}

function EditProjectDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
  };
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [color, setColor] = useState(project.color ?? "#78716c");
  const [icon, setIcon] = useState(project.icon ?? "");

  const update = trpc.project.update.useMutation({
    onSuccess: () => {
      toast.success("Saved.");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({
            id: project.id,
            name: name.trim(),
            description: description.trim() || null,
            color,
            icon: icon.trim() || undefined,
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="text-sm font-semibold">Edit project</div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
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
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Icon (emoji)</label>
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="ember" disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
