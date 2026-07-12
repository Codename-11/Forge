"use client";
import { Fragment, useId, useMemo, useReducer, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  EyeOff,
  FileText,
  File as FileIcon,
  Bot,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import {
  useAttachmentLightbox,
  type AttachmentLite,
} from "@/components/attachments/attachment-lightbox";
import { LinkFavicon } from "@/components/attachments/attachment-chip";
import { IssueHoverPreview } from "@/components/issue-hover-preview";
import { AgentHoverPreview } from "@/components/agent-hover-preview";
import {
  tryParseDataBlock,
  type DataBlock,
} from "@/components/data-blocks/data-block-parser";
import { DataBlockTable } from "@/components/data-blocks/data-block-table";
import { DataBlockList } from "@/components/data-blocks/data-block-list";
import { DataBlockKV } from "@/components/data-blocks/data-block-kv";
import { matchEmbedUrl, type EmbedMatch } from "@/components/embeds/embed-detector";
import { ArtifactEmbed } from "@/components/embeds/artifact-embed";
import { YouTubeEmbed } from "@/components/embeds/youtube-embed";
import { GithubEmbed } from "@/components/embeds/github-embed";
import { LoomEmbed } from "@/components/embeds/loom-embed";
import { FigmaEmbed } from "@/components/embeds/figma-embed";
import { isSafeExternalUrl, toRenderableHref } from "@/lib/url-safety";

/**
 * Rich body renderer for descriptions, comments, artifacts, and notes.
 *
 * The body is treated as a markdown-flavored string with first-class
 * Forge primitives mixed in:
 *
 *   Block-level (parsed line-by-line):
 *     - ATX headings    `# / ## / ### / #### / ##### / ######`
 *     - Setext heading  underline form (rare; skipped — ATX covers it)
 *     - Horizontal rule `---` / `***` / `___`
 *     - Code fences     ```` ``` `` ` ```` and ```` ~~~ ~~~ ```` with optional lang
 *     - Blockquote      `> …` (recursive on adjacent lines)
 *     - Unordered list  `- ` / `* ` / `+ ` (nested via two-space indent)
 *     - Ordered list    `1. … ` / `2) …`
 *     - GFM task lists  `- [ ]` / `- [x]`
 *     - Pipe tables     header row + separator row + body rows
 *     - Paragraph       everything else, joined across consecutive lines
 *
 *   Inline (within block text):
 *     - **bold**, *italic* / _italic_, `inline code`, ~~strike~~
 *     - [label](url) explicit links and bare http(s):// URLs
 *     - Forge tokens:
 *         ![alt](forge-attachment:cuid)        → inline <img>
 *         [filename](forge-attachment:cuid)    → file chip → lightbox
 *         [label](forge-link:https://…)        → external-link chip
 *         bare `KEY-NN`                         → link to issue page
 *         bare `@profileKey`                    → agent mention chip
 *
 * The forge-token pass runs first so a CUID-anchored token always wins
 * over the more permissive markdown link form. forge-link only matches
 * http(s) so other schemes fall through as plain text.
 */

// ---------------------------------------------------------------------------
// Forge primitive tokenization
// ---------------------------------------------------------------------------

const FORGE_ATTACHMENT_RE =
  /(!?)\[([^\]]*)\]\(forge-attachment:([a-z0-9]{20,})\)/gi;
