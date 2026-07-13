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
      <div className="flex min-w-0 items-start gap-2 px-2.5 py-1.5 sm:items-center">
        <span
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded ${stateClass}`}
          title={stateLabel}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">
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
        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
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
            aria-label={`Open ${owner}/${repo} ${type === "pull" ? "pull request" : "issue"} #${number} on GitHub`}
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
      return "bg-success/15 text-success";
    case "merged":
      return "bg-ember/15 text-ember";
    case "closed":
      return "bg-danger/15 text-danger";
    case "draft":
      return "bg-subtle text-muted-foreground";
    default:
      return "bg-subtle text-muted-foreground";
  }
}

function chooseBadge(state: string | null): string {
  switch (state) {
    case "open":
      return "border-success/30 text-success";
    case "merged":
      return "border-ember/30 text-ember";
    case "closed":
      return "border-danger/30 text-danger";
    case "draft":
      return "border-border text-muted-foreground";
    default:
      return "border-border text-muted-foreground";
  }
}
