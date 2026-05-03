"use client";
import { Fragment, useMemo } from "react";
import Link from "next/link";
import {
  FileText,
  File as FileIcon,
  Paperclip,
  AlertTriangle,
  Bot,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { useAttachmentLightbox, type AttachmentLite } from "@/components/attachments/attachment-lightbox";

/**
 * Inline attachment + reference renderer.
 *
 * We don't run the full markdown pipeline here — the project currently
 * displays descriptions + comments as `whitespace-pre-wrap` plain text.
 * What we *do* want to pick out are first-class Forge primitives so
 * comments can act like teammates instead of plain prose:
 *
 *   - ![alt](forge-attachment:cuid)       → inline <img>
 *   - [filename.ext](forge-attachment:cuid) → file chip link
 *   - bare `KEY-NN`                        → link to issue page
 *   - bare `@profileKey`                   → agent mention chip
 *
 * Issue + mention detection happens as a second pass on text segments
 * so attachment tokens (which use brackets and parens) take precedence
 * and aren't accidentally re-tokenized.
 */

const TOKEN_RE = /(!?)\[([^\]]*)\]\(forge-attachment:([a-z0-9]{20,})\)/gi;

// Issue refs and agent mentions are matched on word boundaries so
// `forklift-mention` doesn't match `@mention`, and `axion-42` doesn't
// match `AXI-42`. The capture groups feed straight into the renderer.
const REF_RE = /(\b[A-Z][A-Z0-9]{1,9}-\d+\b)|(?<=^|[\s(,.;:!?])@([a-z0-9][a-z0-9_-]*)/gi;

type Segment =
  | { type: "text"; value: string }
  | { type: "image"; alt: string; attachmentId: string }
  | { type: "link"; label: string; attachmentId: string }
  | { type: "issueRef"; key: string }
  | { type: "mention"; profileKey: string };

function tokenize(body: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push(...tokenizeText(body.slice(last, idx)));
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
  if (last < body.length) segs.push(...tokenizeText(body.slice(last)));
  return segs;
}

/**
 * Second-pass tokenizer: splits raw text into [text, issueRef, mention]
 * segments. Run after the attachment-token pass so urls/markdown links
 * have already been claimed.
 */
function tokenizeText(text: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  REF_RE.lastIndex = 0;
  for (const m of text.matchAll(REF_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ type: "text", value: text.slice(last, idx) });
    if (m[1]) {
      segs.push({ type: "issueRef", key: m[1].toUpperCase() });
    } else if (m[2]) {
      segs.push({ type: "mention", profileKey: m[2].toLowerCase() });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
  return segs.length ? segs : [{ type: "text", value: text }];
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

  // Build the list of inline attachment ids in order — used for paging
  // when the user clicks any inline chip, so ←/→ walks through every
  // attachment referenced in the body.
  const inlineList = useMemo<{ id: string; label: string; isImage: boolean }[]>(
    () => {
      const out: { id: string; label: string; isImage: boolean }[] = [];
      for (const s of segments) {
        if (s.type === "image") {
          out.push({ id: s.attachmentId, label: s.alt || "image", isImage: true });
        } else if (s.type === "link") {
          out.push({ id: s.attachmentId, label: s.label, isImage: false });
        }
      }
      return out;
    },
    [segments],
  );

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
              inlineList={inlineList}
            />
          );
        if (s.type === "link")
          return (
            <InlineAttachmentLink
              key={`${s.attachmentId}-${i}`}
              attachmentId={s.attachmentId}
              label={s.label}
              inlineList={inlineList}
            />
          );
        if (s.type === "issueRef")
          return <InlineIssueRef key={`r-${i}-${s.key}`} issueKey={s.key} />;
        return (
          <InlineAgentMention
            key={`m-${i}-${s.profileKey}`}
            profileKey={s.profileKey}
          />
        );
      })}
    </div>
  );
}

/**
 * Resolve the surrounding inline-attachment list to the AttachmentLite
 * shape the lightbox wants. Filenames on inline references aren't always
 * the on-disk filename (the user can write any markdown alt/label) but
 * they're the best label we have without an extra round-trip to
 * `attachment.list`.
 */
function inlineListToAttachments(
  inlineList: { id: string; label: string; isImage: boolean }[],
): AttachmentLite[] {
  return inlineList.map((it) => ({
    id: it.id,
    filename: it.label,
    // Best-effort mime from the label extension. The lightbox does its own
    // mime sniffing and falls back to the filename if mime is empty.
    mimeType: it.isImage ? "image/*" : "",
    size: 0,
    // Inline markdown refs only point at FILE attachments today —
    // `[label](forge-attachment:cuid)` is the only token shape. Kept
    // explicit so future LINK-token support drops in cleanly.
    kind: "FILE" as const,
    externalUrl: null,
  }));
}

