/**
 * URL pattern matcher for inline oembed-style cards. We don't call any
 * external discovery endpoints — every supported provider gets a hand-
 * rolled matcher that returns `{ kind, payload }` so the renderer can
 * pick the right component.
 *
 * v1 providers: YouTube, GitHub, Loom, Figma. Unknown URLs return
 * `null` and fall through to the plain-link branch.
 */

export type EmbedMatch =
  | {
      kind: "youtube";
      payload: { videoId: string; url: string };
    }
  | {
      kind: "github";
      payload: {
        owner: string;
        repo: string;
        number: number;
        type: "pull" | "issue";
        url: string;
      };
    }
  | {
      kind: "loom";
      payload: { videoId: string; url: string };
    }
  | {
      kind: "figma";
      payload: { embedUrl: string; url: string };
    };

const YT_HOST_RE = /^(?:www\.|m\.)?youtube\.com$/i;
const YT_SHORT_RE = /^(?:www\.)?youtu\.be$/i;
const LOOM_HOST_RE = /^(?:www\.)?loom\.com$/i;
const GITHUB_HOST_RE = /^(?:www\.)?github\.com$/i;
const FIGMA_HOST_RE = /^(?:www\.)?figma\.com$/i;

/** Test whether a URL looks like *anything* we can embed. Cheap O(1). */
export function isEmbeddable(url: string): boolean {
  return matchEmbedUrl(url) !== null;
}

/**
 * Try to parse a URL into an EmbedMatch. Returns `null` for anything
 * we can't handle — the caller falls back to the standard URL pass.
 */
export function matchEmbedUrl(url: string): EmbedMatch | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  // YouTube (long form)
  if (YT_HOST_RE.test(u.hostname)) {
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) {
      return { kind: "youtube", payload: { videoId: v, url } };
    }
    // /embed/<id> or /shorts/<id>
    const seg = u.pathname.split("/").filter(Boolean);
    if (
      (seg[0] === "embed" || seg[0] === "shorts") &&
      seg[1] &&
      /^[A-Za-z0-9_-]{6,}$/.test(seg[1])
    ) {
      return { kind: "youtube", payload: { videoId: seg[1], url } };
    }
  }
  // YouTube (short form youtu.be/<id>)
  if (YT_SHORT_RE.test(u.hostname)) {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
      return { kind: "youtube", payload: { videoId: id, url } };
    }
  }

  // GitHub PR / Issue
  if (GITHUB_HOST_RE.test(u.hostname)) {
    const seg = u.pathname.split("/").filter(Boolean);
    // /<owner>/<repo>/(pull|issues)/<n>
    if (seg.length >= 4 && (seg[2] === "pull" || seg[2] === "issues")) {
      const n = Number(seg[3]);
      if (Number.isFinite(n) && n > 0) {
        return {
          kind: "github",
          payload: {
            owner: seg[0],
            repo: seg[1],
            number: n,
            type: seg[2] === "pull" ? "pull" : "issue",
            url,
          },
        };
      }
    }
  }

  // Loom (share + embed forms)
  if (LOOM_HOST_RE.test(u.hostname)) {
    const seg = u.pathname.split("/").filter(Boolean);
    if (
      (seg[0] === "share" || seg[0] === "embed") &&
      seg[1] &&
      /^[a-f0-9]{16,}$/i.test(seg[1])
    ) {
      return { kind: "loom", payload: { videoId: seg[1], url } };
    }
  }

  // Figma (file / design / proto)
  if (FIGMA_HOST_RE.test(u.hostname)) {
    const seg = u.pathname.split("/").filter(Boolean);
    if (
      (seg[0] === "file" || seg[0] === "design" || seg[0] === "proto") &&
      seg[1]
    ) {
      // The recommended embed pattern is to wrap the original URL in
      // figma.com/embed?embed_host=share&url=<...>. That covers
      // /file, /design, and /proto without needing to know which
      // surface the user shared.
      const embedUrl = `https://www.figma.com/embed?embed_host=forge&url=${encodeURIComponent(url)}`;
      return { kind: "figma", payload: { embedUrl, url } };
    }
  }

  return null;
}
