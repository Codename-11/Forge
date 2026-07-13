"use client";

import { useState } from "react";
import { ExternalLink, Play } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * YouTube embed card. Renders the thumbnail first (cheap), and swaps
 * to an iframe player on click — the standard "play poster" pattern.
 * Avoids loading the YouTube player JS for every comment thread.
 *
 * Metadata (title, author) comes from `embed.fetch`, which hits the
 * public oembed endpoint and caches the result in Redis for 24h.
 */
export function YouTubeEmbed({
  videoId,
  url,
}: {
  videoId: string;
  url: string;
}) {
  const ws = useMaybeWorkspace();
  const enabled = !!ws;
  const q = trpc.embed.fetch.useQuery(
    { url },
    {
      enabled,
      staleTime: 5 * 60_000,
      retry: false,
    },
  );
  const [playing, setPlaying] = useState(false);

  const oembed = q.data?.kind === "youtube" ? q.data.oembed : null;
  const thumb =
    oembed?.thumbnailUrl ??
    `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-card/40">
      <div className="relative aspect-video w-full bg-subtle">
        {playing ? (
          <iframe
            src={`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0`}
            title={oembed?.title ?? "YouTube video"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-presentation"
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group absolute inset-0 flex h-full w-full items-center justify-center"
            aria-label={`Play ${oembed?.title ?? "YouTube video"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span className="relative z-10 flex h-12 w-12 items-center justify-center rounded-full bg-background/90 text-ember shadow-lg ring-1 ring-border transition group-hover:scale-105 group-hover:bg-background">
              <Play className="ml-0.5 h-5 w-5 fill-current" />
            </span>
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-card/60 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.8125rem] font-medium text-foreground">
            {q.isLoading ? (
              <span className="inline-block h-3 w-32 animate-pulse rounded bg-subtle align-middle" />
            ) : (
              (oembed?.title ?? "YouTube")
            )}
          </div>
          <div className="truncate text-[0.6875rem] text-muted-foreground">
            {oembed?.authorName ? `${oembed.authorName} · youtube.com` : "youtube.com"}
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex items-center gap-1 rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label="Open YouTube video in a new tab"
          title="Open on YouTube"
        >
          <ExternalLink className="h-3 w-3" /> Open
        </a>
      </div>
    </div>
  );
}
