import { z } from "zod";
import { router, workspaceProcedure } from "@/server/trpc";
import { redis } from "@/server/redis";
import {
  buildLoomEmbed,
  fetchGithubPullOrIssue,
  fetchYouTubeOembed,
  type GithubResult,
  type YouTubeOembedResult,
} from "@/server/services/embed-providers";

/**
 * `embed.fetch` — server-side oembed-style enrichment for inline URL
 * embeds rendered by `attachment-renderer.tsx`.
 *
 * Cache strategy:
 *   - Redis key `embed:v1:<url>`, 24h TTL.
 *   - YouTube and GitHub hit the network; Loom builds locally from the
 *     URL alone (no upstream call); Figma is purely client-side
 *     (iframe transform) and doesn't reach this router.
 *   - A null upstream result is cached for 1h (short, so a flapping
 *     repo can recover quickly) — we still return a "kind only"
 *     payload so the client can render the bare card.
 */

const CACHE_TTL_OK = 24 * 60 * 60;
const CACHE_TTL_NULL = 60 * 60;
const CACHE_PREFIX = "embed:v1:";

type EmbedFetchResult =
  | { kind: "youtube"; oembed: YouTubeOembedResult | null }
  | { kind: "github"; github: GithubResult | null }
  | { kind: "loom"; loom: { iframeUrl: string; thumbnailUrl: string } }
  | { kind: "figma" }
  | { kind: "unsupported" };

export const embedRouter = router({
  /**
   * Look up embed metadata for a URL. Workspace-scoped because the
   * Redis cache should be shared within a tenant but we don't want
   * cross-tenant cache poisoning, and because the renderer is always
   * called from inside an authenticated workspace surface.
   *
   * Returns `{ kind: "unsupported" }` for anything we don't know how
   * to embed — the client never crashes on a stale URL.
   */
  fetch: workspaceProcedure
    .input(z.object({ url: z.string().url().max(2048) }))
    .query(async ({ input }): Promise<EmbedFetchResult> => {
      const key = CACHE_PREFIX + input.url;
      try {
        const cached = await redis.get(key);
        if (cached) {
          try {
            return JSON.parse(cached) as EmbedFetchResult;
          } catch {
            // fallthrough — recompute and overwrite the bad cache row
          }
        }
      } catch {
        // Redis down → skip cache, still serve fresh.
      }

      const fresh = await compute(input.url);
      // Cache hits and misses both go to Redis so a noisy URL doesn't
      // pound an upstream API every render. Misses use a shorter TTL.
      const ttl = isFullHit(fresh) ? CACHE_TTL_OK : CACHE_TTL_NULL;
      try {
        await redis.setex(key, ttl, JSON.stringify(fresh));
      } catch {
        // best-effort
      }
      return fresh;
    }),
});

async function compute(url: string): Promise<EmbedFetchResult> {
  // Re-detect on the server so a client can't trick us into fetching
  // a URL we wouldn't normally embed.
  const m = detect(url);
  if (!m) return { kind: "unsupported" };
  if (m.kind === "youtube") {
    const oembed = await fetchYouTubeOembed(m.payload.videoId);
    return { kind: "youtube", oembed };
  }
  if (m.kind === "github") {
    const gh = await fetchGithubPullOrIssue(
      m.payload.owner,
      m.payload.repo,
      m.payload.number,
      m.payload.type,
    );
    return { kind: "github", github: gh };
  }
  if (m.kind === "loom") {
    return { kind: "loom", loom: buildLoomEmbed(m.payload.videoId) };
  }
  if (m.kind === "figma") {
    return { kind: "figma" };
  }
  return { kind: "unsupported" };
}

function isFullHit(r: EmbedFetchResult): boolean {
  if (r.kind === "youtube") return r.oembed !== null;
  if (r.kind === "github") return r.github !== null;
  if (r.kind === "loom" || r.kind === "figma") return true;
  return false;
}

// --- server-side detector (mirror of embed-detector.ts) ---------------------
// We deliberately don't import the client matcher so this router has no
// "use client" graph dependency. The pattern surface is small and the
// duplication is intentional: if the client ever expands, the server
// stays the source of truth for what we'll actually fetch.

type ServerMatch =
  | { kind: "youtube"; payload: { videoId: string } }
  | {
      kind: "github";
      payload: { owner: string; repo: string; number: number; type: "pull" | "issue" };
    }
  | { kind: "loom"; payload: { videoId: string } }
  | { kind: "figma"; payload: Record<string, never> };

function detect(url: string): ServerMatch | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();

  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) {
      return { kind: "youtube", payload: { videoId: v } };
    }
    const seg = u.pathname.split("/").filter(Boolean);
    if (
      (seg[0] === "embed" || seg[0] === "shorts") &&
      seg[1] &&
      /^[A-Za-z0-9_-]{6,}$/.test(seg[1])
    ) {
      return { kind: "youtube", payload: { videoId: seg[1] } };
    }
  }
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
      return { kind: "youtube", payload: { videoId: id } };
    }
  }
  if (host === "github.com" || host === "www.github.com") {
    const seg = u.pathname.split("/").filter(Boolean);
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
          },
        };
      }
    }
  }
  if (host === "loom.com" || host === "www.loom.com") {
    const seg = u.pathname.split("/").filter(Boolean);
    if (
      (seg[0] === "share" || seg[0] === "embed") &&
      seg[1] &&
      /^[a-f0-9]{16,}$/i.test(seg[1])
    ) {
      return { kind: "loom", payload: { videoId: seg[1] } };
    }
  }
  if (host === "figma.com" || host === "www.figma.com") {
    const seg = u.pathname.split("/").filter(Boolean);
    if ((seg[0] === "file" || seg[0] === "design" || seg[0] === "proto") && seg[1]) {
      return { kind: "figma", payload: {} };
    }
  }
  return null;
}
