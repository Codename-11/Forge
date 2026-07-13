"use client";

import { useState } from "react";
import { ExternalLink, Play } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Loom embed card. Same "play poster → iframe on click" pattern as the
 * YouTube embed. The poster URL comes from Loom's public thumbnail
 * endpoint (`cdn.loom.com/sessions/thumbnails/<id>-with-play.gif`); if
 * it 404s we just show a blank player tile with the play button.
 */
export function LoomEmbed({
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
    { enabled, staleTime: 5 * 60_000, retry: false },
  );
  const [playing, setPlaying] = useState(false);
  const [posterErr, setPosterErr] = useState(false);

  const loom = q.data?.kind === "loom" ? q.data.loom : null;
  const iframeUrl =
    loom?.iframeUrl ?? `https://www.loom.com/embed/${encodeURIComponent(videoId)}`;
  const thumb = loom?.thumbnailUrl ?? null;

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-card/40">
      <div className="relative aspect-video w-full bg-subtle">
        {playing ? (
          <iframe
            src={`${iframeUrl}?autoplay=1`}
            title="Loom video"
            allow="autoplay; fullscreen; clipboard-write; picture-in-picture"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-presentation"
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group absolute inset-0 flex h-full w-full items-center justify-center"
            aria-label="Play Loom video"
          >
            {thumb && !posterErr ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={thumb}
                alt=""
                loading="lazy"
                onError={() => setPosterErr(true)}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : null}
            <span className="relative z-10 flex h-12 w-12 items-center justify-center rounded-full bg-background/90 text-ember shadow-lg ring-1 ring-border transition group-hover:scale-105 group-hover:bg-background">
              <Play className="ml-0.5 h-5 w-5 fill-current" />
            </span>
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-card/60 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.8125rem] font-medium text-foreground">
            Loom recording
          </div>
          <div className="truncate text-[0.6875rem] text-muted-foreground">
            loom.com · {videoId.slice(0, 8)}
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex items-center gap-1 rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label="Open Loom recording in a new tab"
          title="Open on Loom"
        >
          <ExternalLink className="h-3 w-3" /> Open
        </a>
      </div>
    </div>
  );
}
