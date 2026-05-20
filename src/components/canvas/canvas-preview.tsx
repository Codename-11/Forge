"use client";
import * as React from "react";
import { AlertTriangle, ExternalLink, FileText, Loader2 } from "lucide-react";
import {
  classifyAttachmentKind,
  type AttachmentKindLabel,
} from "@/components/attachments/attachment-lightbox";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";
import { cn } from "@/lib/utils";

/**
 * Inline canvas preview — shared renderer for attachment / artifact
 * nodes that the operator wants to see in-place instead of as a chip.
 *
 * The format buckets and sandbox attributes mirror
 * `attachment-lightbox.tsx` exactly so the canvas doesn't open a new
 * attack surface — uploaded HTML / external URLs render in a
 * scriptless, same-origin-denied iframe. The PDF iframe is unsandboxed
 * (browsers need the embedded viewer to run) and matches the lightbox.
 */

/** Largest file we will inline-preview. Anything over this falls back to a chip. */
export const CANVAS_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** Lines of text shown in the inline `<pre>` before "open full". */
const TEXT_PREVIEW_LINE_LIMIT = 40;

export type CanvasPreviewKind =
  | AttachmentKindLabel
  | "link"
  | "markdown"
  | "unsupported";

export interface CanvasPreviewProps {
  kind: CanvasPreviewKind;
  /** Underlying mime type for the kind icon + audio/video source attr. */
  mimeType?: string | null;
  /** Presigned (FILE) or external (LINK) URL for the renderer to fetch. */
  url?: string | null;
  /** Inline body — used by markdown/text/code artifacts that carry their content. */
  body?: string | null;
  filename?: string | null;
  /** Fixed render height in px. Defaults to 180 — matches a 3-line meta card. */
  height?: number;
  /** Click handler — wired by the canvas card to open the lightbox / new tab. */
  onExpand?: () => void;
  /** Optional override for tone — the card already paints its own border. */
  className?: string;
}

export function CanvasPreview({
  kind,
  mimeType,
  url,
  body,
  filename,
  height = 180,
  onExpand,
  className,
}: CanvasPreviewProps) {
  // Common wrapper — fixed height + warm token background.
  const wrapper = (children: React.ReactNode, extra?: string) => (
    <div
      role={onExpand ? "button" : undefined}
      tabIndex={onExpand ? 0 : undefined}
      onClick={(e) => {
        if (!onExpand) return;
        e.stopPropagation();
        onExpand();
      }}
      onMouseDown={(e) => {
        // Stop the canvas drag from swallowing the click target.
        if (onExpand) e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (!onExpand) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onExpand();
        }
      }}
      className={cn(
        "relative overflow-hidden rounded-md border border-border/40 bg-card/60",
        onExpand ? "cursor-zoom-in" : "",
        extra,
        className,
      )}
      style={{ height }}
    >
      {children}
    </div>
  );

  if (kind === "image") {
    if (!url) return wrapper(<LoadingShim label="Loading image" />);
    return wrapper(
      // eslint-disable-next-line @next/next/no-img-element -- presigned URLs aren't compatible with next/image
      <img
        src={url}
        alt={filename ?? "image"}
        draggable={false}
        className="h-full w-full object-cover"
      />,
    );
  }

  if (kind === "pdf") {
    if (!url) return wrapper(<LoadingShim label="Loading PDF" />);
    // PDF iframes are intentionally unsandboxed — matches the lightbox;
    // browser PDF viewers need the embedded plugin to run.
    return wrapper(
      <iframe
        src={url}
        title={filename ?? "PDF preview"}
        className="h-full w-full border-0 bg-background"
      />,
    );
  }

  if (kind === "html" || kind === "link") {
    if (!url) return wrapper(<LoadingShim label="Loading content" />);
    return wrapper(
      <iframe
        src={url}
        title={filename ?? "HTML preview"}
        // Sandbox tag matches the lightbox to keep the canvas attack
        // surface flat: no `allow-scripts`, no `allow-same-origin`.
        sandbox="allow-popups allow-forms"
        className="h-full w-full border-0 bg-background"
      />,
    );
  }

  if (kind === "markdown") {
    if (!body) return wrapper(<LoadingShim label="Loading body" />);
    return wrapper(
      <div className="h-full w-full overflow-auto p-2 text-foreground">
        <ChatMarkdown body={body} />
      </div>,
      "bg-subtle/30",
    );
  }

  if (kind === "text") {
    return (
      <CanvasTextPreview
        url={url ?? null}
        body={body ?? null}
        filename={filename ?? null}
        height={height}
        onExpand={onExpand}
        className={className}
      />
    );
  }

  if (kind === "video") {
    if (!url) return wrapper(<LoadingShim label="Loading video" />);
    return wrapper(
      <video
        src={url}
        controls
        preload="metadata"
        className="h-full w-full bg-foreground/90 object-contain"
      >
        {mimeType ? <source src={url} type={mimeType} /> : null}
      </video>,
    );
  }

  if (kind === "audio") {
    if (!url) return wrapper(<LoadingShim label="Loading audio" />);
    return wrapper(
      <div className="flex h-full w-full flex-col justify-center gap-1.5 bg-subtle/30 px-3">
        <div className="text-filename truncate text-foreground">
          {filename ?? "audio"}
        </div>
        <audio src={url} controls className="w-full">
          {mimeType ? <source src={url} type={mimeType} /> : null}
        </audio>
      </div>,
    );
  }

  // Fallback: unsupported.
  return wrapper(
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-4 text-center">
      <AlertTriangle className="h-4 w-4 text-warning" />
      <div className="text-meta uppercase tracking-wider text-muted-foreground">
        Cannot preview
      </div>
      {filename ? (
        <div className="text-filename truncate text-foreground">{filename}</div>
      ) : null}
      {mimeType ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          {mimeType}
        </div>
      ) : null}
    </div>,
  );
}

