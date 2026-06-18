"use client";
import * as React from "react";
import { toast } from "sonner";
import {
  Download,
  ExternalLink,
  Link as LinkIcon,
  Trash2,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  AlertTriangle,
  FileText,
  File as FileIcon,
  Music,
  Video,
  Image as ImageIcon,
  Maximize2,
} from "lucide-react";
import { Confirm } from "@/components/ui/modal";
import { useModalBehavior } from "@/components/ui/modal/use-modal-behavior";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { isSafeExternalUrl } from "@/lib/url-safety";
import { LinkFavicon } from "@/components/attachments/attachment-chip";

/**
 * Forge attachment lightbox — first-class file interaction surface.
 *
 * Click an attachment anywhere in the app (issue rail panel, inline
 * markdown chip, future surfaces like comments/projects) and this
 * lightbox opens with a format-aware preview, arrow-key paging through
 * the surrounding list, and an actions row (download, open-in-tab,
 * copy link, delete-with-confirm). It NEVER auto-downloads — that's the
 * whole point.
 *
 * Architecture:
 *   - <AttachmentLightboxProvider> is mounted once at the workspace
 *     shell layer (`/w/[slug]/layout.tsx`).
 *   - useAttachmentLightbox() returns { open(args) } from anywhere.
 *   - The provider owns the modal state, the active attachment, and
 *     the surrounding list for paging. Both consumers (panel + inline
 *     markdown chip) feed the same modal.
 *
 * Keyboard:
 *   ←  → : page through the list
 *   d    : download (forces a save via Content-Disposition)
 *   o    : open in new tab
 *   c    : copy presigned URL to clipboard
 *   ⌫    : delete (admin-only; type-to-confirm modal)
 *   esc  : close
 */

export type AttachmentLite = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Discriminates LINK rows from FILE rows. mimeType === "text/url" works too. */
  kind?: "FILE" | "LINK";
  /** Canonical external URL for LINK rows. */
  externalUrl?: string | null;
};

/** True for LINK-kind rows; checked by the preview branch + chip. */
function isLinkAttachment(a: AttachmentLite): boolean {
  return a.kind === "LINK" || a.mimeType === "text/url";
}

type OpenArgs = {
  attachmentId: string;
  attachments: AttachmentLite[];
  /**
   * If supplied (with a target), the modal will refetch the surrounding
   * list after a delete to keep paging consistent. Optional — markdown
   * inline chips don't have target context.
   */
  target?: { type: string; id: string };
  canDelete?: boolean;
};

type LightboxContextValue = {
  open: (args: OpenArgs) => void;
};

const LightboxContext = React.createContext<LightboxContextValue | null>(null);

export function useAttachmentLightbox(): LightboxContextValue {
  const ctx = React.useContext(LightboxContext);
  if (!ctx) {
    throw new Error(
      "useAttachmentLightbox must be used inside <AttachmentLightboxProvider>",
    );
  }
  return ctx;
}

/**
 * Provider that owns lightbox state. Mount once per workspace shell.
 */
