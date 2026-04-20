"use client";
import { Fragment, useMemo } from "react";
import { FileText, File as FileIcon, Paperclip } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * Inline attachment renderer.
 *
 * We don't run the full markdown pipeline here — the project currently
 * displays descriptions + comments as `whitespace-pre-wrap` plain text.
 * What we *do* want to pick out are our own `forge-attachment:<id>`
 * references, which are emitted when users drag/drop/paste files into
 * a textarea. Those get resolved to a presigned GET and rendered inline
 * as an image or a file chip; everything else is rendered as plain text
 * (preserving whitespace), so the existing look-and-feel doesn't change.
 *
 * Supported forms:
 *   - ![alt](forge-attachment:cuid)       → inline <img>
 *   - [filename.ext](forge-attachment:cuid) → file chip link
 */

const TOKEN_RE = /(!?)\[([^\]]*)\]\(forge-attachment:([a-z0-9]{20,})\)/gi;

type Segment =
  | { type: "text"; value: string }
  | { type: "image"; alt: string; attachmentId: string }
  | { type: "link"; label: string; attachmentId: string };

function tokenize(body: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ type: "text", value: body.slice(last, idx) });
    const bang = m[1];
    const label = m[2] ?? "";
    const id = m[3] ?? "";
    if (bang === "!") {
      segs.push({ type: "image", alt: label, attachmentId: id });
    } else {
      segs.push({ type: "link", label: label || "Attachment", attachmentId: id });
    }
    last = idx + m[0].length;
  }
  if (last < body.length) segs.push({ type: "text", value: body.slice(last) });
  return segs;
}

/**
 * Renders a body that may embed `forge-attachment:` references.
 * Outer element is a <div> preserving whitespace so plain-text blocks
 * still look right.
 */
export function MarkdownWithAttachments({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  const segments = useMemo(() => tokenize(body ?? ""), [body]);

  if (segments.length === 1 && segments[0].type === "text") {
    return (
      <div className={className} style={{ whiteSpace: "pre-wrap" }}>
        {segments[0].value}
      </div>
    );
  }

  return (
    <div className={className} style={{ whiteSpace: "pre-wrap" }}>
      {segments.map((s, i) => {
        if (s.type === "text") return <Fragment key={i}>{s.value}</Fragment>;
        if (s.type === "image")
          return (
            <InlineAttachmentImage
              key={`${s.attachmentId}-${i}`}
              attachmentId={s.attachmentId}
              alt={s.alt}
            />
          );
        return (
          <InlineAttachmentLink
            key={`${s.attachmentId}-${i}`}
            attachmentId={s.attachmentId}
            label={s.label}
          />
        );
      })}
    </div>
  );
}

function InlineAttachmentImage({
  attachmentId,
  alt,
}: {
  attachmentId: string;
  alt: string;
}) {
  const { data, isLoading } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId },
    { staleTime: 5 * 60_000 },
  );
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-subtle px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
        <Paperclip className="h-3 w-3" /> loading…
      </span>
    );
  }
  if (!data?.url) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-subtle px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
        <Paperclip className="h-3 w-3" /> {alt || "attachment missing"}
      </span>
    );
  }
  return (
    <span className="my-2 block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={data.url}
        alt={alt}
        loading="lazy"
        className="max-h-96 max-w-full rounded-md border border-border object-contain"
      />
    </span>
  );
}

function InlineAttachmentLink({
  attachmentId,
  label,
}: {
  attachmentId: string;
  label: string;
}) {
  const { data } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId },
    { staleTime: 5 * 60_000 },
  );
  const isPdf = label.toLowerCase().endsWith(".pdf");
  const Icon = isPdf ? FileText : FileIcon;
  return (
    <a
      href={data?.url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!data?.url) e.preventDefault();
      }}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-subtle"
    >
      <Icon className="h-3 w-3 text-muted-foreground" />
      {label}
    </a>
  );
}
