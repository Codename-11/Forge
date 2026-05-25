"use client";
import { useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Bookmark } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/settings/section";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

type Filters = {
  projectId: string;
  statusId: string;
  priority: Priority | "";
  query: string;
  view: "list" | "board";
  includeDone: boolean;
};

const emptyFilters: Filters = {
  projectId: "",
  statusId: "",
  priority: "",
  query: "",
  view: "list",
  includeDone: false,
};

export default function ViewsPage() {
  const { slug } = useWorkspace();
  const { data: views, refetch } = trpc.view.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: statuses } = trpc.status.list.useQuery();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const create = trpc.view.create.useMutation({
    onSuccess: () => {
      toast.success("View saved.");
      setOpen(false);
      setName("");
      setShared(false);
      setFilters(emptyFilters);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.view.delete.useMutation({
    onSuccess: () => {
      toast.success("View deleted.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  function toQuery(f: Record<string, unknown>) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (v == null || v === "" || v === false) continue;
      q.set(k, String(v));
    }
    return q.toString();
  }

  const allViews = views ?? [];
  const personalViews = allViews.filter((v) => v.userId);
  const sharedViews = allViews.filter((v) => !v.userId);

  function ViewRow({ v }: { v: (typeof allViews)[number] }) {
    const f = v.filters as Record<string, unknown>;
    const qs = toQuery(f);
    return (
      <li key={v.id} className="flex items-center gap-3 px-4 py-3">
        <Bookmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/w/${slug}/issues${qs ? `?${qs}` : ""}`}
              className="font-medium hover:text-ember"
            >
              {v.name}
            </Link>
            {v.userId ? <Badge>personal</Badge> : <Badge color="#7c3aed">shared</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[0.6875rem] text-muted-foreground">
            {qs || "no filters"}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDeleteTarget({ id: v.id, name: v.name })}
        >
          Delete
        </Button>
      </li>
    );
  }

  return (
    <>
      <Topbar
        title="Saved views"
        subtitle="Bookmark a filter combo. Personal or shared."
        actions={
          <Button variant="ember" size="sm" onClick={() => setOpen(true)}>
            New view
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          {allViews.length === 0 ? (
            <Card as="div">
              <EmptyState
                as="div"
                icon={Bookmark}
                title="No saved views yet"
                hint="A saved view bookmarks a filter combo — project, status, priority, search — so you can jump straight back to a slice of work without rebuilding the filters each time. Keep one personal, or share it so the whole workspace sees the same list."
                action={
                  <Button variant="ember" size="sm" onClick={() => setOpen(true)}>
                    New view
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              <Section
                title="Yours"
                hint="Personal views — only you see these. Click a name to open it in the issues list."
              >
                <Card>
                  {personalViews.map((v) => (
                    <ViewRow key={v.id} v={v} />
                  ))}
                  {personalViews.length === 0 && (
                    <EmptyState
                      icon={Bookmark}
                      title="No personal views"
                      hint="Save a filter combo you reach for often. Leave “shared” unchecked to keep it to yourself."
                    />
                  )}
                </Card>
              </Section>

              <Section
                title="Shared with workspace"
                hint="Visible to everyone in the workspace — useful for team queues like “Bugs” or “Awaiting review.”"
              >
                <Card>
                  {sharedViews.map((v) => (
                    <ViewRow key={v.id} v={v} />
                  ))}
                  {sharedViews.length === 0 && (
                    <EmptyState
                      icon={Bookmark}
                      title="Nothing shared yet"
                      hint="Check “shared” when saving a view to surface it for the whole workspace."
                    />
                  )}
                </Card>
              </Section>
            </>
          )}
        </div>
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return toast.error("Name required.");
            create.mutate({
              name: name.trim(),
              shared,
              filters: {
                projectId: filters.projectId || null,
                statusId: filters.statusId || null,
                priority: filters.priority || null,
                query: filters.query.trim() || null,
                view: filters.view,
                includeDone: filters.includeDone,
              },
            });
          }}
          className="space-y-3 p-5"
        >
          <div className="text-sm font-semibold">New saved view</div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Project</label>
              <select
                value={filters.projectId}
                onChange={(e) => setFilters({ ...filters, projectId: e.target.value })}
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Any</option>
                {projects?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Status</label>
              <select
                value={filters.statusId}
                onChange={(e) => setFilters({ ...filters, statusId: e.target.value })}
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Any</option>
                {statuses?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Priority</label>
              <select
                value={filters.priority}
                onChange={(e) =>
                  setFilters({ ...filters, priority: e.target.value as Priority | "" })
                }
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Any</option>
                {PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">View mode</label>
              <select
                value={filters.view}
                onChange={(e) =>
                  setFilters({ ...filters, view: e.target.value as "list" | "board" })
                }
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="list">List</option>
                <option value="board">Kanban</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Query</label>
            <Input
              value={filters.query}
              onChange={(e) => setFilters({ ...filters, query: e.target.value })}
              placeholder="Search text (optional)"
            />
          </div>
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.includeDone}
                onChange={(e) => setFilters({ ...filters, includeDone: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              Include done/canceled
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Shared (visible to everyone in the workspace)
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="ember" disabled={create.isPending}>
              {create.isPending ? "Saving…" : "Save view"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title={`Delete view "${deleteTarget?.name}"?`}
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