export function AttachmentLightboxProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState<OpenArgs | null>(null);

  const open = React.useCallback((args: OpenArgs) => {
    setState(args);
  }, []);

  const close = React.useCallback(() => setState(null), []);

  const setActiveId = React.useCallback((nextId: string) => {
    setState((s) => (s ? { ...s, attachmentId: nextId } : s));
  }, []);

  const replaceList = React.useCallback((nextList: AttachmentLite[]) => {
    setState((s) => (s ? { ...s, attachments: nextList } : s));
  }, []);

  const value = React.useMemo<LightboxContextValue>(
    () => ({ open }),
    [open],
  );

  return (
    <LightboxContext.Provider value={value}>
      {children}
      {state && (
        <Lightbox
          state={state}
          onClose={close}
          onSetActiveId={setActiveId}
          onReplaceList={replaceList}
        />
      )}
    </LightboxContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                              */
/* ------------------------------------------------------------------ */

function Lightbox({
  state,
  onClose,
  onSetActiveId,
  onReplaceList,
}: {
  state: OpenArgs;
  onClose: () => void;
  onSetActiveId: (id: string) => void;
  onReplaceList: (list: AttachmentLite[]) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const { attachmentId, attachments, target, canDelete } = state;

  const index = Math.max(
    0,
    attachments.findIndex((a) => a.id === attachmentId),
  );
  const current = attachments[index] ?? attachments[0];
  const total = attachments.length;
  const hasPaging = total > 1;

  const goPrev = React.useCallback(() => {
    if (!hasPaging) return;
    const next = attachments[(index - 1 + total) % total];
    if (next) onSetActiveId(next.id);
  }, [attachments, hasPaging, index, onSetActiveId, total]);

  const goNext = React.useCallback(() => {
    if (!hasPaging) return;
    const next = attachments[(index + 1) % total];
    if (next) onSetActiveId(next.id);
  }, [attachments, hasPaging, index, onSetActiveId, total]);

  // LINK attachments don't have an underlying object — the canonical
  // pointer is `externalUrl`. We skip the presigned-GET roundtrip for
  // them and use the external URL directly for download/open/copy.
  const isLink = current ? isLinkAttachment(current) : false;
  // Presigned URL for the active FILE attachment. The 5-min staleTime
  // lets arrow-paging stay snappy without re-presigning each step.
  const { data, error, isLoading } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId: current?.id ?? "" },
    {
      enabled: !!current?.id && !isLink,
      staleTime: 5 * 60_000,
      retry: false,
    },
  );
  const url = isLink
    ? current?.externalUrl && isSafeExternalUrl(current.externalUrl)
      ? current.externalUrl
      : ""
    : data?.url;

  // Delete plumbing — confirm modal stacks on top of the lightbox.
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const utils = trpc.useUtils();
  const deleteMut = trpc.attachment.delete.useMutation({
    onSuccess: () => {
      if (target) {
        utils.attachment.list.invalidate({
          targetType: target.type,
          targetId: target.id,
        });
        if (target.type === "issue") {
          utils.issue.byId.invalidate({ id: target.id });
        }
      }
      const remaining = attachments.filter((a) => a.id !== current?.id);
      if (remaining.length === 0) {
        onClose();
      } else {
        const fallback = remaining[Math.min(index, remaining.length - 1)];
        onReplaceList(remaining);
        if (fallback) onSetActiveId(fallback.id);
      }
      toast.success("Attachment deleted.");
    },
    onError: (e) => toast.error(e.message),
  });

  // Action handlers ------------------------------------------------------
  const onDownload = React.useCallback(() => {
    if (!url || !current) return;
    // LINK rows have no bytes to download — fall through to "open in tab"
    // semantics so the keyboard shortcut still does the obvious thing.
    if (isLink) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    // Anchor with `download` attribute forces save instead of in-tab open
    // for previewable types; honors the original filename.
    const a = document.createElement("a");
    a.href = url;
    a.download = current.filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [url, current, isLink]);

  const onOpenInTab = React.useCallback(() => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  const onCopyLink = React.useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied (15-min validity).");
    } catch {
      toast.error("Couldn't access clipboard.");
    }
  }, [url]);

  // Modal behavior — esc-to-close + tab cycling, plus our own keymap for
  // arrows + action shortcuts. Skip global handler when the type-to-confirm
  // modal is on top so its esc closes the confirm, not the lightbox.
  useModalBehavior({
    open: !confirmOpen,
    onClose,
    containerRef,
  });

  React.useEffect(() => {
    if (confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // Don't steal arrows from form fields if any are focused inside.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isField = tag === "input" || tag === "textarea" || tag === "select";
      if (isField) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        onDownload();
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        onOpenInTab();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        void onCopyLink();
      } else if (
        (e.key === "Backspace" || e.key === "Delete") &&
        canDelete &&
        current
      ) {
        e.preventDefault();
        setConfirmOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    confirmOpen,
    goPrev,
    goNext,
    onDownload,
    onOpenInTab,
    onCopyLink,
    canDelete,
    current,
  ]);

  if (!current) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex flex-col bg-foreground/85 backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={onClose}
    >
      {/* Header — filename, meta, close */}
      <div
        className="flex shrink-0 items-center gap-3 border-b border-border/40 bg-foreground/10 px-4 py-2.5 text-background"
        onClick={(e) => e.stopPropagation()}
      >
        <KindGlyph mime={current.mimeType} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{current.filename}</div>
          <div className="font-mono text-[0.65625rem] uppercase tracking-wider text-background/60">
            {current.mimeType || "binary"} · {prettyBytes(current.size)}
            {hasPaging && (
              <>
                <span className="mx-2 opacity-50">·</span>
                <span>
                  {index + 1} / {total}
                </span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-md text-background/80 hover:bg-background/10 hover:text-background"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body — preview area, with prev/next chevrons floating on the sides */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Attachment preview: ${current.filename}`}
        className="relative flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {hasPaging && (
          <button
            type="button"
            aria-label="Previous attachment"
            onClick={goPrev}
            className="absolute left-2 top-1/2 z-10 hidden -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full bg-background/15 text-background hover:bg-background/25 sm:grid"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}

        <div className="flex h-full w-full max-w-6xl items-center justify-center">
          {isLoading ? (
            <div className="flex flex-col items-center gap-2 text-background/80">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="font-mono text-[0.6875rem] uppercase tracking-wider">
                Loading preview
              </span>
            </div>
          ) : error || !url ? (
            <UnavailableCard
              filename={current.filename}
              message={error?.message ?? "Couldn't fetch a download URL."}
            />
          ) : (
            <Preview
              key={current.id}
              attachment={current}
              url={url}
              onDownload={onDownload}
            />
          )}
        </div>

        {hasPaging && (
          <button
            type="button"
            aria-label="Next attachment"
            onClick={goNext}
            className="absolute right-2 top-1/2 z-10 hidden -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full bg-background/15 text-background hover:bg-background/25 sm:grid"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Footer — actions row */}
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-t border-border/40 bg-foreground/10 px-4 py-2.5 text-background"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hidden font-mono text-[0.65625rem] uppercase tracking-wider text-background/60 sm:block">
          {hasPaging ? "←  →  page · " : ""}
          d download · o open · c copy
          {canDelete ? " · ⌫ delete" : ""} · esc close
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ActionButton onClick={onDownload} disabled={!url} title="Download (D)">
            <Download className="h-3.5 w-3.5" /> Download
          </ActionButton>
          <ActionButton onClick={onOpenInTab} disabled={!url} title="Open in new tab (O)">
            <ExternalLink className="h-3.5 w-3.5" /> Open
          </ActionButton>
          <ActionButton onClick={onCopyLink} disabled={!url} title="Copy presigned link (C)">
            <LinkIcon className="h-3.5 w-3.5" /> Copy link
          </ActionButton>
          {canDelete && (
            <ActionButton
              onClick={() => setConfirmOpen(true)}
              variant="danger"
              title="Delete (⌫)"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </ActionButton>
          )}
        </div>
      </div>

      <Confirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="destructive"
        title="Delete attachment?"
        description="Permanently removes the file from object storage."
        primaryLabel="Delete attachment"
        typeToConfirm={current.filename}
        onConfirm={async () => {
          await deleteMut.mutateAsync({ attachmentId: current.id });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Format-aware preview                                               */
/* ------------------------------------------------------------------ */

function Preview({
  attachment,
  url,
  onDownload,
}: {
  attachment: AttachmentLite;
  url: string;
  onDownload: () => void;
}) {
  // LINK rows: render the external URL in a sandboxed iframe with a
  // visible "Open in new tab" affordance. Many sites refuse framing
  // (X-Frame-Options DENY / CSP frame-ancestors), in which case the
  // iframe stays blank — the affordance lets the user escape to a
  // real tab without hunting in the footer.
  if (isLinkAttachment(attachment)) {
    return <LinkPreview attachment={attachment} />;
  }
  const kind = classifyMime(attachment.mimeType, attachment.filename);

  if (kind === "image") return <ImagePreview url={url} alt={attachment.filename} />;
  if (kind === "pdf") return <PdfPreview url={url} filename={attachment.filename} />;
  // Render uploaded HTML attachments in the same sandboxed iframe used for
  // external links. No `allow-scripts` — agents can ship arbitrary HTML and
  // we don't want it executing in the Forge origin.
  if (kind === "html")
    return <HtmlPreview url={url} filename={attachment.filename} />;
  if (kind === "video") return <VideoPreview url={url} mime={attachment.mimeType} />;
  if (kind === "audio")
    return <AudioPreview url={url} filename={attachment.filename} mime={attachment.mimeType} />;
  if (kind === "text")
    return (
      <TextPreview
        url={url}
        filename={attachment.filename}
        size={attachment.size}
        onDownload={onDownload}
      />
    );

  return <NoPreview attachment={attachment} onDownload={onDownload} />;
}

function LinkPreview({ attachment }: { attachment: AttachmentLite }) {
  const href =
    attachment.externalUrl && isSafeExternalUrl(attachment.externalUrl)
      ? attachment.externalUrl
      : "";
  let host = "";
  try {
    if (href) host = new URL(href).hostname.replace(/^www\./i, "");
  } catch {
    // Bad URL — leave host blank, header just shows the title.
  }
  const onOpen = () => {
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  };
  return (
    <div className="flex h-full w-full max-w-5xl flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-3 rounded-md border border-border/30 bg-card px-3 py-2 text-foreground">
        <LinkFavicon url={href} size={20} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {attachment.filename}
          </div>
          <div className="text-meta truncate text-muted-foreground">
            {host || href || "external link"}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpen}
          disabled={!href}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-ember px-2.5 py-1 text-xs font-medium text-ember-foreground transition-colors hover:bg-ember/90 disabled:pointer-events-none disabled:opacity-40"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open in new tab
        </button>
      </div>
      {href ? (
        <iframe
          src={href}
          title={attachment.filename}
          // Intentionally minimal: no `allow-scripts`, no `allow-same-origin`.
          // Many target sites will refuse framing (X-Frame-Options /
          // frame-ancestors) — the "Open in new tab" CTA above is the
          // escape hatch.
          sandbox="allow-popups allow-forms"
          className="min-h-0 flex-1 rounded-md border border-border/30 bg-background shadow-2xl"
        />
      ) : (
        <UnavailableCard
          filename={attachment.filename}
          message="No external URL on this link attachment."
        />
      )}
    </div>
  );
}

function HtmlPreview({ url, filename }: { url: string; filename: string }) {
  return (
    <iframe
      src={url}
      title={filename}
      // Sandbox uploaded HTML: no scripts, no same-origin. Agents can
      // attach arbitrary HTML reports — this gives them safe rendering
      // without giving the doc access to the Forge origin.
      sandbox="allow-popups allow-forms"
      className="h-full w-full rounded-md border border-border/30 bg-background shadow-2xl"
    />
  );
}

function ImagePreview({ url, alt }: { url: string; alt: string }) {
  // Click-to-toggle 100% zoom. Default is fit-to-viewport (object-contain).
  const [zoomed, setZoomed] = React.useState(false);
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center",
        zoomed ? "overflow-auto" : "overflow-hidden",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt}
        onClick={() => setZoomed((z) => !z)}
        title={zoomed ? "Click to fit" : "Click to zoom 100%"}
        className={cn(
          "rounded-md border border-border/30 shadow-2xl",
          zoomed ? "cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
          MOTION.base,
        )}
      />
    </div>
  );
}

function PdfPreview({ url, filename }: { url: string; filename: string }) {
  return (
    <iframe
      src={url}
      title={filename}
      className="h-full w-full rounded-md border border-border/30 bg-background shadow-2xl"
    />
  );
}

function VideoPreview({ url, mime }: { url: string; mime: string }) {
  return (
    <video
      src={url}
      controls
      autoPlay={false}
      className="max-h-full max-w-full rounded-md border border-border/30 bg-foreground shadow-2xl"
    >
      <source src={url} type={mime} />
    </video>
  );
}

function AudioPreview({
  url,
  filename,
  mime,
}: {
  url: string;
  filename: string;
  mime: string;
}) {
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-4 rounded-lg border border-border/30 bg-card p-6 text-foreground shadow-2xl">
      <Music className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <div className="text-sm font-medium">{filename}</div>
        <div className="font-mono text-[0.65625rem] uppercase tracking-wider text-muted-foreground">
          {mime}
        </div>
      </div>
      <audio src={url} controls className="w-full">
        <source src={url} type={mime} />
      </audio>
    </div>
  );
}

const TEXT_PREVIEW_LIMIT = 256 * 1024; // 256 KB cap — the modal is for skimming.

function TextPreview({
  url,
  filename,
  size,
  onDownload,
}: {
  url: string;
  filename: string;
  size: number;
  onDownload: () => void;
}) {
  const [text, setText] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [truncated, setTruncated] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setText(null);
    setErr(null);
    setTruncated(false);
    if (size > TEXT_PREVIEW_LIMIT) {
      setTruncated(true);
    }
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.text();
        if (cancelled) return;
        if (body.length > TEXT_PREVIEW_LIMIT) {
          setText(body.slice(0, TEXT_PREVIEW_LIMIT));
          setTruncated(true);
        } else {
          setText(body);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Couldn't load text.");
      });
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  if (err) {
    return <UnavailableCard filename={filename} message={err} />;
  }
  if (text === null) {
    return (
      <div className="flex flex-col items-center gap-2 text-background/80">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="font-mono text-[0.6875rem] uppercase tracking-wider">
          Loading text
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full max-w-4xl flex-col rounded-md border border-border/30 bg-background text-foreground shadow-2xl">
      <pre className="m-0 min-h-0 flex-1 overflow-auto p-4 font-mono text-[0.78125rem] leading-[1.55]">
        {text}
      </pre>
      {truncated && (
        <div className="flex items-center justify-between border-t border-border bg-muted px-3 py-1.5 font-mono text-[0.65625rem] uppercase tracking-wider text-muted-foreground">
          <span>Showing first {Math.round(TEXT_PREVIEW_LIMIT / 1024)} KB</span>
          <button
            type="button"
            onClick={onDownload}
            className="rounded text-foreground hover:underline"
          >
            Download full file
          </button>
        </div>
      )}
    </div>
  );
}

function NoPreview({
  attachment,
  onDownload,
}: {
  attachment: AttachmentLite;
  onDownload: () => void;
}) {
  return (
    <div className="flex max-w-md flex-col items-center gap-4 rounded-lg border border-border/30 bg-card p-8 text-center text-foreground shadow-2xl">
      <FileIcon className="h-10 w-10 text-muted-foreground" />
      <div>
        <div className="text-sm font-medium">{attachment.filename}</div>
        <div className="mt-0.5 font-mono text-[0.65625rem] uppercase tracking-wider text-muted-foreground">
          {attachment.mimeType || "binary"} · {prettyBytes(attachment.size)}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Forge can&apos;t preview this file type yet — but you can still
        download it or open it in a new tab.
      </p>
      <button
        type="button"
        onClick={onDownload}
        className="inline-flex items-center gap-1.5 rounded-md bg-ember px-3 py-1.5 text-xs font-medium text-ember-foreground hover:bg-ember/90"
      >
        <Download className="h-3.5 w-3.5" /> Download
      </button>
    </div>
  );
}

function UnavailableCard({
  filename,
  message,
}: {
  filename: string;
  message: string;
}) {
  return (
    <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border/30 bg-card p-6 text-center text-foreground shadow-2xl">
      <AlertTriangle className="h-7 w-7 text-warning" />
      <div className="text-sm font-medium">Preview unavailable</div>
      <div className="font-mono text-[0.65625rem] text-muted-foreground">{filename}</div>
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bits                                                               */
/* ------------------------------------------------------------------ */

function KindGlyph({ mime }: { mime: string }) {
  if (mime === "text/url") {
    return <ExternalLink className="h-4 w-4 shrink-0 text-background/70" />;
  }
  const kind = classifyMime(mime, "");
  const Icon =
    kind === "image"
      ? ImageIcon
      : kind === "pdf"
        ? FileText
        : kind === "html"
          ? FileText
          : kind === "video"
            ? Video
            : kind === "audio"
              ? Music
              : kind === "text"
                ? FileText
                : FileIcon;
  return <Icon className="h-4 w-4 shrink-0 text-background/70" />;
}

function ActionButton({
  children,
  onClick,
  disabled,
  title,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        variant === "danger"
          ? "border-danger/40 bg-danger/15 text-background hover:bg-danger/30"
          : "border-border/40 bg-background/10 text-background hover:bg-background/20",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Format buckets the lightbox renders. Exported so other surfaces
 * (e.g. CanvasPreview) can branch on the same set without forking
 * the heuristic.
 */
export type AttachmentKindLabel =
  | "image"
  | "pdf"
  | "html"
  | "video"
  | "audio"
  | "text"
  | "other";

/**
 * Classify a mime+filename pair into one of the renderable buckets.
 * The lightbox owns the heuristic — exported so callers like the
 * canvas inline preview share the same fallbacks (extension sniffing,
 * `application/json` → text, etc.).
 */
export function classifyAttachmentKind(
  mime: string,
  filename: string,
): AttachmentKindLabel {
  return classifyMime(mime, filename);
}

type Kind = AttachmentKindLabel;

function classifyMime(mime: string, filename: string): Kind {
  const m = (mime || "").toLowerCase();
  const f = (filename || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || f.endsWith(".pdf")) return "pdf";
  // HTML uploads route to the sandboxed iframe preview — keep ahead of
  // the generic `text/*` branch so we don't render `<html>` as raw text.
  if (m === "text/html" || f.endsWith(".html") || f.endsWith(".htm"))
    return "html";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/")) return "text";
  if (m === "application/json" || m === "application/xml") return "text";
  if (m === "application/x-yaml" || m === "text/yaml") return "text";
  if (m === "application/javascript" || m === "application/typescript") return "text";
  // Filename-extension fallback for the long tail.
  const ext = f.split(".").pop() ?? "";
  const textExts = new Set([
    "md", "markdown", "txt", "log", "csv", "tsv", "yaml", "yml",
    "json", "xml", "css", "js", "jsx", "ts", "tsx",
    "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp",
    "sql", "sh", "bash", "env", "toml", "ini", "conf", "lock",
    "prisma", "graphql", "gql", "vue", "svelte",
  ]);
  if (textExts.has(ext)) return "text";
  return "other";
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Re-export the maximize icon so callers can hint "click to enlarge"
// on inline thumbnails — not used internally but keeps a single source.
export { Maximize2 as ExpandHint };
