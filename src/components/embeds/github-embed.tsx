"use client";

import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  Circle,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * GitHub PR / issue card. Compact two-line treatment so it sits inline
 * with prose rather than blowing up like a video embed. Mirrors the
 * GitHub status color signal (open/green, closed/red, merged/purple,
 * draft/grey) using token-derived colors only — we don't import the
 * raw GitHub palette, just hint at it.
 */
export function GithubEmbed({
  owner,
  repo,
  number,
  type,
  url,
}: {
  owner: string;
  repo: string;
  number: number;
  type: "pull" | "issue";
  url: string;
}) {
  const ws = useMaybeWorkspace();
  const enabled = !!ws;
  const q = trpc.embed.fetch.useQuery(
    { url },
    { enabled, staleTime: 5 * 60_000, retry: false },
  );
  const data = q.data?.kind === "github" ? q.data.github : null;
  const state = data?.state ?? null;

  const Icon = chooseIcon(type, state);
  const stateLabel = chooseLabel(type, state);
  const stateClass = chooseTone(state);

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-card/40">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded ${stateClass}`}
          title={stateLabel}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              {owner}/{repo}
            </span>
            <span className="font-mono text-[0.6875rem] text-muted-foreground/60">
              #{number}
            </span>
            <span
              className={`rounded border px-1 py-0 font-mono text-[0.625rem] uppercase tracking-wider ${chooseBadge(state)}`}
            >
              {stateLabel}
            </span>
          </div>
          <div className="truncate text-[0.8125rem] font-medium text-foreground">
            {q.isLoading ? (
              <span className="inline-block h-3 w-48 animate-pulse rounded bg-subtle align-middle" />
            ) : (
              (data?.title ?? `${type === "pull" ? "Pull request" : "Issue"} #${number}`)
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data?.commentsCount != null ? (
            <span
              className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground"
              title={`${data.commentsCount} comments`}
            >
              <MessageSquare className="h-3 w-3" />
              {data.commentsCount}
            </span>
          ) : null}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex items-center gap-1 rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground hover:bg-background hover:text-foreground"
            title="Open on GitHub"
          >
            <ExternalLink className="h-3 w-3" /> Open
          </a>
        </div>
      </div>
    </div>
  );
}

function chooseIcon(type: "pull" | "issue", state: string | null) {
  if (type === "issue") {
    if (state === "closed") return XCircle;
    return Circle;
  }
  // pull
  if (state === "merged") return GitMerge;
  if (state === "closed") return GitPullRequestClosed;
  if (state === "draft") return GitPullRequestDraft;
  return GitPullRequest;
}

function chooseLabel(type: "pull" | "issue", state: string | null): string {
  if (!state) return type === "pull" ? "Pull request" : "Issue";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function chooseTone(state: string | null): string {
  switch (state) {
    case "open":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "merged":
      return "bg-purple-500/15 text-purple-600 dark:text-purple-400";
    case "closed":
      return "bg-rose-500/15 text-rose-600 dark:text-rose-400";
    case "draft":
      return "bg-subtle text-muted-foreground";
    default:
      return "bg-subtle text-muted-foreground";
  }
}

function chooseBadge(state: string | null): string {
  switch (state) {
    case "open":
      return "border-emerald-500/30 text-emerald-700 dark:text-emerald-400";
    case "merged":
      return "border-purple-500/30 text-purple-700 dark:text-purple-400";
    case "closed":
      return "border-rose-500/30 text-rose-700 dark:text-rose-400";
    case "draft":
      return "border-border text-muted-foreground";
    default:
      return "border-border text-muted-foreground";
  }
}

