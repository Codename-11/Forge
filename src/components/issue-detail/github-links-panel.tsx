"use client";

import { useState } from "react";
import { ExternalLink, GitPullRequest, Github, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { GitHubLinkModal } from "@/components/issue-detail/github-link-modal";

function kindLabel(kind: string): string {
  if (kind === "SOURCE") return "source";
  if (kind === "IMPLEMENTS") return "implements";
  if (kind === "REVIEWS") return "reviews";
  return "related";
}

function stateLabel(state: string): string {
  if (state === "merged") return "merged";
  if (state === "draft") return "draft";
  return state || "unknown";
}

export function GitHubLinksPanel({ issueId }: { issueId: string }) {
  const utils = trpc.useUtils();
  const [modalOpen, setModalOpen] = useState(false);

  const { data: links, isLoading } = trpc.github.listLinked.useQuery(
    { issueId },
    { staleTime: 30_000 },
  );
  const syncM = trpc.github.sync.useMutation({
    onSuccess: () => {
      toast.success("GitHub state synced.");
      void utils.github.listLinked.invalidate({ issueId });
      void utils.issue.byId.invalidate({ id: issueId });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="rounded-md border border-border bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <Github className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
          GitHub
        </span>
        <span className="font-mono text-[0.625rem] text-muted-foreground">
          {links?.length ?? 0}
        </span>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="focus-ring ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
          title="Link a GitHub issue or PR"
        >
          <Plus className="h-3 w-3" />
          Link
        </button>
      </div>

      <div className="space-y-2 p-2.5">
        {isLoading ? (
          <div className="text-meta text-muted-foreground">Loading links...</div>
        ) : links && links.length > 0 ? (
          <div className="space-y-1.5">
            {links.map((link) => {
              const resource = link.externalResource;
              const isPr = resource.resourceType === "PULL_REQUEST";
              return (
                <div
                  key={link.id}
                  className="rounded-md border border-border bg-background/70 p-2"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {isPr ? (
                      <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Github className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <a
                        href={resource.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-[0.8125rem] font-medium hover:underline"
                        title={resource.title}
                      >
                        {resource.title}
                      </a>
                      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
                        <span className="font-mono">
                          {resource.repoFullName}#{resource.number}
                        </span>
                        <span>{kindLabel(link.kind)}</span>
                        <span>{stateLabel(resource.state)}</span>
                        {resource.lastSyncedAt && (
                          <span>synced {relativeTime(resource.lastSyncedAt)}</span>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2"
                      title="Sync from GitHub"
                      disabled={syncM.isPending}
                      onClick={() => syncM.mutate({ externalResourceId: resource.id })}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                    <a
                      href={resource.url}
                      target="_blank"
                      rel="noreferrer"
                      className="focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
                      title="Open in GitHub"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-background/60 p-2.5 text-meta text-muted-foreground hover:border-border hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Link a GitHub issue or PR
          </button>
        )}
      </div>

      <GitHubLinkModal issueId={issueId} open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
