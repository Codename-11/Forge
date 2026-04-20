"use client";
import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { InitiativeStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

export default function InitiativeDetailPage({
  params,
}: {
  params: Promise<{ initiativeSlug: string }>;
}) {
  // Route segment is `[initiativeSlug]` to avoid colliding with the
  // outer workspace `[slug]` param. Workspace is read from context.
  const { initiativeSlug } = use(params);
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();

  // No `getBySlug` on the router — list and find. Cheap: one workspace.
  const { data: list, isLoading } = trpc.initiative.list.useQuery({});
  const initiative = useMemo(
    () => list?.find((i) => i.slug === initiativeSlug) ?? null,
    [list, initiativeSlug],
  );

  const { data: detail } = trpc.initiative.get.useQuery(
    { id: initiative?.id ?? "" },
    { enabled: !!initiative },
  );

  const { data: projects } = trpc.project.list.useQuery(
    { archived: false, limit: 100 },
  );

  const { data: rolledIssues } = trpc.issue.list.useQuery(
    { initiativeId: initiative?.id, includeDone: true, limit: 200 },
    { enabled: !!initiative },
  );

  const { data: currentCycle } = trpc.cycle.current.useQuery();

  const update = trpc.initiative.update.useMutation({
    onSuccess: () => {
      utils.initiative.list.invalidate();
      utils.initiative.get.invalidate();
      toast.success("Saved.");
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.initiative.archive.useMutation({
    onSuccess: () => {
      utils.initiative.list.invalidate();
      toast.success("Archived.");
      router.push(`/w/${ws.slug}/initiatives`);
    },
    onError: (e) => toast.error(e.message),
  });

  const link = trpc.initiative.linkProject.useMutation({
    onSuccess: () => {
      utils.initiative.get.invalidate();
      utils.project.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const unlink = trpc.initiative.unlinkProject.useMutation({
    onSuccess: () => {
      utils.initiative.get.invalidate();
      utils.project.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);

  const stats = useMemo(() => {
    const items = rolledIssues?.items ?? [];
    const done = items.filter(
      (i) =>
        i.status.category === "DONE" || i.status.category === "CANCELED",
    ).length;
    return { total: items.length, done };
  }, [rolledIssues]);

  // Server-filtered: issues under this initiative that are also in the
  // currently-active cycle. Used for the "in current cycle" callout.
  const { data: upcomingInCycle } = trpc.issue.list.useQuery(
    {
      initiativeId: initiative?.id,
      cycleId: currentCycle?.id ?? undefined,
      includeDone: true,
      limit: 50,
    },
    { enabled: !!initiative && !!currentCycle },
  );

  if (isLoading) {
    return (
      <div className="p-4">
        <SkeletonList rows={6} />
      </div>
    );
  }
  if (!initiative) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          variant="page"
          title="Initiative not found"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/w/${ws.slug}/initiatives`)}
            >
              Back to initiatives
            </Button>
          }
        />
      </div>
    );
  }

  const linkedProjects = detail?.projects ?? [];
  const linkedIds = new Set(linkedProjects.map((p) => p.id));
  const completion =
    stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100);

  return (
    <>
      <Topbar
        title={
          <span className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: initiative.color ?? "#78716c" }}
            />
            {initiative.name}
          </span>
        }
        subtitle={initiative.slug}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={initiative.status === InitiativeStatus.COMPLETED}
              onClick={() => setArchiveOpen(true)}
            >
              Archive
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/w/${ws.slug}/initiatives`)}
            >
              All initiatives
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          <header className="space-y-2">
            {editingName ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (nameDraft.trim() && nameDraft !== initiative.name)
                    update.mutate({ id: initiative.id, name: nameDraft.trim() });
                  setEditingName(false);
                }}
              >
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => setEditingName(false)}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-xl font-semibold tracking-tight"
                />
              </form>
            ) : (
              <h1
                className="cursor-text rounded-md px-1 py-0.5 text-xl font-semibold tracking-tight hover:bg-subtle/60"
                onClick={() => {
                  setNameDraft(initiative.name);
                  setEditingName(true);
                }}
                title="Click to edit"
              >
                {initiative.name}
              </h1>
            )}
            {editingDesc ? (
              <div className="space-y-2">
                <textarea
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  rows={4}
                  className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ember"
                    onClick={() => {
                      update.mutate({
                        id: initiative.id,
                        description: descDraft.trim() || null,
                      });
                      setEditingDesc(false);
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingDesc(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p
                className="cursor-text whitespace-pre-wrap rounded-md px-1 py-0.5 text-sm text-foreground/80 hover:bg-subtle/40"
                onClick={() => {
                  setDescDraft(initiative.description ?? "");
                  setEditingDesc(true);
                }}
                title="Click to edit"
              >
                {initiative.description || (
                  <span className="text-muted-foreground">
                    No description. Click to add.
                  </span>
                )}
              </p>
            )}
          </header>

          <section className="rounded-lg border border-border bg-card/40 p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Rollup
            </h2>
            <div className="mt-2 grid grid-cols-4 gap-4">
              <Stat label="Projects" value={linkedProjects.length} />
              <Stat label="Issues" value={stats.total} />
              <Stat label="Done" value={stats.done} />
              <Stat label="Completion" value={`${completion}%`} />
            </div>
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-subtle">
              <div
                className="h-full rounded-full bg-ember"
                style={{
                  width: `${completion}%`,
                  backgroundColor: initiative.color ?? undefined,
                }}
              />
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Linked projects</h2>
              <span className="text-[11px] text-muted-foreground">
                {linkedProjects.length} linked
              </span>
            </div>
            <div className="space-y-2">
              <ul className="divide-y divide-border rounded-lg border border-border bg-card/40">
                {linkedProjects.length === 0 && (
                  <li className="p-4 text-center text-[11px] text-muted-foreground">
                    No linked projects. Use the picker below to attach one.
                  </li>
                )}
                {linkedProjects.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 px-3 py-2 text-xs"
                  >
                    <span
                      className="inline-block h-3 w-3 rounded-sm"
                      style={{ backgroundColor: p.color ?? "#78716c" }}
                    />
                    <Link
                      href={`/w/${ws.slug}/projects/${p.id}`}
                      className="min-w-0 flex-1 truncate hover:text-ember"
                    >
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {p.key}
                      </span>{" "}
                      {p.name}
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => unlink.mutate({ projectId: p.id })}
                    >
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
              <LinkProjectPicker
                projects={(projects?.items ?? []).filter(
                  (p) => !linkedIds.has(p.id),
                )}
                onPick={(projectId) =>
                  link.mutate({ initiativeId: initiative.id, projectId })
                }
              />
            </div>
          </section>

          {currentCycle && (upcomingInCycle?.items.length ?? 0) > 0 && (
            <section>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">
                  In current cycle ({currentCycle.name})
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  {upcomingInCycle?.items.length ?? 0} issue
                  {(upcomingInCycle?.items.length ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card/40">
                {(upcomingInCycle?.items ?? []).map((i) => (
                  <li key={i.id}>
                    <Link
                      href={`/w/${ws.slug}/issues/${i.id}`}
                      className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle/60"
                    >
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {ws.key}-{i.number}
                      </span>
                      <span className="truncate">{i.title}</span>
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {i.status.name}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      <Confirm
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive "${initiative.name}"?`}
        description="It's moved out of the active list. You can restore it later from Settings."
        primaryLabel="Archive"
        loading={archive.isPending}
        onConfirm={async () => {
          await archive.mutateAsync({ id: initiative.id });
          setArchiveOpen(false);
        }}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}

function LinkProjectPicker({
  projects,
  onPick,
}: {
  projects: Array<{ id: string; key: string; name: string; color: string | null }>;
  onPick: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = projects.filter((p) => {
    const q = query.toLowerCase();
    return (
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.key.toLowerCase().includes(q)
    );
  });

  return (
    <div className="rounded-lg border border-dashed border-border bg-card/20 p-3">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find project to link…"
          className="h-7 text-xs"
        />
      </div>
      {query && (
        <ul className="mt-2 max-h-56 overflow-y-auto">
          {filtered.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(p.id);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-subtle"
              >
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: p.color ?? "#78716c" }}
                />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {p.key}
                </span>
                <span className="truncate">{p.name}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-2 py-2 text-[11px] text-muted-foreground">
              No matches.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
