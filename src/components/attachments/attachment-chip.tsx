"use client";
import { useState } from "react";
import {
  Image as ImageIcon,
  FileText,
  FileArchive,
  FileQuestion,
  Download,
  ExternalLink,
  Github,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { isSafeExternalUrl } from "@/lib/url-safety";
import { useAttachmentLightbox } from "@/components/attachments/attachment-lightbox";

/**
 * Tiny favicon glyph for LINK attachments. Computes
 * `${origin}/favicon.ico` deterministically (no DB lookup, no probe) and
 * falls back to the lucide ExternalLink icon on any image-load failure
 * — so a missing favicon never produces a broken-image rectangle.
 */
export function LinkFavicon({
  url,
  className,
  size = 12,
}: {
  url: string | null | undefined;
  className?: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);
  let origin = "";
  let host = "";
  try {
    if (url && isSafeExternalUrl(url)) {
      const parsed = new URL(url);
      origin = parsed.origin;
      host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    }
  } catch {
    // Bad URL → render fallback.
  }
  if (host === "github.com") {
    return (
      <Github
        className={cn(
          "shrink-0 text-[#24292f] dark:text-[#f0f6fc]",
          className,
        )}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  if (!origin || errored) {
    return (
      <ExternalLink
        className={cn("shrink-0 text-muted-foreground/60", className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErrored(true)}
      className={cn("shrink-0 rounded-sm", className)}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Compact filename + size + mime-aware glyph chip for attachments rendered
 * inline (e.g. on chat bubbles, comments, anywhere a full grid tile would
 * be too heavy). Click opens the existing AttachmentLightbox; the
 * lightbox provider must be mounted somewhere in the tree.
 *
 * For LINK-kind attachments (mimeType === "text/url" or kind === "LINK")
 * the chip routes click through to `window.open(externalUrl)` instead of
 * the lightbox, and surfaces the URL hostname rather than a byte count
 * in the trailing slot.
 *
 * `download` icon hint on the right is decorative — the lightbox owns the
 * actual download action. Keeping it here means the affordance reads as
 * "this is a file you can save" without a second action button.
 */

export type AttachmentChipData = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Optional discriminator for LINK rows. mimeType === "text/url" works too. */
  kind?: "FILE" | "LINK";
  /** Set on LINK rows; the canonical external URL. */
  externalUrl?: string | null;
};

/** True if this attachment row is a LINK (not a byte upload). */
function isLinkAttachment(a: AttachmentChipData): boolean {
  return a.kind === "LINK" || a.mimeType === "text/url";
}

/** Best-effort hostname extraction for LINK chips' trailing slot. */
function safeHostname(url: string | null | undefined): string {
  if (!url || !isSafeExternalUrl(url)) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export function AttachmentChip({
  attachment,
  attachments,
  target,
  className,
}: {
  attachment: AttachmentChipData;
  /** All attachments on the same target — paged through in the lightbox. */
  attachments?: AttachmentChipData[];
  /** Lightbox refetch hint after delete; safe to omit. */
  target?: { type: string; id: string };
  className?: string;
}) {
  const lightbox = useAttachmentLightbox();
  const Icon = mimeIcon(attachment.mimeType);
  const isLink = isLinkAttachment(attachment);
  const linkHost = isLink ? safeHostname(attachment.externalUrl ?? null) : "";

  const open = () => {
    if (isLink) {
      // LINK rows skip the lightbox entirely — the canonical interaction
      // is "open the page in a new tab". Lightbox would render an
      // iframe-via-presigned-url that doesn't apply here.
      const href = attachment.externalUrl ?? "";
      if (href && isSafeExternalUrl(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
      }
      return;
    }
    lightbox.open({
      attachmentId: attachment.id,
      attachments: attachments ?? [attachment],
      target,
    });
  };

  return (
    <button
      type="button"
      onClick={open}
      title={
        isLink
          ? `${attachment.filename} · ${attachment.externalUrl ?? "external link"}`
          : `${attachment.filename} · ${prettyBytes(attachment.size)}`
      }
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card/60 px-1.5 py-1 text-left transition-colors hover:border-ember/40 hover:bg-card",
        className,
      )}
    >
      {isLink ? (
        <LinkFavicon url={attachment.externalUrl} size={12} />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="text-id min-w-0 flex-1 truncate font-mono text-foreground/90">
        {attachment.filename}
      </span>
      <span className="text-meta shrink-0 text-muted-foreground">
        {isLink ? linkHost || "link" : prettyBytes(attachment.size)}
      </span>
      {isLink ? (
        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      ) : (
        <Download className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      )}
    </button>
  );
}

/**
 * Image attachment thumbnail variant — square preview at ~80px that
 * resolves a presigned URL on mount and falls back to the chip on error
 * (so a 404 / storage misconfig never produces a broken-image icon).
 */
export function AttachmentThumb({
  attachment,
  attachments,
  target,
  className,
}: {
  attachment: AttachmentChipData;
  attachments?: AttachmentChipData[];
  target?: { type: string; id: string };
  className?: string;
}) {
  const lightbox = useAttachmentLightbox();
  const { data, error } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId: attachment.id },
    { staleTime: 5 * 60_000, retry: false },
  );
  if (error) {
    return (
      <AttachmentChip
        attachment={attachment}
        attachments={attachments}
        target={target}
        className={className}
      />
    );
  }
  const open = () =>
    lightbox.open({
      attachmentId: attachment.id,
      attachments: attachments ?? [attachment],
      target,
    });
  return (
    <button
      type="button"
      onClick={open}
      title={`${attachment.filename} · ${prettyBytes(attachment.size)}`}
      className={cn(
        "block h-20 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-background transition-shadow hover:ring-1 hover:ring-ember/40",
        className,
      )}
    >
      {data?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.url}
          alt={attachment.filename}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-4 w-4" />
        </span>
      )}
    </button>
  );
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function mimeIcon(mime: string) {
  const m = (mime || "").toLowerCase();
  if (m === "text/url") return ExternalLink;
  if (m.startsWith("image/")) return ImageIcon;
  if (m === "application/pdf" || m.startsWith("text/") || m === "application/json")
    return FileText;
  if (
    m === "application/zip" ||
    m === "application/x-tar" ||
    m === "application/gzip"
  )
    return FileArchive;
  return FileQuestion;
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
