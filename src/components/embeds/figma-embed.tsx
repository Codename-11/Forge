"use client";

import { ExternalLink, Figma as FigmaIcon } from "lucide-react";

/**
 * Figma embed card. Uses Figma's documented `/embed?embed_host=…&url=`
 * iframe URL — no metadata fetch is needed (Figma doesn't expose a
 * public oembed endpoint for free accounts). We keep the player a bit
 * taller than YouTube/Loom because design files benefit from real
 * estate, but cap it so a thread doesn't get hijacked by a single
 * frame.
 */
export function FigmaEmbed({
  embedUrl,
  url,
}: {
  embedUrl: string;
  url: string;
}) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-card/40">
      <div className="relative h-[360px] w-full bg-subtle">
        <iframe
          src={embedUrl}
          title="Figma file"
          allow="fullscreen"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          className="absolute inset-0 h-full w-full"
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-card/60 px-2.5 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FigmaIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-[0.8125rem] font-medium text-foreground">
              Figma file
            </div>
            <div className="truncate text-[0.6875rem] text-muted-foreground">
              figma.com
            </div>
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex items-center gap-1 rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground hover:bg-background hover:text-foreground"
          title="Open in Figma"
        >
          <ExternalLink className="h-3 w-3" /> Open
        </a>
      </div>
    </div>
  );
}
