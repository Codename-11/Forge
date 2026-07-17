"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  GitPullRequest,
  Github,
  Plus,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { formatDate, relativeTime } from "@/lib/utils";
import { GitHubLinkModal } from "@/components/issue-detail/github-link-modal";

function kindLabel(kind: string): string {
  if (kind === "SOURCE") return "source";
  if (kind === "IMPLEMENTS") return "implements";
  if (kind === "FIXES") return "fixes / closes";
  if (kind === "RELEASES") return "release contains implementation";
  if (kind === "REVIEWS") return "reviews";
  return "related";
}

function stateLabel(state: string): string {
  if (state === "merged") return "merged";
  if (state === "draft") return "draft";
  return state || "unknown";
}

function stateDescription(state: string): string {
  if (state === "merged") return "GitHub reports that this pull request was merged.";
  if (state === "draft") return "This pull request is still marked as a draft in GitHub.";
  if (state === "open") return "This pull request is open and has not been merged.";
  if (state === "closed") return "This pull request was closed without being merged.";
  return "Forge has not received a recognized GitHub state for this item.";
}

function stateTone(state: string): string {
  if (state === "merged") return "border-success/30 bg-success/10 text-success";
  if (state === "draft") return "border-warning/30 bg-warning/10 text-warning";
  if (state === "closed") return "border-danger/30 bg-danger/10 text-danger";
  return "border-border/70 bg-subtle/50 text-foreground";
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    <div id="github-links" className="scroll-mt-20 rounded-md border border-border bg-card/40">
      <div
        className={`flex items-center gap-2 px-2.5 py-2 ${links && links.length > 0 ? "border-b border-border/60" : ""}`}
      >
        <Github className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
          GitHub
        </span>
        <span className="font-mono text-[0.625rem] text-muted-foreground">
          {isLoading ? "…" : (links?.length ?? 0)}
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

      {links && links.length > 0 ? (
        <div className="space-y-2 p-2.5">
          <div className="space-y-1.5">
            {links.map((link) => {
              const resource = link.externalResource;
              const isPr = resource.resourceType === "PULL_REQUEST";
              const terminalPr =
                isPr && (resource.state === "merged" || resource.state === "closed");
              const metadata = metadataRecord(resource.metadata);
              const head = metadataRecord(metadata.head);
              const checks = metadataRecord(metadata.checks);
              const review = metadataRecord(metadata.review);
              const reviewDecision =
                typeof metadata.reviewDecision === "string"
                  ? metadata.reviewDecision
                  : typeof review.decision === "string"
                    ? review.decision
                    : null;
              const checksLabel = terminalPr
                ? null
                : checks.partial === true
                  ? "checks partial"
                  : typeof checks.conclusion === "string"
                    ? `checks ${checks.conclusion}`
                    : typeof checks.status === "string"
                      ? `checks ${checks.status}`
                      : null;
              return (
                <div key={link.id} className="rounded-md border border-border bg-background/70 p-2">
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
                        <span className="font-medium text-foreground">{kindLabel(link.kind)}</span>
                        <Tooltip content={stateDescription(resource.state)}>
                          <span
                            tabIndex={0}
                            className={`rounded-full border px-1.5 py-0.5 font-medium ${stateTone(resource.state)}`}
                          >
                            {stateLabel(resource.state)}
                          </span>
                        </Tooltip>
                        {resource.lastSyncedAt && (
                          <span>synced {relativeTime(resource.lastSyncedAt)}</span>
                        )}
                      </div>
                      {isPr && (
                        <details className="group mt-2 text-[0.6875rem] text-muted-foreground">
                          <summary className="focus-ring flex cursor-pointer list-none items-center justify-between rounded border border-border/70 bg-subtle/30 px-2 py-1 font-medium transition-colors hover:border-border hover:bg-subtle/70 hover:text-foreground group-open:border-border group-open:bg-subtle/60 [&::-webkit-details-marker]:hidden">
                            <span>GitHub evidence</span>
                            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                          </summary>
                          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-1">
                            {typeof head.ref === "string" && (
                              <span className="max-w-full truncate font-mono" title={head.ref}>
                                {head.ref}
                              </span>
                            )}
                            {terminalPr && typeof metadata.mergedAt === "string" ? (
                              <span>merged {relativeTime(metadata.mergedAt)}</span>
                            ) : (
                              <>
                                {reviewDecision && (
                                  <span>{reviewDecision.toLowerCase().replaceAll("_", " ")}</span>
                                )}
                                {checksLabel && <span>{checksLabel}</span>}
                                {typeof metadata.mergeableState === "string" && (
                                  <span>merge {metadata.mergeableState}</span>
                                )}
                              </>
                            )}
                          </div>
                        </details>
                      )}
                      {resource.syncLastError && (
                        <div
                          className="mt-1 flex items-start gap-1 text-[0.6875rem] text-warning"
                          title={resource.syncLastError}
                        >
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span className="line-clamp-2">
                            GitHub refresh delayed
                            {resource.syncRetryAt
                              ? ` · retry ${formatDate(resource.syncRetryAt, undefined, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}`
                              : ""}
                          </span>
                        </div>
                      )}
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
        </div>
      ) : null}

      <GitHubLinkModal issueId={issueId} open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
