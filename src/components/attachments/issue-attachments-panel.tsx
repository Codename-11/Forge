"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Paperclip,
  Upload,
  FileText,
  File as FileIcon,
  Trash2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

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
};

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
  const { data, isLoading } = trpc.attachment.list.useQuery({
    targetType: "issue",
    targetId: issueId,
  });

  const initUpload = trpc.attachment.initUpload.useMutation();
  const finalize = trpc.attachment.finalize.useMutation();
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
        setPending((p) =>
          p.map((x) => (x.localId === localId ? { ...x, error: message } : x)),
        );
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
  const hasAnything = rows.length > 0 || pending.length > 0;

  return (
    <section
      className="mt-8 rounded-lg border border-border bg-card/40"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Attachments
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground">
          {rows.length}
        </span>
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
            className="h-6 px-2 text-[11px]"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-3 w-3" /> Upload
          </Button>
        </div>
      </header>

      <div
        className={cn(
          "relative p-3",
          isDragging &&
            "outline outline-2 outline-dashed outline-ember/80 outline-offset-[-4px]",
        )}
      >
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-md bg-ember/5 text-xs font-medium text-ember">
            Drop to upload
          </div>
        )}

        {isLoading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Loading attachments…
          </p>
        ) : !hasAnything ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Drop files here, paste from clipboard, or click Upload.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {rows.map((a) => (
              <AttachmentTile
                key={a.id}
                attachment={a}
                canDelete={isAdmin}
                onDelete={() =>
                  deleteMut.mutate({ attachmentId: a.id })
                }
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
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {p.error ?? `${prettyBytes(p.size)} · uploading…`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AttachmentTile({
  attachment,
  canDelete,
  onDelete,
}: {
  attachment: Attachment;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isImage = isImageMime(attachment.mimeType);
  const { data } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId: attachment.id },
    // Keep previously-fetched URLs warm; the server TTL is 15 min so
    // this ends up refreshing naturally on revisit.
    { staleTime: 5 * 60_000 },
  );
  const href = data?.url;

  const body = useMemo(() => {
    if (isImage && href) {
      return (
        // Presigned GET into an <img>; `object-fit: cover` for the thumb.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={href}
          alt={attachment.filename}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-2 text-center">
        {isPdf(attachment.mimeType) ? (
          <FileText className="h-6 w-6 text-muted-foreground" />
        ) : (
          <FileIcon className="h-6 w-6 text-muted-foreground" />
        )}
        <div className="line-clamp-2 text-[11px] font-medium">
          {attachment.filename}
        </div>
      </div>
    );
  }, [isImage, href, attachment.filename, attachment.mimeType]);

  return (
    <li className="group relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-background">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block h-full w-full"
        onClick={(e) => {
          if (!href) e.preventDefault();
        }}
        title={`${attachment.filename} · ${prettyBytes(attachment.size)}`}
      >
        {body}
      </a>
      {/* Overlay footer — filename + size, always visible on non-image. */}
      {isImage && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-background/95 to-transparent px-2 py-1 font-mono text-[10px] text-foreground/90">
          {attachment.filename}
        </div>
      )}
      {canDelete && (
        <button
          type="button"
          className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-md bg-background/90 text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
          onClick={(e) => {
            e.preventDefault();
            setConfirmOpen(true);
          }}
          title="Delete attachment"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
      <Confirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="destructive"
        title="Delete attachment?"
        description="Permanently removes the file from the issue and object storage."
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
