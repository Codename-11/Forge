"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Paperclip,
  Upload,
  Link2,
  FileText,
  File as FileIcon,
  ExternalLink,
  Trash2,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { isSafeExternalUrl } from "@/lib/url-safety";
import { useWorkspace } from "@/hooks/use-workspace";
import { useAttachmentLightbox } from "@/components/attachments/attachment-lightbox";
import { LinkFavicon } from "@/components/attachments/attachment-chip";

/**
 * tRPC error shape we care about for the misconfig banner. We can't
 * import the server enum into a client component, so we sniff on
 * `data.code` like the rest of the UI does.
 */
type TrpcErrorLike = {
  message?: string;
  data?: { code?: string } | null;
};

/**
 * Detect a "storage not configured" error coming back from any of the
 * attachment endpoints. We match the tRPC code (`PRECONDITION_FAILED`)
 * AND the message prefix so unrelated precondition failures (e.g. an
 * attachment without a target) don't accidentally trigger the banner.
 */
function isStorageNotConfiguredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as TrpcErrorLike;
  if (e.data?.code !== "PRECONDITION_FAILED") return false;
  return typeof e.message === "string" && e.message.startsWith("Object storage is not configured");
}

/**
 * Drop/paste/pick file uploads for an issue, plus a grid of existing
 * attachments. Images render with presigned thumbnails; non-images get a
 * file icon + filename + size. Delete icon is admin-only (API enforces;
 * we hide for non-admins to keep the UI honest).
 *
 * Upload flow:
 *   1. attachment.initUpload  -> presigned PUT URL + attachmentId
 *   2. fetch(PUT) with the file body
 *   3. attachment.finalize    -> flips row ready
 *
 * We keep a pending-state map keyed by a local upload id so we can show
 * progress for each drop/paste without blocking the rest of the panel.
 */

type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: Date | string;
  /** Discriminator for LINK rows; mimeType === "text/url" works too. */
  kind?: "FILE" | "LINK";
  /** Set on LINK rows only. */
  externalUrl?: string | null;
};

/** True when this row is an external-link attachment, not an upload. */
function isLinkAttachment(a: Pick<Attachment, "mimeType" | "kind">): boolean {
  return a.kind === "LINK" || a.mimeType === "text/url";
}

type Pending = {
  localId: string;
  filename: string;
  size: number;
  error?: string;
};

// Human-readable byte formatter — bytes in, short suffix out.
function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/**
 * Builds a markdown reference to an attachment for insertion into a
 * textarea. Images use the `![](forge-attachment:id)` form so the
 * inline markdown renderer knows to resolve a presigned GET; non-images
 * use `[filename](forge-attachment:id)` for the same.
 */
export function attachmentMarkdownRef(args: {
  attachmentId: string;
  filename: string;
  mimeType: string;
}): string {
  if (isImageMime(args.mimeType)) {
    return `![${args.filename}](forge-attachment:${args.attachmentId})`;
  }
  return `[${args.filename}](forge-attachment:${args.attachmentId})`;
}