const FORGE_LINK_RE = /\[([^\]]*)\]\(forge-link:(https?:\/\/[^\s)]+)\)/gi;
// Issue refs (KEY-NN) and agent mentions (@profileKey). The lookbehind on
// `@` keeps `email@host` from accidentally matching as a mention.
const REF_RE =
  /(\b[A-Z][A-Z0-9]{1,9}-\d+\b)|(?<=^|[\s(,.;:!?])@([a-z0-9][a-z0-9_-]*)/gi;
// Standard markdown link (used after forge-attachment / forge-link).
// Excludes the `forge-` schemes so they always win their own pass.
const MD_LINK_RE = /\[([^\]]+)\]\((?!forge-)([^)\s]+(?:\s+"[^"]*")?)\)/g;
// Bare URLs — trailing punctuation is stripped during tokenization so a
// URL at the end of a sentence reads naturally.
const URL_RE = /https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"]/g;

type InlineSegment =
  | { type: "text"; value: string }
  | { type: "image"; alt: string; attachmentId: string }
  | { type: "attachmentLink"; label: string; attachmentId: string }
  | { type: "linkChip"; label: string; url: string }
  | { type: "issueRef"; key: string }
  | { type: "mention"; profileKey: string }
  | { type: "mdLink"; label: string; url: string }
  | { type: "url"; url: string }
  | { type: "bold"; children: InlineSegment[] }
  | { type: "italic"; children: InlineSegment[] }
  | { type: "code"; value: string }
  | { type: "strike"; children: InlineSegment[] };

/**
 * Tokenize a single inline text run into a tree of InlineSegments.
 * Forge primitives win first (CUID-anchored), then markdown links and
 * URLs, then inline emphasis / code / strike on the remaining text.
 */
function tokenizeInline(text: string): InlineSegment[] {
  // Pass A: forge-attachment tokens. These are the most specific (CUID
  // tail), so they consume their match space before anything else looks.
  const passA: InlineSegment[] = [];
  let last = 0;
  FORGE_ATTACHMENT_RE.lastIndex = 0;
  for (const m of text.matchAll(FORGE_ATTACHMENT_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) passA.push({ type: "text", value: text.slice(last, idx) });
    const bang = m[1];
    const label = m[2] ?? "";
    const id = m[3] ?? "";
    if (bang === "!") {
      passA.push({ type: "image", alt: label, attachmentId: id });
    } else {
      passA.push({
        type: "attachmentLink",
        label: label || "Attachment",
        attachmentId: id,
      });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) passA.push({ type: "text", value: text.slice(last) });

  // Pass B: forge-link chips on any remaining text spans.
  const passB: InlineSegment[] = [];
  for (const seg of passA) {
    if (seg.type !== "text") {
      passB.push(seg);
      continue;
    }
    const t = seg.value;
    let lo = 0;
    FORGE_LINK_RE.lastIndex = 0;
    for (const m of t.matchAll(FORGE_LINK_RE)) {
      const idx = m.index ?? 0;
      if (idx > lo) passB.push({ type: "text", value: t.slice(lo, idx) });
      const label = (m[1] ?? "").trim();
      const url = m[2] ?? "";
      if (/^https?:\/\//i.test(url)) {
        passB.push({
          type: "linkChip",
          label: label || hostnameOf(url),
          url,
        });
      } else {
        passB.push({ type: "text", value: m[0] });
      }
      lo = idx + m[0].length;
    }
    if (lo < t.length) passB.push({ type: "text", value: t.slice(lo) });
  }

  // Pass C: standard markdown links `[label](url)`.
  const passC: InlineSegment[] = [];
  for (const seg of passB) {
    if (seg.type !== "text") {
      passC.push(seg);
      continue;
    }
    const t = seg.value;
    let lo = 0;
    MD_LINK_RE.lastIndex = 0;
    for (const m of t.matchAll(MD_LINK_RE)) {
      const idx = m.index ?? 0;
      if (idx > lo) passC.push({ type: "text", value: t.slice(lo, idx) });
      const label = (m[1] ?? "").trim();
      const url = (m[2] ?? "").split(/\s+/)[0]; // strip optional " title"
      passC.push({ type: "mdLink", label, url });
      lo = idx + m[0].length;
    }
    if (lo < t.length) passC.push({ type: "text", value: t.slice(lo) });
  }

  // Pass D: issue refs + agent mentions.
  const passD: InlineSegment[] = [];
  for (const seg of passC) {
    if (seg.type !== "text") {
      passD.push(seg);
      continue;
    }
    const t = seg.value;
    let lo = 0;
    REF_RE.lastIndex = 0;
    for (const m of t.matchAll(REF_RE)) {
      const idx = m.index ?? 0;
      if (idx > lo) passD.push({ type: "text", value: t.slice(lo, idx) });
      if (m[1]) passD.push({ type: "issueRef", key: m[1].toUpperCase() });
      else if (m[2])
        passD.push({ type: "mention", profileKey: m[2].toLowerCase() });
      lo = idx + m[0].length;
    }
    if (lo < t.length) passD.push({ type: "text", value: t.slice(lo) });
  }

  // Pass E: bare URLs on what's left.
  const passE: InlineSegment[] = [];
  for (const seg of passD) {
    if (seg.type !== "text") {
      passE.push(seg);
      continue;
    }
    const t = seg.value;
    let lo = 0;
    URL_RE.lastIndex = 0;
    for (const m of t.matchAll(URL_RE)) {
      const idx = m.index ?? 0;
      if (idx > lo) passE.push({ type: "text", value: t.slice(lo, idx) });
      passE.push({ type: "url", url: m[0] });
      lo = idx + m[0].length;
    }
    if (lo < t.length) passE.push({ type: "text", value: t.slice(lo) });
  }

  // Pass F: inline emphasis (bold, italic, code, strikethrough) on
  // remaining text spans. We do this last so emphasis can't "swallow"
  // the URL of an inline link (`*foo [bar](url)*` still highlights the
  // link), and so an attachment chip wrapped in `*…*` works naturally.
  const out: InlineSegment[] = [];
  for (const seg of passE) {
    if (seg.type !== "text") {
      out.push(seg);
      continue;
    }
    out.push(...parseEmphasis(seg.value));
  }
  return out;
}

/**
 * Parse inline emphasis (bold, italic, code, strike). Recursive on the
 * children so `**bold *italic* bold**` nests cleanly. We tokenize on
 * the leftmost matching delimiter at each step to keep the algorithm
 * O(n) and avoid the classic GFM ambiguity around overlapping runs.
 */
function parseEmphasis(text: string): InlineSegment[] {
  if (!text) return [];
  const out: InlineSegment[] = [];

  // Inline code wins first — its contents are opaque (no further parsing).
  const codeRe = /`([^`\n]+)`/;
  const codeMatch = text.match(codeRe);
  if (codeMatch && codeMatch.index !== undefined) {
    if (codeMatch.index > 0)
      out.push(...parseEmphasis(text.slice(0, codeMatch.index)));
    out.push({ type: "code", value: codeMatch[1] });
    out.push(
      ...parseEmphasis(text.slice(codeMatch.index + codeMatch[0].length)),
    );
    return out;
  }

  // Bold (**…** or __…__)
  const boldRe = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/;
  const boldMatch = text.match(boldRe);
  if (boldMatch && boldMatch.index !== undefined) {
    if (boldMatch.index > 0)
      out.push(...parseEmphasis(text.slice(0, boldMatch.index)));
    const inner = boldMatch[1] ?? boldMatch[2] ?? "";
    out.push({ type: "bold", children: parseEmphasis(inner) });
    out.push(
      ...parseEmphasis(text.slice(boldMatch.index + boldMatch[0].length)),
    );
    return out;
  }

  // Strikethrough (~~…~~)
  const strikeRe = /~~([^~\n]+?)~~/;
  const strikeMatch = text.match(strikeRe);
  if (strikeMatch && strikeMatch.index !== undefined) {
    if (strikeMatch.index > 0)
      out.push(...parseEmphasis(text.slice(0, strikeMatch.index)));
    out.push({
      type: "strike",
      children: parseEmphasis(strikeMatch[1] ?? ""),
    });
    out.push(
      ...parseEmphasis(text.slice(strikeMatch.index + strikeMatch[0].length)),
    );
    return out;
  }

  // Italic (*…* or _…_). The non-greedy run + a guard against the
  // delimiter starting a list marker (` * ` at line start is a list,
  // already consumed at block level by the time we get here).
  const italicRe = /(?<!\w)\*([^*\n]+?)\*(?!\w)|(?<!\w)_([^_\n]+?)_(?!\w)/;
  const italicMatch = text.match(italicRe);
  if (italicMatch && italicMatch.index !== undefined) {
    if (italicMatch.index > 0)
      out.push(...parseEmphasis(text.slice(0, italicMatch.index)));
    const inner = italicMatch[1] ?? italicMatch[2] ?? "";
    out.push({ type: "italic", children: parseEmphasis(inner) });
    out.push(
      ...parseEmphasis(text.slice(italicMatch.index + italicMatch[0].length)),
    );
    return out;
  }

  out.push({ type: "text", value: text });
  return out;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "link";
  }
}

// ---------------------------------------------------------------------------
// Block-level parser
// ---------------------------------------------------------------------------

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "hr" }
  | { type: "code"; lang: string; code: string }
  | { type: "blockquote"; lines: string[] }
  | {
      type: "list";
      ordered: boolean;
      items: { text: string; checked: boolean | null }[];
    }
  | { type: "table"; header: string[]; rows: string[][]; align: Align[] }
  | { type: "paragraph"; text: string }
  | { type: "dataBlock"; block: DataBlock }
  | { type: "dataBlockInvalid"; raw: string; reason: string }
  | { type: "artifactEmbed"; artifactId: string }
  | { type: "mediaPreview"; url: string; media: DirectMediaKind }
  | { type: "urlEmbed"; match: EmbedMatch };

type Align = "left" | "center" | "right" | null;
type DirectMediaKind = "image" | "video";

export type PreviewControlState = {
  hidden: boolean;
  collapsed: boolean;
  menuOpen: boolean;
};

type PreviewControlAction =
  | { type: "toggleMenu" }
  | { type: "closeMenu" }
  | { type: "toggleCollapsed" }
  | { type: "hide" }
  | { type: "show" };

const INITIAL_PREVIEW_CONTROL_STATE: PreviewControlState = {
  hidden: false,
  collapsed: false,
  menuOpen: false,
};

export function reducePreviewControlState(
  state: PreviewControlState,
  action: PreviewControlAction,
): PreviewControlState {
  switch (action.type) {
    case "toggleMenu":
      return { ...state, menuOpen: !state.menuOpen };
    case "closeMenu":
      return { ...state, menuOpen: false };
    case "toggleCollapsed":
      return { ...state, collapsed: !state.collapsed, menuOpen: false };
    case "hide":
      return { ...state, hidden: true, menuOpen: false };
    case "show":
      return { hidden: false, collapsed: false, menuOpen: false };
  }
}

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpg", "jpeg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "ogg", "ogv", "webm"]);

function directMediaKind(url: string): DirectMediaKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const last = parsed.pathname.split("/").pop() ?? "";
  const ext = last.includes(".") ? last.split(".").pop()?.toLowerCase() : null;
  if (!ext) return null;
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function directMediaUrlsInText(text: string): Array<{ url: string; media: DirectMediaKind }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; media: DirectMediaKind }> = [];
  URL_RE.lastIndex = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    if (seen.has(url)) continue;
    const media = directMediaKind(url);
    if (!media) continue;
    seen.add(url);
    out.push({ url, media });
  }
  return out;
}

function isHr(line: string): boolean {
  const t = line.trim();
  return /^(-{3,}|\*{3,}|_{3,})$/.test(t);
}

function tableAlignFromSeparator(sep: string): Align[] | null {
  const cells = splitTableRow(sep);
  if (cells.length === 0) return null;
  const aligns: Align[] = [];
  for (const c of cells) {
    const t = c.trim();
    if (!/^:?-{3,}:?$/.test(t) && !/^:?-+:?$/.test(t)) return null;
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

function splitTableRow(line: string): string[] {
  // Strip a leading and trailing pipe, then split on pipes that aren't
  // escaped. Cells get trimmed by the caller.
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  // Negative lookbehind for backslash escaping.
  return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function parseBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const out: Block[] = [];
  let i = 0;

  function consumeParagraph(start: number): { block: Block; nextI: number } {
    const buf: string[] = [];
    let j = start;
    while (j < lines.length) {
      const ln = lines[j];
      if (ln.trim() === "") break;
      if (
        /^#{1,6}\s/.test(ln) ||
        ln.startsWith("```") ||
        ln.startsWith("~~~") ||
        isHr(ln) ||
        /^\s*[-*+]\s/.test(ln) ||
        /^\s*\d+[.)]\s/.test(ln) ||
        /^\s*>\s?/.test(ln) ||
        /^:::(data|artifact)\b/i.test(ln)
      )
        break;
      buf.push(ln);
      j++;
    }
    return {
      block: { type: "paragraph", text: buf.join("\n") },
      nextI: j,
    };
  }

  while (i < lines.length) {
    const ln = lines[i];

    // Blank line — collapses; we just skip it. Block boundaries are
    // already implicit in the parser.
    if (ln.trim() === "") {
      i++;
      continue;
    }

    // `:::data <kind>` directive — agents emit structured payloads
    // (table/list/kv) wrapped in a fenced data block. Parser bails
    // gracefully on bad JSON / unknown kinds by emitting a
    // `dataBlockInvalid` block that renders as a warning + code fallback.
    if (/^:::data\s+/i.test(ln)) {
      const r = tryParseDataBlock(lines, i);
      if (r) {
        if (r.ok) out.push({ type: "dataBlock", block: r.block });
        else out.push({ type: "dataBlockInvalid", raw: r.raw, reason: r.reason });
        i += Math.max(r.consumed, 1);
        continue;
      }
    }

    // `:::artifact <id>` directive — inline-render a linked artifact.
    // We require a CUID-shaped id to avoid swallowing accidental
    // `:::artifact` text. The block ends on `:::` (single-line form is
    // legal too if the closer is on the next line).
    const artifactDirective = ln.match(/^:::artifact\s+([a-z0-9]{20,})\s*$/i);
    if (artifactDirective) {
      let j = i + 1;
      // Optional `:::` closer on the next line.
      if (j < lines.length && /^:::\s*$/.test(lines[j])) j++;
      out.push({ type: "artifactEmbed", artifactId: artifactDirective[1] });
      i = j;
      continue;
    }

    // Lone URL on a line that we know how to embed — promote to a
    // block-level embed card. Only triggers when the line is *just*
    // the URL (after trimming), so URLs mid-prose still render
    // inline as links.
    {
      const t = ln.trim();
      if (/^https?:\/\//i.test(t) && !/\s/.test(t)) {
        const media = directMediaKind(t);
        if (media) {
          out.push({ type: "mediaPreview", url: t, media });
          i++;
          continue;
        }
        const m = matchEmbedUrl(t);
        if (m) {
          out.push({ type: "urlEmbed", match: m });
          i++;
          continue;
        }
      }
    }

    // Code fence (``` or ~~~)
    const fenceMatch = ln.match(/^(```|~~~)(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = (fenceMatch[2] ?? "").trim().toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      out.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // ATX heading
    const headingMatch = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      out.push({ type: "heading", level, text: headingMatch[2] });
      i++;
      continue;
    }

    // Horizontal rule
    if (isHr(ln)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    // Blockquote — consume a contiguous block of `>`-prefixed lines.
    if (/^\s*>\s?/.test(ln)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // Table — header row + separator row + at least 0 body rows. We
    // require the next line to be a valid alignment separator before
    // committing; otherwise the line is just a paragraph that happens
    // to contain pipes.
    if (ln.includes("|") && i + 1 < lines.length) {
      const sep = lines[i + 1];
      if (sep && sep.includes("|") && sep.includes("-")) {
        const align = tableAlignFromSeparator(sep);
        if (align) {
          const header = splitTableRow(ln);
          // Pad align to header width
          while (align.length < header.length) align.push(null);
          const rows: string[][] = [];
          let j = i + 2;
          while (
            j < lines.length &&
            lines[j].includes("|") &&
            lines[j].trim() !== ""
          ) {
            const row = splitTableRow(lines[j]);
            // Pad / truncate to header width so cell layout stays stable
            while (row.length < header.length) row.push("");
            rows.push(row.slice(0, header.length));
            j++;
          }
          out.push({ type: "table", header, rows, align });
          i = j;
          continue;
        }
      }
    }

    // Unordered list (-, *, +). Captures task-list checkboxes.
    if (/^\s*[-*+]\s/.test(ln)) {
      const items: { text: string; checked: boolean | null }[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        let item = lines[i].replace(/^\s*[-*+]\s+/, "");
        let checked: boolean | null = null;
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          checked = task[1].toLowerCase() === "x";
          item = task[2];
        }
        // Continuation lines: indented further by at least 2 spaces.
        let k = i + 1;
        while (
          k < lines.length &&
          lines[k].trim() !== "" &&
          !/^\s*[-*+]\s/.test(lines[k]) &&
          !/^\s*\d+[.)]\s/.test(lines[k]) &&
          /^\s{2,}/.test(lines[k])
        ) {
          item += "\n" + lines[k].replace(/^\s{2}/, "");
          k++;
        }
        items.push({ text: item, checked });
        i = k;
      }
      out.push({ type: "list", ordered: false, items });
      continue;
    }

    // Ordered list (1., 2., 1) etc.)
    if (/^\s*\d+[.)]\s/.test(ln)) {
      const items: { text: string; checked: boolean | null }[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        const item = lines[i].replace(/^\s*\d+[.)]\s+/, "");
        let k = i + 1;
        let merged = item;
        while (
          k < lines.length &&
          lines[k].trim() !== "" &&
          !/^\s*[-*+]\s/.test(lines[k]) &&
          !/^\s*\d+[.)]\s/.test(lines[k]) &&
          /^\s{2,}/.test(lines[k])
        ) {
          merged += "\n" + lines[k].replace(/^\s{2}/, "");
          k++;
        }
        items.push({ text: merged, checked: null });
        i = k;
      }
      out.push({ type: "list", ordered: true, items });
      continue;
    }

    // Paragraph — soak up consecutive non-block lines.
    const para = consumeParagraph(i);
    out.push(para.block);
    i = para.nextI;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Inline collection: walk every block and collect ordered attachment refs
// so the lightbox pager can flip through them on click.
// ---------------------------------------------------------------------------

function collectInlineAttachments(
  blocks: Block[],
): { id: string; label: string; isImage: boolean }[] {
  const out: { id: string; label: string; isImage: boolean }[] = [];
  function walk(text: string) {
    for (const seg of tokenizeInline(text)) {
      walkSeg(seg);
    }
  }
  function walkSeg(seg: InlineSegment) {
    if (seg.type === "image")
      out.push({ id: seg.attachmentId, label: seg.alt || "image", isImage: true });
    else if (seg.type === "attachmentLink")
      out.push({ id: seg.attachmentId, label: seg.label, isImage: false });
    else if (
      seg.type === "bold" ||
      seg.type === "italic" ||
      seg.type === "strike"
    )
      for (const c of seg.children) walkSeg(c);
  }
  for (const b of blocks) {
    if (b.type === "heading") walk(b.text);
    else if (b.type === "paragraph") walk(b.text);
    else if (b.type === "blockquote") walk(b.lines.join("\n"));
    else if (b.type === "list") for (const it of b.items) walk(it.text);
    else if (b.type === "table") {
      for (const h of b.header) walk(h);
      for (const r of b.rows) for (const c of r) walk(c);
    }
    // code blocks: opaque, no inline tokenization.
  }
  return out;
}

// ---------------------------------------------------------------------------
// React render
// ---------------------------------------------------------------------------

type InlineList = { id: string; label: string; isImage: boolean }[];

function renderInlineSegs(
  segs: InlineSegment[],
  inlineList: InlineList,
  keyBase: string,
): ReactNode[] {
  return segs.map((s, i) => {
    const key = `${keyBase}-${i}`;
    if (s.type === "text") return <Fragment key={key}>{s.value}</Fragment>;
    if (s.type === "image")
      return (
        <InlineAttachmentImage
          key={key}
          attachmentId={s.attachmentId}
          alt={s.alt}
          inlineList={inlineList}
        />
      );
    if (s.type === "attachmentLink")
      return (
        <InlineAttachmentLink
          key={key}
          attachmentId={s.attachmentId}
          label={s.label}
          inlineList={inlineList}
        />
      );
    if (s.type === "linkChip") {
      if (!isSafeExternalUrl(s.url)) {
        return <Fragment key={key}>{s.label || s.url}</Fragment>;
      }
      return <InlineForgeLink key={key} label={s.label} url={s.url} />;
    }
    if (s.type === "issueRef")
      return <InlineIssueRef key={key} issueKey={s.key} />;
    if (s.type === "mention")
      return <InlineAgentMention key={key} profileKey={s.profileKey} />;
    if (s.type === "mdLink") {
      // Explicit allowlist: http(s) links open in a new tab, and internal
      // app paths (e.g. `/w/foo/issues/abc`) get an in-app Link. Everything
      // else renders as inert text so `javascript:` / `data:` never become
      // clickable browser-controlled hrefs.
      const renderable = toRenderableHref(s.url);
      if (renderable?.kind === "external") {
        return (
          <a
            key={key}
            href={renderable.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ember underline-offset-2 hover:underline"
          >
            {s.label || renderable.href}
          </a>
        );
      }
      if (renderable?.kind === "internal") {
        return (
          <Link
            key={key}
            href={renderable.href}
            className="text-ember underline-offset-2 hover:underline"
          >
            {s.label || renderable.href}
          </Link>
        );
      }
      return <Fragment key={key}>{s.label || s.url}</Fragment>;
    }
    if (s.type === "url")
      return (
        <a
          key={key}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ember underline-offset-2 hover:underline"
        >
          {s.url}
        </a>
      );
    if (s.type === "bold")
      return (
        <strong key={key} className="font-semibold text-foreground">
          {renderInlineSegs(s.children, inlineList, key)}
        </strong>
      );
    if (s.type === "italic")
      return (
        <em key={key} className="italic">
          {renderInlineSegs(s.children, inlineList, key)}
        </em>
      );
    if (s.type === "strike")
      return (
        <span key={key} className="line-through text-muted-foreground">
          {renderInlineSegs(s.children, inlineList, key)}
        </span>
      );
    if (s.type === "code")
      return (
        <code
          key={key}
          className="rounded border border-border/60 bg-subtle/60 px-1 py-px font-mono text-[0.85em] text-foreground"
        >
          {s.value}
        </code>
      );
    return null;
  });
}

function renderInline(
  text: string,
  inlineList: InlineList,
  keyBase: string,
): ReactNode[] {
  return renderInlineSegs(tokenizeInline(text), inlineList, keyBase);
}

/**
 * Public component. Same API as the previous flat renderer — accepts a
 * `body: string` and an optional `className`. The wrapping div renders
 * block children with consistent vertical rhythm; no `whitespace-pre-wrap`
 * because the block parser handles spacing structurally now.
 */
export function MarkdownWithAttachments({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseBlocks(body ?? ""), [body]);
  const inlineList = useMemo(() => collectInlineAttachments(blocks), [blocks]);

  if (!body || blocks.length === 0) {
    return <div className={className} />;
  }

  return (
    <div className={`${className ?? ""} forge-md min-w-0 break-words`}>
      {blocks.map((b, i) => renderBlock(b, i, inlineList))}
    </div>
  );
}

export const RichContentRenderer = MarkdownWithAttachments;

function renderBlock(
  block: Block,
  idx: number,
  inlineList: InlineList,
): ReactNode {
  const k = `b-${idx}`;
  if (block.type === "heading") {
    const sizeClass =
      block.level === 1
        ? "mt-3 mb-2 text-[0.9375rem] font-semibold tracking-tight"
        : block.level === 2
          ? "mt-3 mb-1.5 text-[0.875rem] font-semibold tracking-tight"
          : block.level === 3
            ? "mt-2.5 mb-1 text-[0.8125rem] font-semibold tracking-tight"
            : "mt-2 mb-0.5 text-[0.75rem] font-semibold uppercase tracking-wider text-muted-foreground";
    const inner = renderInline(block.text, inlineList, k);
    // Switch is verbose but keeps element type narrowed; tried a
    // `keyof JSX.IntrinsicElements` cast first but tsc balks on the
    // dynamic-string-to-IntrinsicElements widening in strict mode.
    switch (block.level) {
      case 1:
        return <h1 key={k} className={sizeClass}>{inner}</h1>;
      case 2:
        return <h2 key={k} className={sizeClass}>{inner}</h2>;
      case 3:
        return <h3 key={k} className={sizeClass}>{inner}</h3>;
      case 4:
        return <h4 key={k} className={sizeClass}>{inner}</h4>;
      case 5:
        return <h5 key={k} className={sizeClass}>{inner}</h5>;
      default:
        return <h6 key={k} className={sizeClass}>{inner}</h6>;
    }
  }
  if (block.type === "hr") {
    return <hr key={k} className="my-3 border-border" />;
  }
  if (block.type === "code") {
    return <CodeBlock key={k} code={block.code} lang={block.lang} />;
  }
  if (block.type === "blockquote") {
    return (
      <blockquote
        key={k}
        className="my-2 border-l-2 border-ember/50 bg-subtle/30 px-3 py-1 text-foreground/85"
      >
        {/* Recursively parse the inner lines so quoted markdown still
            renders (nested lists, code, etc. inside a quote). */}
        <MarkdownWithAttachments body={block.lines.join("\n")} />
      </blockquote>
    );
  }
  if (block.type === "list") {
    if (block.ordered) {
      return (
        <ol key={k} className="my-1.5 ml-5 list-decimal space-y-0.5 marker:text-muted-foreground marker:font-mono marker:text-[0.85em]">
          {block.items.map((it, j) => (
            <li key={`${k}-${j}`} className="pl-0.5">
              {renderInline(it.text, inlineList, `${k}-${j}`)}
            </li>
          ))}
        </ol>
      );
    }
    return (
      <ul key={k} className="my-1.5 space-y-0.5">
        {block.items.map((it, j) => (
          <li key={`${k}-${j}`} className="flex gap-2">
            {it.checked === null ? (
              <span aria-hidden className="mt-1 shrink-0 text-ember/80">
                •
              </span>
            ) : (
              <span
                aria-hidden
                className={`mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                  it.checked
                    ? "border-ember bg-ember/20 text-ember"
                    : "border-border bg-background"
                }`}
              >
                {it.checked ? "✓" : ""}
              </span>
            )}
            <span className={it.checked ? "text-muted-foreground line-through" : undefined}>
              {renderInline(it.text, inlineList, `${k}-${j}`)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (block.type === "dataBlock") {
    const db = block.block;
    if (db.kind === "table")
      return <DataBlockTable key={k} payload={db.payload} />;
    if (db.kind === "list")
      return <DataBlockList key={k} payload={db.payload} />;
    return <DataBlockKV key={k} payload={db.payload} />;
  }
  if (block.type === "dataBlockInvalid") {
    return (
      <div key={k} className="my-2 overflow-hidden rounded-md border border-border bg-card/40">
        <div className="flex items-center gap-2 border-b border-border/60 bg-card/60 px-3 py-1">
          <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
          <span className="font-mono text-[0.625rem] uppercase tracking-wider text-warning">
            invalid :::data block
          </span>
          <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
            {block.reason}
          </span>
        </div>
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.75rem] leading-relaxed text-foreground">
          <code>{block.raw}</code>
        </pre>
      </div>
    );
  }
  if (block.type === "artifactEmbed") {
    return <ArtifactEmbed key={k} artifactId={block.artifactId} />;
  }
  if (block.type === "mediaPreview") {
    return (
      <DirectMediaPreview
        key={k}
        url={block.url}
        media={block.media}
      />
    );
  }
  if (block.type === "urlEmbed") {
    const m = block.match;
    if (m.kind === "youtube")
      return (
        <PreviewControls key={k} url={m.payload.url} label="YouTube preview">
          <YouTubeEmbed videoId={m.payload.videoId} url={m.payload.url} />
        </PreviewControls>
      );
    if (m.kind === "github")
      return (
        <PreviewControls key={k} url={m.payload.url} label="GitHub preview">
          <GithubEmbed
            owner={m.payload.owner}
            repo={m.payload.repo}
            number={m.payload.number}
            type={m.payload.type}
            url={m.payload.url}
          />
        </PreviewControls>
      );
    if (m.kind === "loom")
      return (
        <PreviewControls key={k} url={m.payload.url} label="Loom preview">
          <LoomEmbed videoId={m.payload.videoId} url={m.payload.url} />
        </PreviewControls>
      );
    if (m.kind === "figma")
      return (
        <PreviewControls key={k} url={m.payload.url} label="Figma preview">
          <FigmaEmbed embedUrl={m.payload.embedUrl} url={m.payload.url} />
        </PreviewControls>
      );
    return null;
  }
  if (block.type === "table") {
    return (
      <div
        key={k}
        className="my-2 overflow-x-auto rounded-md border border-border bg-card/30"
      >
        <table className="w-full border-collapse text-[0.8125rem]">
          <thead>
            <tr className="border-b border-border bg-card/60">
              {block.header.map((h, j) => (
                <th
                  key={`${k}-h-${j}`}
                  className={`px-2 py-1.5 text-left font-semibold ${alignClass(block.align[j])}`}
                >
                  {renderInline(h, inlineList, `${k}-h-${j}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, j) => (
              <tr
                key={`${k}-r-${j}`}
                className="border-b border-border/40 last:border-b-0"
              >
                {row.map((c, l) => (
                  <td
                    key={`${k}-r-${j}-${l}`}
                    className={`px-2 py-1.5 align-top text-foreground/90 ${alignClass(block.align[l])}`}
                  >
                    {renderInline(c, inlineList, `${k}-r-${j}-${l}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // Paragraph — preserve hard newlines inside paragraphs (a real
  // newline in the source between paragraph lines stays as a <br/>).
  const mediaUrls = directMediaUrlsInText(block.text);
  if (mediaUrls.length === 0) {
    return (
      <p key={k} className="my-1.5 whitespace-pre-wrap leading-relaxed">
        {renderInline(block.text, inlineList, k)}
      </p>
    );
  }
  return (
    <Fragment key={k}>
      <p className="my-1.5 whitespace-pre-wrap leading-relaxed">
        {renderInline(block.text, inlineList, k)}
      </p>
      {mediaUrls.map((it, mediaIdx) => (
        <DirectMediaPreview
          key={`${k}-media-${mediaIdx}`}
          url={it.url}
          media={it.media}
        />
      ))}
    </Fragment>
  );
}

function alignClass(a: Align): string {
  if (a === "left") return "text-left";
  if (a === "right") return "text-right";
  if (a === "center") return "text-center";
  return "";
}

// ---------------------------------------------------------------------------
// Code block — preformatted with a copy button. No syntax highlighter
// is bundled (avoids ~250kb of prism/shiki on every page); the language
// label sits above the block so engineers still get the at-a-glance
// signal.
// ---------------------------------------------------------------------------
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const reactId = useId();
  function handleCopy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="relative my-2 overflow-hidden rounded-md border border-border bg-card/40">
      <div className="flex items-center justify-between border-b border-border/60 bg-card/60 px-3 py-1">
        <span className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          id={`copy-${reactId}`}
          className="focus-ring rounded border border-border/60 bg-background/70 px-1.5 py-0.5 font-sans text-[0.625rem] text-muted-foreground hover:bg-background hover:text-foreground"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.75rem] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "media";
  }
}

function PreviewControls({
  url,
  label,
  children,
}: {
  url: string;
  label: string;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(
    reducePreviewControlState,
    INITIAL_PREVIEW_CONTROL_STATE,
  );
  const { hidden, collapsed, menuOpen } = state;
  const host = hostLabel(url);

  if (hidden) {
    return (
      <div className="my-2 flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-meta text-ember underline-offset-2 hover:underline"
        >
          {url}
        </a>
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "show" });
          }}
          className="focus-ring shrink-0 rounded border border-border bg-background/80 px-1.5 py-0.5 text-meta text-muted-foreground hover:bg-background hover:text-foreground"
        >
          Show preview
        </button>
      </div>
    );
  }

  return (
    <div className="group/preview relative my-2">
      <div className="flex min-w-0 items-center justify-between gap-2 rounded-t-md border border-b-0 border-border bg-card/60 px-2 py-1">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-meta text-muted-foreground underline-offset-2 hover:text-ember hover:underline"
          title={url}
        >
          {label} · {host}
        </a>
        <div className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => dispatch({ type: "toggleMenu" })}
            onBlur={() => window.setTimeout(() => dispatch({ type: "closeMenu" }), 120)}
            className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
            title="Preview actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-7 z-20 w-36 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  dispatch({ type: "toggleCollapsed" });
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta hover:bg-subtle"
              >
                {collapsed ? (
                  <Maximize2 className="h-3.5 w-3.5" />
                ) : (
                  <Minimize2 className="h-3.5 w-3.5" />
                )}
                {collapsed ? "Expand" : "Collapse"}
              </button>
              <a
                role="menuitem"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded px-2 py-1.5 text-meta hover:bg-subtle"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open link
              </a>
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  dispatch({ type: "hide" });
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta hover:bg-subtle"
              >
                <EyeOff className="h-3.5 w-3.5" />
                Hide
              </button>
            </div>
          )}
        </div>
      </div>
      {collapsed ? (
        <div className="rounded-b-md border border-border bg-card/30 px-2 py-1.5">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-meta text-ember underline-offset-2 hover:underline"
          >
            {url}
          </a>
        </div>
      ) : (
        <div className="overflow-hidden rounded-b-md border border-border bg-card/30">
          {children}
        </div>
      )}
    </div>
  );
}

function DirectMediaPreview({
  url,
  media,
}: {
  url: string;
  media: DirectMediaKind;
}) {
  return (
    <PreviewControls
      url={url}
      label={media === "image" ? "Image preview" : "Video preview"}
    >
      {media === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          className="max-h-96 w-full object-contain"
        />
      ) : (
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-96 w-full bg-subtle"
        >
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open video
          </a>
        </video>
      )}
    </PreviewControls>
  );
}

// ---------------------------------------------------------------------------
// Inline forge primitive components
// (Same behaviour as before — these are the leaves the inline renderer
// produces. UnavailablePill, InlineAttachmentImage, InlineAttachmentLink,
// InlineForgeLink, InlineIssueRef, InlineAgentMention.)
// ---------------------------------------------------------------------------

function inlineListToAttachments(inlineList: InlineList): AttachmentLite[] {
  return inlineList.map((it) => ({
    id: it.id,
    filename: it.label,
    mimeType: it.isImage ? "image/*" : "",
    size: 0,
    kind: "FILE" as const,
    externalUrl: null,
  }));
}

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
  inlineList: InlineList;
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
  if (error) return <UnavailablePill label={alt} errorMessage={error.message} />;
  if (!data?.url) return <UnavailablePill label={alt} />;
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

function InlineIssueRef({ issueKey }: { issueKey: string }) {
  const ws = useMaybeWorkspace();
  if (!ws) {
    return <span className="font-mono text-[0.75rem]">{issueKey}</span>;
  }
  return (
    <IssueHoverPreview issueKey={issueKey} workspaceSlug={ws.slug}>
      <Link
        href={`/w/${ws.slug}/i/${issueKey}`}
        className="font-mono text-[0.75rem] text-ember underline-offset-2 hover:underline"
        title={`Open ${issueKey}`}
      >
        {issueKey}
      </Link>
    </IssueHoverPreview>
  );
}

function InlineAgentMention({ profileKey }: { profileKey: string }) {
  // The token namespace is shared with `@handle` user mentions; the
  // hover preview tries agent first, falls back to user. Chip styling
  // stays agent-themed (indigo + Bot glyph) because the common case
  // is an agent ping; if the token resolves as a user, the popover
  // surface reflects that.
  return (
    <AgentHoverPreview token={profileKey}>
      <span
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1 py-0.5 font-mono text-[0.6875rem] text-indigo-700 dark:text-indigo-300"
        title={`@${profileKey}`}
      >
        <Bot className="h-3 w-3" />@{profileKey}
      </span>
    </AgentHoverPreview>
  );
}

function InlineForgeLink({ label, url }: { label: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} — ${url}`}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.6875rem] hover:border-ember/40 hover:bg-subtle"
    >
      <LinkFavicon url={url} size={12} />
      <span className="truncate">{label}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground/60" />
    </a>
  );
}

function InlineAttachmentLink({
  attachmentId,
  label,
  inlineList,
}: {
  attachmentId: string;
  label: string;
  inlineList: InlineList;
}) {
  const lightbox = useAttachmentLightbox();
  const { error } = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId },
    { staleTime: 5 * 60_000, retry: false },
  );
  if (error) return <UnavailablePill label={label} errorMessage={error.message} />;
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
