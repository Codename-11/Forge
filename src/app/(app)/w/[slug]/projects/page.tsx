"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Compass, Folder, Plus } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, Kbd, MOTION, SkeletonCard } from "@/components/ui";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

/// Inline preview count for starter templates surfaced on the empty
/// state. Keep small so the page still feels uncluttered.
const INLINE_TEMPLATE_PREVIEW = 3;

export default function ProjectsPage() {
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data, isLoading } = trpc.project.list.useQuery({ archived: false, limit: 50 });
  const [starterOpen, setStarterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const existingKeys = new Set((data?.items ?? []).map((p) => p.key));
  const isEmpty = data?.items.length === 0;

  // Inline starter previews on the empty state. Only loaded once we
  // know the workspace is empty — no template fetch on first paint
  // when the user already has projects.
  const { data: starters } = trpc.projectTemplate.list.useQuery(undefined, {
    enabled: isEmpty,
  });
  const previewStarters = (starters ?? []).slice(0, INLINE_TEMPLATE_PREVIEW);
  const create = trpc.project.create.useMutation();
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);

  async function quickAddTemplate(s: {
    id: string;
    name: string;
    suggestedKey: string;
    description: string | null;
    color: string | null;
    icon: string | null;
  }) {
    setPendingTemplate(s.id);
    try {
      const project = await create.mutateAsync({
        key: s.suggestedKey,
        name: s.name,
        description: s.description ?? undefined,
        color: s.color ?? undefined,
        icon: s.icon ?? undefined,
      });
      toast.success(`Created ${s.name}.`);
      router.push(`/w/${slug}/projects/${project.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create project.");
    } finally {
      setPendingTemplate(null);
    }
  }

  // Context-aware quick-create hands off to the shared dialog via `?new`.
  // `?templates=1` (e.g. the dashboard "Browse templates" button) opens
  // the starter-templates dialog directly, regardless of project count —
  // templates aren't otherwise reachable once the workspace has projects.
  useEffect(() => {
    if (!searchParams) return;
    const wantsNew = searchParams.has("new");
    const wantsTemplates = searchParams.has("templates");
    if (!wantsNew && !wantsTemplates) return;
    if (wantsNew) setCreateOpen(true);
    if (wantsTemplates) setStarterOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("new");
    params.delete("templates");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  }, [searchParams, pathname, router]);

  return (
    <>
      <Topbar
        title="Projects"
        subtitle={data ? `${data.items.length} active` : undefined}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setStarterOpen(true)}>
              Starter templates
            </Button>
            <Button variant="ember" size="sm" onClick={() => setCreateOpen(true)}>
              New project
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i}>
                <SkeletonCard />
              </li>
            ))}
          </ul>
        ) : isEmpty ? (
          <div className="mx-auto max-w-xl py-10">
            <EmptyState
              variant="page"
              icon={<Folder />}
              title="No projects yet"
              description={
                <span className="block space-y-2">
                  <span className="block">
                    Projects group related issues and roll up to initiatives.
                  </span>
                  <span className="text-meta block text-muted-foreground">
                    Start blank, or kick off from a template. Press <Kbd>⇧C</Kbd> from anywhere to
                    quick-create.
                  </span>
                </span>
              }
              action={
                <>
                  <Button variant="ember" size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-3.5 w-3.5" /> New project
                  </Button>
                  {previewStarters.length === 0 && (starters?.length ?? 0) === 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setStarterOpen(true)}>
                      Browse templates
                    </Button>
                  )}
                </>
              }
            />
            {previewStarters.length > 0 && (
              <div className="mt-6 space-y-2">
                <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  Starter templates
                </div>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {previewStarters.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        disabled={pendingTemplate === s.id}
                        onClick={() => quickAddTemplate(s)}
                        className={cn(
                          "block w-full rounded-lg border border-border bg-card/40 p-3 text-left",
                          "hover:border-ember/40 disabled:opacity-50",
                          MOTION.base,
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="inline-block h-2.5 w-2.5 rounded-sm"
                            style={{ backgroundColor: s.color ?? "#78716c" }}
                          />
                          {s.icon && <span aria-hidden="true">{s.icon}</span>}
                          <span className="truncate text-sm font-medium">{s.name}</span>
                          <span className="text-id ml-auto text-muted-foreground">
                            {s.suggestedKey}
                          </span>
                        </div>
                        {s.description && (
                          <p className="text-meta mt-1 line-clamp-2 text-muted-foreground">
                            {s.description}
                          </p>
                        )}
                        <p className="text-meta mt-2 text-muted-foreground">
                          {pendingTemplate === s.id ? "Adding…" : "Tap to add →"}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
                {(starters?.length ?? 0) > previewStarters.length && (
                  <div className="text-right">
                    <button
                      type="button"
                      onClick={() => setStarterOpen(true)}
                      className="text-meta text-muted-foreground hover:text-ember"
                    >
                      See all {starters?.length} templates →
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {(data?.items ?? []).map((p) => (
              <li key={p.id}>
                <Link
                  href={`/w/${slug}/projects/${p.id}`}
                  className={cn(
                    "block rounded-lg border border-border bg-card/40 p-4 hover:border-ember/40",
                    MOTION.base,
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded-sm"
                      style={{ backgroundColor: p.color ?? "#78716c" }}
                    />
                    <span className="text-id text-muted-foreground">{p.key}</span>
                    <span className="text-meta ml-auto text-muted-foreground">
                      {p._count.issues} issues
                    </span>
                  </div>
                  <div className="mt-2 text-sm font-medium">
                    {p.icon && <span className="mr-1">{p.icon}</span>}
                    {p.name}
                  </div>
                  {p.description && (
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {p.description}
                    </div>
                  )}
                  {p._count.issues > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <div className="text-meta flex items-center justify-between text-muted-foreground">
                        <span>Progress</span>
                        <span>
                          {p._count.doneIssues}/{p._count.issues} done
                        </span>
                      </div>
                      <div
                        className="h-1 w-full overflow-hidden rounded-full bg-subtle"
                        role="progressbar"
                        aria-label={`${p.name} completion`}
                        aria-valuemin={0}
                        aria-valuemax={p._count.issues}
                        aria-valuenow={p._count.doneIssues}
                      >
                        <div
                          className="h-full rounded-full bg-ember"
                          style={{
                            width: `${Math.round((p._count.doneIssues / p._count.issues) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                  <div className="text-meta mt-3 flex items-center gap-2 text-muted-foreground">
                    <span>Updated {relativeTime(p.updatedAt)}</span>
                    {p.initiative && (
                      <span className="inline-flex items-center gap-1 truncate">
                        <Compass className="h-3 w-3 shrink-0" />
                        <span className="truncate">{p.initiative.name}</span>
                      </span>
                    )}
                    {p.archived && <Badge>archived</Badge>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <StarterDialog
        open={starterOpen}
        onClose={() => setStarterOpen(false)}
        existingKeys={existingKeys}
        onCreated={(project) => router.push(`/w/${slug}/projects/${project.id}`)}
      />
      <NewProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(project) => router.push(`/w/${slug}/projects/${project.id}`)}
      />
    </>
  );
}

function StarterDialog({
  open,
  onClose,
  existingKeys,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  existingKeys: Set<string>;
  onCreated: (project: { id: string }) => void;
}) {
  const { slug } = useWorkspace();
  const { data: starters } = trpc.projectTemplate.list.useQuery(undefined, { enabled: open });
  const create = trpc.project.create.useMutation();
  const [pending, setPending] = useState<string | null>(null);

  async function addOne(s: {
    id: string;
    name: string;
    suggestedKey: string;
    description: string | null;
    color: string | null;
    icon: string | null;
  }) {
    setPending(s.id);
    try {
      const project = await create.mutateAsync({
        key: s.suggestedKey,
        name: s.name,
        description: s.description ?? undefined,
        color: s.color ?? undefined,
        icon: s.icon ?? undefined,
      });
      toast.success(`Created ${s.name}.`);
      onCreated(project);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create project.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <div className="space-y-4 p-5">
        <div>
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-semibold">Starter templates</div>
            <Link
              href={`/w/${slug}/settings/project-templates`}
              className="text-[0.6875rem] text-muted-foreground hover:text-ember"
            >
              Manage templates →
            </Link>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose a prepared starting point. You can customize it after creation.
          </p>
        </div>
        <ul className="space-y-2">
          {(starters ?? []).map((s) => {
            const already = existingKeys.has(s.suggestedKey);
            return (
              <li
                key={s.id}
                className="flex items-start gap-3 rounded-md border border-border bg-card/40 p-3"
              >
                <span
                  className="mt-0.5 inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: s.color ?? "#78716c" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {s.icon && <span>{s.icon}</span>}
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-id text-muted-foreground">{s.suggestedKey}</span>
                  </div>
                  {s.description && (
                    <div className="text-meta mt-0.5 text-muted-foreground">{s.description}</div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={already ? "ghost" : "ember"}
                  disabled={already || pending === s.id}
                  onClick={() => addOne(s)}
                >
                  {already ? "Exists" : pending === s.id ? "Adding…" : "Add"}
                </Button>
              </li>
            );
          })}
          {starters?.length === 0 && (
            <li className="text-meta py-8 text-center text-muted-foreground">
              No templates defined. Create some in Settings.
            </li>
          )}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