// ---------------------------------------------------------------------------
// Text preview — fetches the presigned URL (or uses the inline `body`),
// then renders a monospace `<pre>` capped at 40 lines.
// ---------------------------------------------------------------------------

function CanvasTextPreview({
  url,
  body,
  filename,
  height,
  onExpand,
  className,
}: {
  url: string | null;
  body: string | null;
  filename: string | null;
  height: number;
  onExpand?: () => void;
  className?: string;
}) {
  const [fetched, setFetched] = React.useState<string | null>(body ?? null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Inline-body path (artifact code/text): nothing to fetch.
    if (body) {
      setFetched(body);
      setErr(null);
      return;
    }
    if (!url) return;
    let cancelled = false;
    setFetched(null);
    setErr(null);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        if (cancelled) return;
        setFetched(t);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Couldn't load text.");
      });
    return () => {
      cancelled = true;
    };
  }, [url, body]);

  const wrapperClass = cn(
    "relative overflow-hidden rounded-md border border-border/40 bg-card/60",
    className,
  );

  if (err) {
    return (
      <div className={wrapperClass} style={{ height }}>
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <div className="text-meta text-muted-foreground">{err}</div>
        </div>
      </div>
    );
  }

  if (fetched === null) {
    return (
      <div className={wrapperClass} style={{ height }}>
        <LoadingShim label="Loading text" />
      </div>
    );
  }

  const lines = fetched.split("\n");
  const truncated = lines.length > TEXT_PREVIEW_LINE_LIMIT;
  const shown = truncated
    ? lines.slice(0, TEXT_PREVIEW_LINE_LIMIT).join("\n")
    : fetched;

  return (
    <div className={wrapperClass} style={{ height }}>
      <pre
        onMouseDown={(e) => e.stopPropagation()}
        className="m-0 h-full w-full overflow-auto bg-subtle/30 p-2 font-mono text-[10.5px] leading-snug text-foreground"
      >
        {shown}
      </pre>
      {truncated ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-border/40 bg-card/95 px-2 py-0.5">
          <span className="text-meta uppercase tracking-wider text-muted-foreground">
            {filename ?? "text"} · {lines.length} lines
          </span>
          {onExpand ? (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onExpand();
              }}
              className="inline-flex items-center gap-1 text-meta text-ember hover:underline"
            >
              Open full <ExternalLink className="h-2.5 w-2.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LoadingShim({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-meta uppercase tracking-wider">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers — picking the right `CanvasPreviewKind` for an entity ref.
// ---------------------------------------------------------------------------

/**
 * Decide which renderer to use for an attachment-targeted node. Mirrors
 * the lightbox's bucket selection, with `link` split out for LINK rows
 * (the lightbox's `LinkPreview` does the same).
 */
export function canvasKindForAttachment(meta: {
  kind?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  size?: number | null;
}): CanvasPreviewKind {
  if (meta.kind === "LINK" || meta.mimeType === "text/url") return "link";
  // Hard 25 MB cap on inline preview — same number as the upload cap;
  // anything bigger renders as a chip so we don't pull large bytes
  // straight into the canvas iframe / <pre>.
  if (typeof meta.size === "number" && meta.size > CANVAS_PREVIEW_MAX_BYTES) {
    return "unsupported";
  }
  const mime = meta.mimeType ?? "";
  const filename = meta.filename ?? "";
  const k = classifyAttachmentKind(mime, filename);
  if (k === "other") return "unsupported";
  return k;
}

/**
 * For artifact-targeted canvas nodes that aren't NOTE — the parent
 * card decides whether to inline-render based on `meta.body` /
 * `meta.bodyKind`. Returns `markdown` / `text` / `unsupported`.
 */
export function canvasKindForArtifact(meta: {
  kind?: string | null;
  body?: string | null;
  bodyKind?: string | null;
}): CanvasPreviewKind {
  if (!meta.body || meta.body.length === 0) return "unsupported";
  if (meta.bodyKind === "markdown") return "markdown";
  // `code` and `text` both render through the monospace text preview.
  return "text";
}

/** File-icon glyph for the chip / collapsed view. Re-export to keep callers tidy. */
export const PreviewKindGlyph = FileText;