export function IssueAttachmentsPanel({ issueId }: { issueId: string }) {
  const workspace = useWorkspace();
  const isAdmin = workspace.role === "OWNER" || workspace.role === "ADMIN";
  const utils = trpc.useUtils();
  const listQuery = trpc.attachment.list.useQuery({
    targetType: "issue",
    targetId: issueId,
  });
  const { data, isLoading } = listQuery;

  // Propagated up from any child <AttachmentTile/> whose `getDownloadUrl`
  // query has failed with a "storage not configured" error. We need this
  // because `attachment.list` itself only hits the DB and can't surface
  // the misconfig — only S3-touching endpoints can.
  const [tileStorageMisconfig, setTileStorageMisconfig] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const initUpload = trpc.attachment.initUpload.useMutation();
  const finalize = trpc.attachment.finalize.useMutation();
  const attachLink = trpc.attachment.attachLink.useMutation({
    onSuccess: (result) => {
      utils.attachment.list.invalidate({
        targetType: "issue",
        targetId: issueId,
      });
      utils.github.listLinked.invalidate({ issueId });
      utils.issue.byId.invalidate({ id: issueId });
      if ("routedTo" in result && result.routedTo === "github.link") {
        toast.success("GitHub link added to Automation & delivery.");
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.attachment.delete.useMutation({
    onSuccess: () => {
      utils.attachment.list.invalidate({
        targetType: "issue",
        targetId: issueId,
      });
      utils.issue.byId.invalidate({ id: issueId });
    },
    onError: (e) => toast.error(e.message),
  });

  const [pending, setPending] = useState<Pending[]>([]);
  const [isDragging, setDragging] = useState(false);
  const dragCountRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Inline link-attach form state. Toggled from the header; cleared on
  // cancel and after a successful submit.
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");

  const submitLink = useCallback(async () => {
    const trimmedUrl = linkUrl.trim();
    if (!trimmedUrl) return;
    try {
      await attachLink.mutateAsync({
        targetType: "issue",
        targetId: issueId,
        url: trimmedUrl,
        title: linkTitle.trim() || undefined,
      });
      setLinkUrl("");
      setLinkTitle("");
      setLinkFormOpen(false);
    } catch {
      // toast already fired via mutation onError
    }
  }, [attachLink, issueId, linkTitle, linkUrl]);

  const uploadOne = useCallback(
    async (file: File) => {
      const localId = crypto.randomUUID();
      setPending((p) => [...p, { localId, filename: file.name, size: file.size }]);
      try {
        const init = await initUpload.mutateAsync({
          targetType: "issue",
          targetId: issueId,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
        });
        const put = await fetch(init.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        await finalize.mutateAsync({ attachmentId: init.attachmentId });
        await utils.attachment.list.invalidate({
          targetType: "issue",
          targetId: issueId,
        });
        await utils.issue.byId.invalidate({ id: issueId });
        setPending((p) => p.filter((x) => x.localId !== localId));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setPending((p) => p.map((x) => (x.localId === localId ? { ...x, error: message } : x)));
        toast.error(`${file.name}: ${message}`);
      }
    },
    [initUpload, finalize, issueId, utils],
  );

  const handleFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      const arr = Array.from(files);
      for (const f of arr) void uploadOne(f);
    },
    [uploadOne],
  );

  // Drag/drop handlers on the panel — also acts as a fallback when the
  // user doesn't know about paste.
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current += 1;
    if (e.dataTransfer?.types?.includes("Files")) setDragging(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current -= 1;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setDragging(false);
    }
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCountRef.current = 0;
      setDragging(false);
      handleFiles(e.dataTransfer?.files ?? null);
    },
    [handleFiles],
  );

  const rows = (data ?? []) as Attachment[];
  const visibleRows = expanded ? rows : rows.slice(0, 4);
  const hasAnything = rows.length > 0 || pending.length > 0;

  // The list query is DB-only so it won't trip on storage misconfig.
  // We instead check anywhere S3 is actually contacted: the initUpload
  // mutation and any tile's getDownloadUrl query (lifted via state).
  const storageMisconfig =
    tileStorageMisconfig ||
    isStorageNotConfiguredError(initUpload.error) ||
    isStorageNotConfiguredError(finalize.error) ||
    isStorageNotConfiguredError(deleteMut.error);

  return (
    <section
      id="issue-attachments"
      tabIndex={-1}
      aria-label="Attachments"
      className="focus-ring min-w-0 scroll-mt-20 rounded-lg border border-border bg-card/40"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header className="flex min-h-9 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
        <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Attachments
        </h2>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">{rows.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              // Reset so picking the same file twice still fires change.
              if (e.target) e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[0.6875rem]"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-3 w-3" /> Add file
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[0.6875rem]"
            onClick={() => setLinkFormOpen((v) => !v)}
            title="Attach a document or external reference"
            aria-expanded={linkFormOpen}
            aria-controls={`attachment-link-form-${issueId}`}
          >
            <Link2 className="h-3 w-3" /> Attach link
          </Button>
        </div>
      </header>
      {linkFormOpen && (
        <div
          id={`attachment-link-form-${issueId}`}
          className="border-b border-border bg-card/40 px-3 py-2"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitLink();
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              type="url"
              aria-label="External link URL"
              required
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://docs.google.com/document/…"
              className="w-full min-w-0 flex-1 basis-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ember"
            />
            <input
              type="text"
              aria-label="External link title"
              value={linkTitle}
              onChange={(e) => setLinkTitle(e.target.value)}
              placeholder="Optional title (defaults to hostname)"
              maxLength={255}
              className="w-full min-w-0 flex-1 basis-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ember"
            />
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="h-7 px-2 text-[0.6875rem]"
              disabled={!linkUrl.trim() || attachLink.isPending}
            >
              {attachLink.isPending ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Attaching…
                </>
              ) : (
                <>
                  <Link2 className="h-3 w-3" /> Attach
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[0.6875rem]"
              onClick={() => {
                setLinkFormOpen(false);
                setLinkUrl("");
                setLinkTitle("");
              }}
            >
              Cancel
            </Button>
          </form>
        </div>
      )}

      <div
        className={cn(
          "relative p-3",
          isDragging && "outline outline-dashed outline-2 outline-offset-[-4px] outline-ember/80",
        )}
      >
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-md bg-ember/5 text-xs font-medium text-ember">
            Drop to upload
          </div>
        )}

        {storageMisconfig && <StorageNotConfiguredBanner />}
        {listQuery.isError ? (
          <div
            role="status"
            className="text-meta flex flex-wrap items-center gap-2 text-muted-foreground"
          >
            Attachments could not be loaded.
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void listQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : isLoading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Loading attachments…</p>
        ) : !hasAnything ? (
          <p className="text-meta py-1 text-muted-foreground">
            No files attached. Drop files here or choose Add file.
          </p>
        ) : (
          <ul id={`attachment-list-${issueId}`} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {visibleRows.map((a) => (
              <AttachmentTile
                key={a.id}
                attachment={a}
                allAttachments={rows}
                issueId={issueId}
                canDelete={isAdmin}
                onDelete={() => deleteMut.mutate({ attachmentId: a.id })}
                onStorageMisconfig={() => setTileStorageMisconfig(true)}
              />
            ))}
            {pending.map((p) => (
              <li
                key={p.localId}
                className="row group relative h-20 items-center gap-2 overflow-hidden rounded-md border border-dashed border-border bg-background p-2 text-xs"
              >
                {p.error ? (
                  <FileIcon className="h-5 w-5 shrink-0 text-danger" />
                ) : (
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.filename}</div>
                  <div className="text-meta text-muted-foreground">
                    {p.error ?? `${prettyBytes(p.size)} · uploading…`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 4 && !listQuery.isError && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 w-full text-muted-foreground"
            aria-expanded={expanded}
            aria-controls={`attachment-list-${issueId}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {expanded ? "Show fewer files" : `View all attachments (${rows.length})`}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Inline misconfig banner. Shown in place of the empty/loading/list state
 * when the API reports `PRECONDITION_FAILED` with the storage-not-configured
 * message. Includes the exact env vars an admin needs to set so the fix is
 * obvious without grep-ing the codebase.
 */
function StorageNotConfiguredBanner() {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card/40 p-3 text-xs">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium text-foreground">Object storage is not configured.</p>
        <p className="text-muted-foreground">
          Attachments need an S3-compatible backend (MinIO in dev). Ask an admin to set the
          following environment variables and restart the app:
        </p>
        <code className="block whitespace-pre rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[0.65625rem] text-muted-foreground">
          {`S3_ENDPOINT=http://localhost:59000\nS3_ACCESS_KEY=...\nS3_SECRET_KEY=...`}
        </code>
      </div>
    </div>
  );
}

function AttachmentTile({
  attachment,
  allAttachments,
  issueId,
  canDelete,
  onDelete,
  onStorageMisconfig,
}: {
  attachment: Attachment;
  allAttachments: Attachment[];
  issueId: string;
  canDelete: boolean;
  onDelete: () => void;
  onStorageMisconfig?: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const lightbox = useAttachmentLightbox();
  const isLink = isLinkAttachment(attachment);
  const isImage = !isLink && isImageMime(attachment.mimeType);
  // We still issue a presigned GET *only* for image thumbs in the grid
  // (cheap, cached). Non-image tiles render an icon and only resolve a
  // URL on click via the lightbox. LINK rows have no underlying object,
  // so we skip the query entirely.
  const { data, error } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId: attachment.id },
    { staleTime: 5 * 60_000, retry: false, enabled: isImage },
  );
  // Bubble the misconfig signal up so the panel can swap to the banner
  // instead of rendering broken thumbnails. Idempotent — parent dedupes
  // via boolean state, and we only fire on transition into the error.
  useEffect(() => {
    if (error && isStorageNotConfiguredError(error)) {
      onStorageMisconfig?.();
    }
  }, [error, onStorageMisconfig]);
  const thumbUrl = isImage ? data?.url : undefined;
  const linkMeta = useMemo(
    () => (isLink ? linkAttachmentMeta(attachment.externalUrl ?? null) : null),
    [attachment.externalUrl, isLink],
  );

  const openTile = () => {
    if (isLink) {
      const href = attachment.externalUrl ?? "";
      if (href && isSafeExternalUrl(href)) window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    lightbox.open({
      attachmentId: attachment.id,
      attachments: allAttachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        kind: a.kind,
        externalUrl: a.externalUrl ?? null,
      })),
      target: { type: "issue", id: issueId },
      canDelete,
    });
  };

  const body = useMemo(() => {
    if (isLink) {
      return (
        <div className="flex min-h-16 items-center gap-2.5 p-2.5 pr-9">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-card/60">
            <LinkFavicon url={attachment.externalUrl} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">
              {attachment.filename}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
              <span className="shrink-0 font-mono">{linkMeta?.host || "external link"}</span>
              {linkMeta?.path && (
                <>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="min-w-0 truncate font-mono" title={linkMeta.path}>
                    {linkMeta.path}
                  </span>
                </>
              )}
            </div>
          </div>
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        </div>
      );
    }
    return (
      <div className="flex min-h-16 items-center gap-2.5 p-2.5 pr-9">
        <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded border border-border bg-card/60">
          {isImage && thumbUrl ? (
            // Presigned thumbnail; the file name stays visible beside it.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : isPdf(attachment.mimeType) ? (
            <FileText className="h-5 w-5 text-muted-foreground" />
          ) : (
            <FileIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-filename line-clamp-2 break-words font-medium">
            {attachment.filename}
          </div>
          <div className="text-meta text-muted-foreground">
            {prettyBytes(attachment.size)} · Preview
          </div>
        </div>
      </div>
    );
  }, [
    isLink,
    isImage,
    thumbUrl,
    attachment.filename,
    attachment.externalUrl,
    attachment.mimeType,
    attachment.size,
    linkMeta,
  ]);

  return (
    <li className="group relative min-w-0 overflow-hidden rounded-md border border-border bg-background">
      <button
        type="button"
        onClick={openTile}
        aria-label={`${isLink ? "Open link" : "Preview attachment"}: ${attachment.filename}`}
        className="block h-full w-full text-left transition-shadow hover:ring-1 hover:ring-ember/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ember"
        title={
          isLink
            ? `${attachment.filename} · ${attachment.externalUrl ?? "external link"} · click to open`
            : `${attachment.filename} · ${prettyBytes(attachment.size)} · click to preview`
        }
      >
        {body}
      </button>
      {canDelete && (
        <button
          type="button"
          className="focus-ring absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-md bg-background/90 text-muted-foreground transition-colors hover:text-danger"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setConfirmOpen(true);
          }}
          title="Delete attachment"
          aria-label={`Delete attachment: ${attachment.filename}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
      <Confirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="destructive"
        title="Delete attachment?"
        description={
          isLink
            ? "Removes this external reference from the issue."
            : "Permanently removes the file from the issue and object storage."
        }
        primaryLabel="Delete attachment"
        typeToConfirm={attachment.filename}
        onConfirm={() => onDelete()}
      />
    </li>
  );
}

function isPdf(mime: string): boolean {
  return mime === "application/pdf";
}

function linkAttachmentMeta(url: string | null): { host: string; path: string } {
  if (!url || !isSafeExternalUrl(url)) return { host: "", path: "" };
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const path =
      host === "github.com" && pathParts.length >= 4 && pathParts[2] === "pull"
        ? `${pathParts[0]}/${pathParts[1]}#${pathParts[3]}`
        : pathParts.slice(0, 3).join("/");
    return { host, path };
  } catch {
    return { host: "", path: "" };
  }
}