/**
 * Distinct "unavailable" pill used by both inline image + link variants.
 * Surfaces the concrete error message via `title` so admins can hover to
 * see *why* the attachment failed (storage misconfig, expired URL, etc.)
 * instead of the previous vague "attachment missing" text.
 */
function UnavailablePill({
  label,
  errorMessage,
}: {
  label?: string;
  errorMessage?: string;
}) {
  const tooltip = errorMessage
    ? `${label ? `${label} — ` : ""}${errorMessage}`
    : label || "Storage error";
  return (
    <span
      title={tooltip}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.65625rem] text-warning"
    >
      <AlertTriangle className="h-3 w-3" />
      Attachment unavailable — storage error
    </span>
  );
}

function InlineAttachmentImage({
  attachmentId,
  alt,
  inlineList,
}: {
  attachmentId: string;
  alt: string;
  inlineList: { id: string; label: string; isImage: boolean }[];
}) {
  const lightbox = useAttachmentLightbox();
  const { data, isLoading, error } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId },
    { staleTime: 5 * 60_000, retry: false },
  );
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-subtle px-2 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
        <Paperclip className="h-3 w-3" /> loading…
      </span>
    );
  }
  // Any error from getDownloadUrl (misconfig, not-found, expired) gets
  // the same loud-but-useful pill — better than silently rendering a
  // broken image or a vague "missing" tag.
  if (error) {
    return <UnavailablePill label={alt} errorMessage={error.message} />;
  }
  if (!data?.url) {
    return <UnavailablePill label={alt} />;
  }
  return (
    <span className="my-2 block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={data.url}
        alt={alt}
        loading="lazy"
        onClick={() =>
          lightbox.open({
            attachmentId,
            attachments: inlineListToAttachments(inlineList),
          })
        }
        className="max-h-96 max-w-full cursor-zoom-in rounded-md border border-border object-contain transition-shadow hover:ring-1 hover:ring-ember/40"
        title="Click to preview"
      />
    </span>
  );
}

/**
 * Bare `KEY-NN` becomes a link to the issue page. We resolve via the
 * `/w/{slug}/i/{KEY-NN}` short-link route — the server picks up the
 * cuid lookup and redirects to the canonical URL, so we don't need a
 * client-side roundtrip on render. If the workspace key in the ref
 * doesn't match the current workspace, we still render the link as a
 * safety net (the route will 404 cleanly) — this lets cross-workspace
 * pasted refs surface visually instead of silently going as plain text.
 */
function InlineIssueRef({ issueKey }: { issueKey: string }) {
  const ws = useMaybeWorkspace();
  if (!ws) {
    // No workspace context (e.g. account-level page rendering a comment).
    // Fall back to plain text so we don't link into the wrong place.
    return <span className="font-mono text-[0.75rem]">{issueKey}</span>;
  }
  return (
    <Link
      href={`/w/${ws.slug}/i/${issueKey}`}
      className="font-mono text-[0.75rem] text-ember underline-offset-2 hover:underline"
      title={`Open ${issueKey}`}
    >
      {issueKey}
    </Link>
  );
}

/**
 * Bare `@profileKey` renders as a small agent chip. We don't query the
 * `Agent` table on render — most comments have no mentions, and the
 * chip's presence already cues the reader. The `agent` icon + the
 * mono profileKey are enough; a follow-up tooltip could add the agent's
 * display name on hover.
 */
function InlineAgentMention({ profileKey }: { profileKey: string }) {
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1 py-0.5 font-mono text-[0.6875rem] text-indigo-700 dark:text-indigo-300"
      title={`@${profileKey}`}
    >
      <Bot className="h-3 w-3" />@{profileKey}
    </span>
  );
}

function InlineAttachmentLink({
  attachmentId,
  label,
  inlineList,
}: {
  attachmentId: string;
  label: string;
  inlineList: { id: string; label: string; isImage: boolean }[];
}) {
  const lightbox = useAttachmentLightbox();
  // We don't need the URL up front — the lightbox resolves it on open.
  // We do still query it so an error pill can replace a broken chip.
  const { error } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId },
    { staleTime: 5 * 60_000, retry: false },
  );
  if (error) {
    return <UnavailablePill label={label} errorMessage={error.message} />;
  }
  const isPdf = label.toLowerCase().endsWith(".pdf");
  const Icon = isPdf ? FileText : FileIcon;
  return (
    <button
      type="button"
      onClick={() =>
        lightbox.open({
          attachmentId,
          attachments: inlineListToAttachments(inlineList),
        })
      }
      title="Click to preview"
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.6875rem] hover:border-ember/40 hover:bg-subtle"
    >
      <Icon className="h-3 w-3 text-muted-foreground" />
      {label}
    </button>
  );
}
