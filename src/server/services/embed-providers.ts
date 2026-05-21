import "server-only";

/**
 * Server-side embed enrichment for known URL providers.
 *
 * The client renders the embed component immediately (so a Loom or
 * YouTube iframe shows up without a round trip), and asynchronously
 * calls `embed.fetch` to enrich the card with title, author, thumbnail,
 * PR state, etc. Each provider has its own helper here — kept small
 * and self-contained so a single broken integration can't cascade.
 *
 * All upstream fetches are wrapped in a 5 s timeout via AbortController
 * and tolerate failure: on any network/parse error the helper returns
 * `null` (or a "could not enrich" shape). The caller decides whether
 * to short-circuit cache writes on null.
 */

const FETCH_TIMEOUT_MS = 5_000;

export type YouTubeOembedResult = {
  title: string | null;
  authorName: string | null;
  authorUrl: string | null;
  thumbnailUrl: string | null;
};

export type GithubResult = {
  type: "pull" | "issue";
  number: number;
  owner: string;
  repo: string;
  title: string | null;
  state: "open" | "closed" | "merged" | "draft" | null;
  authorLogin: string | null;
  authorAvatar: string | null;
  commentsCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export async function fetchYouTubeOembed(
  videoId: string,
): Promise<YouTubeOembedResult | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`;
  try {
    const res = await fetchWithTimeout(oembedUrl, {
      headers: { "user-agent": "forge-embed-fetcher/1.0" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return {
      title: pickString(json, "title"),
      authorName: pickString(json, "author_name"),
      authorUrl: pickString(json, "author_url"),
      thumbnailUrl:
        pickString(json, "thumbnail_url") ??
        `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

export async function fetchGithubPullOrIssue(
  owner: string,
  repo: string,
  number: number,
  type: "pull" | "issue",
): Promise<GithubResult | null> {
  // GitHub treats pulls as a superset of issues — fetching the issue
  // endpoint works for both (PRs come back with the same shape, just
  // missing the `merged` field). To get `merged`/`draft` we hit the
  // pull endpoint when type === "pull".
  const endpoint =
    type === "pull"
      ? `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`
      : `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/issues/${number}`;
  try {
    const headers: Record<string, string> = {
      "user-agent": "forge-embed-fetcher/1.0",
      accept: "application/vnd.github+json",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetchWithTimeout(endpoint, { headers });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;

    let state: GithubResult["state"] = pickString(json, "state") as
      | "open"
      | "closed"
      | null;
    if (type === "pull") {
      if (json.merged === true) state = "merged";
      else if (json.draft === true && state === "open") state = "draft";
    }

    const user = (json.user ?? {}) as Record<string, unknown>;
    return {
      type,
      number,
      owner,
      repo,
      title: pickString(json, "title"),
      state,
      authorLogin: pickString(user, "login"),
      authorAvatar: pickString(user, "avatar_url"),
      commentsCount:
        typeof json.comments === "number"
          ? (json.comments as number)
          : null,
      createdAt: pickString(json, "created_at"),
      updatedAt: pickString(json, "updated_at"),
    };
  } catch {
    return null;
  }
}

/**
 * Loom doesn't expose a public oEmbed endpoint we can trust without an
 * auth token. We just return the iframe URL and the canonical thumbnail
 * — Loom serves a public thumbnail at `cdn.loom.com/sessions/thumbnails/
 * <id>-with-play.gif`. If the thumbnail 404s the client falls back to
 * the player iframe directly.
 */
export function buildLoomEmbed(videoId: string): {
  iframeUrl: string;
  thumbnailUrl: string;
} {
  return {
    iframeUrl: `https://www.loom.com/embed/${encodeURIComponent(videoId)}`,
    thumbnailUrl: `https://cdn.loom.com/sessions/thumbnails/${encodeURIComponent(videoId)}-with-play.gif`,
  };
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function pickString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" ? v : null;
}
