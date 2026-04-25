"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Folder, Plus } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, Kbd, MOTION, SkeletonCard } from "@/components/ui";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

export default function ProjectsPage() {
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data, isLoading, refetch } = trpc.project.list.useQuery({ archived: false, limit: 50 });
  const [starterOpen, setStarterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const existingKeys = new Set((data?.items ?? []).map((p) => p.key));
  const isEmpty = data?.items.length === 0;

  // Context-aware quick-create hands off to the shared dialog via `?new`.
  useEffect(() => {
    if (searchParams?.has("new")) {
      setCreateOpen(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("new");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
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
          <EmptyState
            variant="page"
            icon={<Folder />}
            title="No projects yet"
            description={
              <span>
                Start from scratch, or pick from the suggested starter
                templates. Press <Kbd>⇧C</Kbd> from anywhere to quick-create.
              </span>
            }
            action={
              <>
                <Button variant="ember" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-3.5 w-3.5" /> New project
                </Button>
                <Button variant="outline" size="sm" onClick={() => setStarterOpen(true)}>
                  Browse templates
                </Button>
              </>
            }
          />
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
                    <span className="ml-auto text-[11px] text-muted-foreground">
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
                  <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>Updated {relativeTime(p.updatedAt)}</span>
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
        onCreated={() => refetch()}
      />
      <NewProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => refetch()}
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
  onCreated: () => void;
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
      await create.mutateAsync({
        key: s.suggestedKey,
        name: s.name,
        description: s.description ?? undefined,
        color: s.color ?? undefined,
        icon: s.icon ?? undefined,
      });
      toast.success(`Created ${s.name}.`);
      onCreated();
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
              className="text-[11px] text-muted-foreground hover:text-ember"
            >
              Manage templates →
            </Link>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Managed in Settings. Each row below invokes the standard project.create API.
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
                    <span className="text-id text-muted-foreground">
                      {s.suggestedKey}
                    </span>
                  </div>
                  {s.description && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{s.description}</div>
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
            <li className="py-8 text-center text-[11px] text-muted-foreground">
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

