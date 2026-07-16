"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Archive,
  Save,
  ChevronLeft,
  Trash2,
  Check,
  MessageSquare,
  RotateCcw,
  Send,
  Share2,
  ExternalLink,
  Columns2,
  Code2,
  Eye,
  Maximize2,
  Minimize2,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { ArtifactRole, ArtifactStatus, ArtifactType } from "@prisma/client";
import type { ArtifactVisibility } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";

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
  const [viewVersionId, setViewVersionId] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [grantPrincipal, setGrantPrincipal] = useState("");
  const [grantRole, setGrantRole] = useState<ArtifactRole>(ArtifactRole.COMMENTER);
  const [compareFromId, setCompareFromId] = useState("");
  const [compareToId, setCompareToId] = useState("");
  const [editorMode, setEditorMode] = useState<"source" | "preview" | "split">("split");
  const [focusMode, setFocusMode] = useState(false);

  const { data: artifact, isLoading } = trpc.artifact.getBySlug.useQuery({
    slug: params.artifactSlug,
  });

  // When the underlying row hydrates, reset edit drafts so they
  // mirror the latest version. Avoids stale drafts after switching
  // tabs/back.
  useEffect(() => {
    if (artifact && !editing) {
      const saved = window.localStorage.getItem(`forge:artifact-draft:${artifact.id}`);
      if (saved) {
        try {
          const recovered = JSON.parse(saved) as {
            body: string;
            title: string;
            baseVersionId: string | null;
          };
          if (
            recovered.baseVersionId === artifact.currentVersionId &&
            (recovered.body !== artifact.body || recovered.title !== artifact.title)
          ) {
            setDraftBody(recovered.body);
            setDraftTitle(recovered.title);
            toast.info("Recovered an unsaved local draft.");
            return;
          }
        } catch {
          /* discard malformed local recovery state */
        }
      }
      setDraftBody(artifact.body);
      setDraftTitle(artifact.title);
    }
  }, [artifact, editing]);

  useEffect(() => {
    if (!editing || !artifact || draftBody === null || draftTitle === null) return;
    window.localStorage.setItem(
      `forge:artifact-draft:${artifact.id}`,
      JSON.stringify({
        body: draftBody,
        title: draftTitle,
        baseVersionId: artifact.currentVersionId,
      }),
    );
  }, [artifact, draftBody, draftTitle, editing]);

  const { data: detail } = trpc.artifact.get.useQuery(
    { id: artifact?.id ?? "" },
    { enabled: Boolean(artifact?.id) },
  );
  const { data: viewedVersion } = trpc.artifact.getVersion.useQuery(
    { artifactId: artifact?.id ?? "", versionId: viewVersionId ?? "" },
    { enabled: Boolean(artifact?.id && viewVersionId) },
  );
  const { data: comparison } = trpc.artifact.compareVersions.useQuery(
    { artifactId: artifact?.id ?? "", fromVersionId: compareFromId, toVersionId: compareToId },
    {
      enabled: Boolean(
        artifact?.id && compareFromId && compareToId && compareFromId !== compareToId,
      ),
    },
  );
  const { data: comments } = trpc.artifact.listComments.useQuery(
    { artifactId: artifact?.id ?? "", includeResolved: true },
    { enabled: Boolean(artifact?.id) },
  );
  const { data: members } = trpc.workspace.members.useQuery();
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const { data: grants } = trpc.artifact.listGrants.useQuery(
    { artifactId: artifact?.id ?? "" },
    { enabled: Boolean(artifact?.id && detail?.effectiveRole === ArtifactRole.OWNER) },
  );

  const refreshArtifact = async () => {
    await Promise.all([
      utils.artifact.getBySlug.invalidate({ slug: params.artifactSlug }),
      utils.artifact.get.invalidate({ id: artifact?.id ?? "" }),
      utils.artifact.list.invalidate(),
      artifact?.id
        ? utils.artifact.listComments.invalidate({ artifactId: artifact.id, includeResolved: true })
        : Promise.resolve(),
      artifact?.id
        ? utils.artifact.listGrants.invalidate({ artifactId: artifact.id })
        : Promise.resolve(),
    ]);
  };

  const update = trpc.artifact.update.useMutation({
    onSuccess: () => {
      void refreshArtifact();
      setEditing(false);
      setFocusMode(false);
      setChangelog("");
      if (artifact?.id) window.localStorage.removeItem(`forge:artifact-draft:${artifact.id}`);
      toast.success("Saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const workflowMutationOptions = (message: string) => ({
    onSuccess: () => {
      toast.success(message);
      void refreshArtifact();
    },
    onError: (error: { message: string }) => toast.error(error.message),
  });
  const requestReview = trpc.artifact.requestReview.useMutation(
    workflowMutationOptions("Review requested"),
  );
  const acceptVersion = trpc.artifact.acceptVersion.useMutation(
    workflowMutationOptions("Version accepted"),
  );
  const requestChanges = trpc.artifact.requestChanges.useMutation(
    workflowMutationOptions("Changes requested"),
  );
  const restoreVersion = trpc.artifact.restoreVersion.useMutation({
    ...workflowMutationOptions("Historical version restored as a new revision"),
    onSuccess: () => {
      setViewVersionId(null);
      toast.success("Historical version restored as a new revision");
      void refreshArtifact();
    },
  });
  const publishVersion = trpc.artifact.publishVersion.useMutation({
    onSuccess: async (result) => {
      if (result.token) {
        const url = `${window.location.origin}/shared/artifacts/${result.token}`;
        const copied = await copyToClipboard(url);
        if (copied) toast.success("Share link copied. It will not be shown again.");
        else toast.success(`Share link created: ${url}`, { duration: 20_000 });
      } else toast.success("Version published");
      void refreshArtifact();
    },
    onError: (error) => toast.error(error.message),
  });
  const revokePublication = trpc.artifact.revokePublication.useMutation(
    workflowMutationOptions("Share link revoked"),
  );
  const deployPreview = trpc.artifact.deployPreview.useMutation(
    workflowMutationOptions("Deployed to Artifact Preview"),
  );
  const setVisibility = trpc.artifact.setVisibility.useMutation(
    workflowMutationOptions("Visibility updated"),
  );
  const addComment = trpc.artifact.addComment.useMutation({
    onSuccess: () => {
      setCommentBody("");
      toast.success("Comment added");
      void refreshArtifact();
    },
    onError: (error) => toast.error(error.message),
  });
  const resolveComment = trpc.artifact.resolveComment.useMutation(
    workflowMutationOptions("Comment updated"),
  );
  const setGrant = trpc.artifact.setGrant.useMutation({
    onSuccess: () => {
      setGrantPrincipal("");
      toast.success("Artifact access updated");
      void refreshArtifact();
    },
    onError: (error) => toast.error(error.message),
  });
  const removeGrant = trpc.artifact.removeGrant.useMutation(
    workflowMutationOptions("Artifact access removed"),
  );
  const exportVersion = trpc.artifact.exportVersion.useMutation({
    onSuccess: (result) => {
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Artifact version exported");
    },
    onError: (error) => toast.error(error.message),
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

  const ordered = useMemo(() => detail?.versions ?? [], [detail]);
  const effectiveRole = detail?.effectiveRole;
  const canComment =
    effectiveRole === ArtifactRole.COMMENTER ||
    effectiveRole === ArtifactRole.EDITOR ||
    effectiveRole === ArtifactRole.OWNER;
  const canEdit = effectiveRole === ArtifactRole.EDITOR || effectiveRole === ArtifactRole.OWNER;
  const canOwn = effectiveRole === ArtifactRole.OWNER;
  const canDelete = ws.role === "OWNER" || ws.role === "ADMIN";

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
              <>
                <Button size="sm" variant="ghost" onClick={() => setFocusMode((value) => !value)}>
                  {focusMode ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}{" "}
                  {focusMode ? "Exit focus" : "Focus"}
                </Button>
                <Button
                  size="sm"
                  variant="ember"
                  onClick={() =>
                    update.mutate({
                      id: artifact.id,
                      title: draftTitle ?? artifact.title,
                      body: draftBody ?? artifact.body,
                      changelog: changelog || undefined,
                      baseVersionId: artifact.currentVersionId,
                    })
                  }
                  disabled={update.isPending}
                >
                  <Save className="h-3.5 w-3.5" /> Save
                </Button>
              </>
            ) : canEdit ? (
              <Button size="sm" variant="ember" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
          </>
        }
      />

      <div
        className={`grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 ${focusMode ? "" : "lg:grid-cols-[1fr_280px]"}`}
      >
        <article className="rounded-lg border border-border bg-card/40 p-4">
          {editing ? (
            <div className="flex flex-col gap-3">
              <input
                value={draftTitle ?? ""}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-lg font-medium"
              />
              <div
                className="flex items-center gap-1 rounded-md border border-border bg-subtle/30 p-1"
                role="tablist"
                aria-label="Editor view"
              >
                {(
                  [
                    ["source", Code2],
                    ["preview", Eye],
                    ["split", Columns2],
                  ] as const
                ).map(([mode, Icon]) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={editorMode === mode}
                    onClick={() => setEditorMode(mode)}
                    className={`focus-ring inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${editorMode === mode ? "bg-card text-foreground" : "text-muted-foreground"}`}
                  >
                    <Icon className="h-3.5 w-3.5" /> {mode}
                  </button>
                ))}
                <span className="text-meta ml-auto px-2 text-muted-foreground">
                  {(draftBody ?? "").length.toLocaleString()} characters · locally recovered
                </span>
              </div>
              <div className={editorMode === "split" ? "grid gap-3 lg:grid-cols-2" : ""}>
                {editorMode !== "preview" ? (
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
                          baseVersionId: artifact.currentVersionId,
                        });
                      }
                    }}
                    rows={20}
                    className="min-h-[560px] w-full flex-1 resize-y rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-sm"
                  />
                ) : null}
                {editorMode !== "source" ? (
                  <div className="min-h-[560px] overflow-auto rounded-md border border-border bg-background p-4">
                    <MarkdownWithAttachments body={draftBody ?? ""} />
                  </div>
                ) : null}
              </div>
              <input
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder="Changelog (optional, attached to new version)"
                className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
              />
            </div>
          ) : (
            <>
              {comparison ? (
                <section
                  className="mb-5 rounded-lg border border-border"
                  aria-label="Version comparison"
                >
                  <div className="border-b border-border px-3 py-2 text-sm font-medium">
                    Comparing v{comparison.from.version} → v{comparison.to.version}
                  </div>
                  {comparison.kind === "text" ? (
                    <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5">
                      {comparison.changes.map((change, index) => (
                        <span
                          key={index}
                          className={
                            change.added
                              ? "block bg-success/10 text-success"
                              : change.removed
                                ? "bg-destructive/10 text-destructive block"
                                : "block text-muted-foreground"
                          }
                        >
                          {change.value
                            .split("\n")
                            .map((line, lineIndex, lines) =>
                              lineIndex < lines.length - 1
                                ? `${change.added ? "+" : change.removed ? "−" : " "} ${line}\n`
                                : line,
                            )}
                        </span>
                      ))}
                    </pre>
                  ) : (
                    <div className="p-3 text-sm text-muted-foreground">
                      Binary/non-text comparison: {comparison.from.contentChecksum ?? "no checksum"}{" "}
                      → {comparison.to.contentChecksum ?? "no checksum"}
                    </div>
                  )}
                </section>
              ) : null}
              {viewedVersion ? (
                <div className="mb-4 flex items-center justify-between rounded-md border border-ember/30 bg-ember/10 px-3 py-2 text-sm">
                  <span>Viewing immutable v{viewedVersion.version}</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setViewVersionId(null)}>
                      Current
                    </Button>
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          restoreVersion.mutate({
                            artifactId: artifact.id,
                            versionId: viewedVersion.id,
                            baseVersionId: artifact.currentVersionId,
                          })
                        }
                        disabled={restoreVersion.isPending}
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Restore as new
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <MarkdownWithAttachments body={viewedVersion?.body ?? artifact.body} />
            </>
          )}
        </article>

        <aside className={focusMode ? "hidden" : "flex flex-col gap-3"}>
          <div className="text-meta rounded-lg border border-border bg-card/40 p-3">
            <div className="mb-2 uppercase tracking-wide text-muted-foreground">Metadata</div>
            <div className="flex flex-col gap-2 text-sm">
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Type</span>
                <select
                  value={artifact.type}
                  disabled={!canEdit}
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
                <span className="text-muted-foreground">Visibility</span>
                <select
                  value={artifact.visibility}
                  disabled={!canOwn}
                  onChange={(e) =>
                    setVisibility.mutate({
                      id: artifact.id,
                      visibility: e.target.value as ArtifactVisibility,
                    })
                  }
                  className="rounded-md border border-border bg-card/40 px-2 py-1 text-xs"
                >
                  <option value="PRIVATE">private</option>
                  <option value="WORKSPACE">workspace</option>
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
            <div className="text-meta mb-2 uppercase tracking-wide text-muted-foreground">
              History
            </div>
            {ordered.length > 1 ? (
              <div className="mb-2 grid grid-cols-2 gap-1">
                <select
                  value={compareFromId}
                  onChange={(event) => setCompareFromId(event.target.value)}
                  aria-label="Compare from version"
                  className="min-w-0 rounded border border-border bg-background px-1 py-1 text-xs"
                >
                  <option value="">From…</option>
                  {ordered.map((version) => (
                    <option key={version.id} value={version.id}>
                      v{version.version}
                    </option>
                  ))}
                </select>
                <select
                  value={compareToId}
                  onChange={(event) => setCompareToId(event.target.value)}
                  aria-label="Compare to version"
                  className="min-w-0 rounded border border-border bg-background px-1 py-1 text-xs"
                >
                  <option value="">To…</option>
                  {ordered.map((version) => (
                    <option key={version.id} value={version.id}>
                      v{version.version}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <ul className="flex flex-col gap-2 text-sm">
              {ordered.map((v) => (
                <li key={v.id} className="flex flex-col rounded-md bg-subtle/40 p-2">
                  <button
                    type="button"
                    className="text-meta flex items-center justify-between gap-2 text-left"
                    onClick={() => setViewVersionId(v.id)}
                  >
                    <span className="text-id font-mono text-muted-foreground">
                      v{v.version}
                      {v.id === artifact.acceptedVersionId ? " · accepted" : ""}
                      {v.id === artifact.publishedVersionId ? " · published" : ""}
                    </span>
                    <time className="text-meta text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </time>
                  </button>
                  {v.changelog ? (
                    <p className="text-meta text-muted-foreground">{v.changelog}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-card/40 p-3">
            <div className="text-meta mb-2 uppercase tracking-wide text-muted-foreground">
              Workflow
            </div>
            <div className="flex flex-col gap-2">
              {canEdit && artifact.status !== ArtifactStatus.IN_REVIEW ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => requestReview.mutate({ id: artifact.id })}
                  disabled={requestReview.isPending}
                >
                  <Send className="h-3.5 w-3.5" /> Request review
                </Button>
              ) : null}
              {canOwn && artifact.status === ArtifactStatus.IN_REVIEW ? (
                <>
                  <Button
                    size="sm"
                    variant="ember"
                    onClick={() => acceptVersion.mutate({ id: artifact.id })}
                    disabled={acceptVersion.isPending}
                  >
                    <Check className="h-3.5 w-3.5" /> Accept current version
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => requestChanges.mutate({ id: artifact.id })}
                    disabled={requestChanges.isPending}
                  >
                    Request changes
                  </Button>
                </>
              ) : null}
              {canOwn && artifact.acceptedVersionId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    publishVersion.mutate({
                      id: artifact.id,
                      versionId: artifact.acceptedVersionId!,
                    })
                  }
                  disabled={publishVersion.isPending}
                >
                  <Share2 className="h-3.5 w-3.5" /> Create expiring share link
                </Button>
              ) : null}
              {canOwn && artifact.publishedVersionId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    deployPreview.mutate({
                      id: artifact.id,
                      versionId: artifact.publishedVersionId!,
                    })
                  }
                  disabled={deployPreview.isPending}
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Deploy preview
                </Button>
              ) : null}
              {canOwn
                ? detail?.publications
                    .filter((publication) => publication.status === "ACTIVE")
                    .map((publication) => (
                      <Button
                        key={publication.id}
                        size="sm"
                        variant="ghost"
                        className="text-warning"
                        onClick={() =>
                          revokePublication.mutate({
                            artifactId: artifact.id,
                            publicationId: publication.id,
                          })
                        }
                      >
                        Revoke link ·{" "}
                        {publication.tokenPrefix ?? publication.audience.toLowerCase()}
                      </Button>
                    ))
                : null}
              {detail?.deployments[0]?.externalUrl && detail.deployments[0].status === "READY" ? (
                <a
                  className="text-meta text-ember hover:underline"
                  href={detail.deployments[0].externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open latest preview
                </a>
              ) : null}
              {artifact.currentVersionId ? (
                <div className="grid grid-cols-2 gap-1">
                  {(["markdown", "html"] as const).map((format) => (
                    <Button
                      key={format}
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        exportVersion.mutate({
                          artifactId: artifact.id,
                          versionId: viewVersionId ?? artifact.currentVersionId!,
                          format,
                        })
                      }
                      disabled={exportVersion.isPending}
                    >
                      <Download className="h-3.5 w-3.5" />{" "}
                      {format === "markdown" ? "Markdown" : "HTML"}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card/40 p-3">
            <div className="text-meta mb-2 flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" /> Comments
            </div>
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
              {comments?.map((comment) => (
                <div key={comment.id} className="rounded-md bg-subtle/40 p-2 text-sm">
                  <div className="text-meta flex items-center justify-between gap-2 text-muted-foreground">
                    <span>{comment.author?.name ?? comment.authoringAgent?.name ?? "Unknown"}</span>
                    {canEdit ? (
                      <button
                        type="button"
                        className="hover:text-foreground"
                        onClick={() =>
                          resolveComment.mutate({
                            artifactId: artifact.id,
                            commentId: comment.id,
                            resolved: comment.status !== "RESOLVED",
                          })
                        }
                      >
                        {comment.status === "RESOLVED" ? "Reopen" : "Resolve"}
                      </button>
                    ) : null}
                  </div>
                  <p
                    className={
                      comment.status === "RESOLVED"
                        ? "mt-1 text-muted-foreground line-through"
                        : "mt-1"
                    }
                  >
                    {comment.body}
                  </p>
                </div>
              ))}
            </div>
            {canComment ? (
              <>
                <textarea
                  value={commentBody}
                  onChange={(event) => setCommentBody(event.target.value)}
                  placeholder="Comment on this artifact…"
                  rows={3}
                  className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1"
                  disabled={!commentBody.trim() || addComment.isPending}
                  onClick={() =>
                    addComment.mutate({
                      artifactId: artifact.id,
                      versionId: viewVersionId ?? artifact.currentVersionId ?? undefined,
                      body: commentBody,
                    })
                  }
                >
                  Comment
                </Button>
              </>
            ) : null}
          </div>

          {canOwn ? (
            <div className="rounded-lg border border-border bg-card/40 p-3">
              <div className="text-meta mb-2 uppercase tracking-wide text-muted-foreground">
                Collaborators
              </div>
              <div className="flex flex-col gap-2">
                {grants?.map((grant) => (
                  <div key={grant.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">
                      {grant.user?.name ?? grant.user?.email ?? grant.agent?.name ?? "Unknown"} ·{" "}
                      {grant.role.toLowerCase()}
                    </span>
                    <button
                      type="button"
                      className="text-meta text-warning hover:text-foreground"
                      onClick={() =>
                        removeGrant.mutate({ artifactId: artifact.id, grantId: grant.id })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <select
                  value={grantPrincipal}
                  onChange={(event) => setGrantPrincipal(event.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">Add a person or agent…</option>
                  {members
                    ?.filter((member) => member.user.id !== artifact.createdById)
                    .map((member) => (
                      <option key={member.user.id} value={`user:${member.user.id}`}>
                        {member.user.name ?? member.user.email}
                      </option>
                    ))}
                  {agents?.map((agent) => (
                    <option key={agent.id} value={`agent:${agent.id}`}>
                      {agent.name} (agent)
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <select
                    value={grantRole}
                    onChange={(event) => setGrantRole(event.target.value as ArtifactRole)}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="VIEWER">Viewer</option>
                    <option value="COMMENTER">Commenter</option>
                    <option value="EDITOR">Editor</option>
                    <option value="OWNER">Owner</option>
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!grantPrincipal || setGrant.isPending}
                    onClick={() => {
                      const [kind, id] = grantPrincipal.split(":");
                      if (!id) return;
                      setGrant.mutate({
                        artifactId: artifact.id,
                        role: grantRole,
                        ...(kind === "user" ? { userId: id } : { agentId: id }),
                      });
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            {canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-warning"
                onClick={() => setArchiveOpen(true)}
                disabled={archive.isPending}
              >
                <Archive className="h-3.5 w-3.5" /> Archive artifact
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={deleteM.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete artifact
              </Button>
            ) : null}
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
          archive.mutate({ id: artifact.id }, { onSettled: () => setArchiveOpen(false) })
        }
      />

      <Confirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete artifact?"
        description={
          <>
            This permanently removes the artifact and all of its versions. Type the artifact&apos;s
            title to confirm.
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

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  }
}
