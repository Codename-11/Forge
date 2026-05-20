"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Archive, Save, ChevronLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ArtifactStatus, ArtifactType } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";

const STATUS_OPTIONS: ArtifactStatus[] = [
  ArtifactStatus.DRAFT,
  ArtifactStatus.IN_REVIEW,
  ArtifactStatus.ACCEPTED,
];

const TYPE_OPTIONS: ArtifactType[] = [
  ArtifactType.DOCUMENT,
  ArtifactType.DECISION,
  ArtifactType.RUNBOOK,
  ArtifactType.REPORT,
  ArtifactType.SPEC,
  ArtifactType.BRIEF,
  ArtifactType.VERIFICATION,
];

/**
 * Artifact detail + edit page. View mode shows the rendered body +
 * version history; edit mode swaps to a plain textarea so writers can
 * iterate without a heavy editor dependency. Saves snapshot a new
 * version automatically (see artifact.update mutation).
 */
export default function ArtifactDetailPage() {
  const params = useParams<{ slug: string; artifactSlug: string }>();
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [changelog, setChangelog] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: artifact, isLoading } = trpc.artifact.getBySlug.useQuery({
    slug: params.artifactSlug,
  });

  // When the underlying row hydrates, reset edit drafts so they
  // mirror the latest version. Avoids stale drafts after switching
  // tabs/back.
  useEffect(() => {
    if (artifact && !editing) {
      setDraftBody(artifact.body);
      setDraftTitle(artifact.title);
    }
  }, [artifact, editing]);

  const { data: detail } = trpc.artifact.get.useQuery(
    { id: artifact?.id ?? "" },
    { enabled: Boolean(artifact?.id) },
  );

  const update = trpc.artifact.update.useMutation({
    onSuccess: () => {
      utils.artifact.getBySlug.invalidate({ slug: params.artifactSlug });
      utils.artifact.get.invalidate({ id: artifact?.id ?? "" });
      utils.artifact.list.invalidate();
      setEditing(false);
      setChangelog("");
      toast.success("Saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.artifact.archive.useMutation({
    onSuccess: () => {
      toast.success("Archived");
      utils.artifact.list.invalidate();
      router.push(`/w/${ws.slug}/artifacts`);
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteM = trpc.artifact.delete.useMutation({
    onSuccess: () => {
      toast.success("Artifact deleted");
      utils.artifact.list.invalidate();
      if (artifact?.id) utils.artifact.get.invalidate({ id: artifact.id });
      router.push(`/w/${ws.slug}/artifacts`);
    },
    onError: (e) => toast.error(e.message),
  });

  const ordered = useMemo(
    () => detail?.versions ?? [],
    [detail],
  );

  if (isLoading) {
    return (
      <>
        <Topbar title="Artifact" />
        <div className="p-4">
          <SkeletonList rows={4} />
        </div>
      </>
    );
  }
  if (!artifact) {
    return (
      <>
        <Topbar title="Artifact" />
        <div className="p-4">
          <EmptyState
            variant="page"
            title="Artifact not found"
            description="This artifact may have been archived or moved."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title={artifact.title}
        subtitle={`${artifact.type.toLowerCase()} · ${artifact.status.replace("_", " ").toLowerCase()}`}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/w/${ws.slug}/artifacts`)}
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </Button>
            {editing ? (
              <Button
                size="sm"
                variant="ember"
                onClick={() =>
                  update.mutate({
                    id: artifact.id,
                    title: draftTitle ?? artifact.title,
                    body: draftBody ?? artifact.body,
                    changelog: changelog || undefined,
                  })
                }
                disabled={update.isPending}
              >
                <Save className="h-3.5 w-3.5" /> Save
              </Button>
            ) : (
              <Button size="sm" variant="ember" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_280px]">
        <article className="rounded-lg border border-border bg-card/40 p-4">
          {editing ? (
            <div className="flex flex-col gap-3">
              <input
                value={draftTitle ?? ""}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-lg font-medium"
              />
              <textarea
                value={draftBody ?? ""}
                onChange={(e) => setDraftBody(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    update.mutate({
                      id: artifact.id,
                      title: draftTitle ?? artifact.title,
                      body: draftBody ?? artifact.body,
                      changelog: changelog || undefined,
                    });
                  }
                }}
                rows={20}
                className="w-full min-h-[480px] flex-1 resize-y rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-sm"
              />
              <input
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder="Changelog (optional, attached to new version)"
                className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
              />
            </div>
          ) : (
            <MarkdownWithAttachments body={artifact.body} />
          )}
        </article>

        <aside className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-card/40 p-3 text-meta">
            <div className="mb-2 uppercase tracking-wide text-muted-foreground">Metadata</div>
            <div className="flex flex-col gap-2 text-sm">
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Type</span>
                <select
                  value={artifact.type}
                  onChange={(e) =>
                    update.mutate({ id: artifact.id, type: e.target.value as ArtifactType })
                  }
                  className="rounded-md border border-border bg-card/40 px-2 py-1 text-xs"
                >
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t.toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Status</span>
                <select
                  value={artifact.status}
                  onChange={(e) =>
                    update.mutate({ id: artifact.id, status: e.target.value as ArtifactStatus })
                  }
                  className="rounded-md border border-border bg-card/40 px-2 py-1 text-xs"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {artifact.sourceType ? (
              <div className="mt-3 text-[11px] text-muted-foreground">
                Promoted from {artifact.sourceType.replace("-", " ")}
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-card/40 p-3">
            <div className="mb-2 text-meta uppercase tracking-wide text-muted-foreground">
              History
            </div>
            <ul className="flex flex-col gap-2 text-sm">
              {ordered.map((v) => (
                <li
                  key={v.id}
                  className="flex flex-col rounded-md bg-subtle/40 p-2"
                >
                  <div className="flex items-center justify-between gap-2 text-meta">
                    <span className="font-mono text-id text-muted-foreground">
                      v{v.version}
                    </span>
                    <time className="text-meta text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </time>
                  </div>
                  {v.changelog ? (
                    <p className="text-meta text-muted-foreground">{v.changelog}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="text-warning"
              onClick={() => setArchiveOpen(true)}
              disabled={archive.isPending}
            >
              <Archive className="h-3.5 w-3.5" /> Archive artifact
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteM.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete artifact
            </Button>
          </div>
        </aside>
      </div>

      <Confirm
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive artifact?"
        description="Hides the artifact from active listings. Version history is preserved."
        primaryLabel="Archive artifact"
        variant="destructive"
        loading={archive.isPending}
        onConfirm={() =>
          archive.mutate(
            { id: artifact.id },
            { onSettled: () => setArchiveOpen(false) },
          )
        }
      />

      <Confirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete artifact?"
        description={
          <>
            This permanently removes the artifact and all of its versions.
            Type the artifact&apos;s title to confirm.
          </>
        }
        variant="destructive"
        typeToConfirm={artifact.title}
        primaryLabel="Delete artifact"
        loading={deleteM.isPending}
        onConfirm={() =>
          deleteM.mutate(
            { id: artifact.id, confirm: artifact.title },
            { onSettled: () => setDeleteOpen(false) },
          )
        }
      />
    </>
  );
}
