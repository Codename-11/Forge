"use client";

import { useRef, useState, type ReactNode } from "react";
import { Bot, ChevronDown, GitBranch, GitPullRequest, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GitHubLinkModal } from "@/components/issue-detail/github-link-modal";
import { GitHubLinksPanel } from "@/components/issue-detail/github-links-panel";
import { WorkCoordinationPanel } from "@/components/issue-detail/work-coordination-panel";
import { trpc } from "@/lib/trpc";

/** One discoverable entry point; opening it never assigns, dispatches, or claims work. */
export function IssueAutomationPanel({
  issueId,
  issueKey,
  onAskAgent,
  onAssignAgent,
  children,
}: {
  issueId: string;
  issueKey: string;
  onAskAgent: () => void;
  onAssignAgent: () => void;
  /** The existing workstream, including latest outcome and approval controls. */
  children?: ReactNode;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const {
    data: sessions,
    isLoading,
    isError,
  } = trpc.workSession.listForIssue.useQuery(
    { issueId },
    { staleTime: 10_000, refetchOnWindowFocus: true },
  );
  const activeSession = sessions?.find(
    (session) => !["VERIFIED", "ABANDONED"].includes(session.status),
  );
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };

  return (
    <section
      id="issue-automation"
      tabIndex={-1}
      aria-label="Automation and delivery"
      className="min-w-0 scroll-mt-20 rounded-lg border border-border bg-card/30"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-medium">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Automation &amp; delivery
        </h2>
      </div>
      <div className="space-y-2 px-3 pb-3">
        <details
          ref={menuRef}
          className="group rounded-md border border-border/70 bg-background/50"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeMenu();
              menuRef.current?.querySelector("summary")?.focus();
            }
          }}
        >
          <summary className="focus-ring flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 py-2 text-xs hover:bg-subtle/60 [&::-webkit-details-marker]:hidden">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Add agent or delivery…
            <ChevronDown
              className="ml-auto h-3 w-3 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div className="space-y-1 border-t border-border/60 p-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-auto w-full justify-start gap-2 py-2 text-left"
              onClick={() => {
                closeMenu();
                onAskAgent();
              }}
            >
              <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 whitespace-normal">
                <span className="block">Ask an agent</span>
                <span className="text-meta block font-normal text-muted-foreground">
                  Choose Discuss, Research, Review, or Execute
                </span>
              </span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-auto w-full justify-start gap-2 py-2 text-left"
              onClick={() => {
                closeMenu();
                setLinkOpen(true);
              }}
            >
              <GitPullRequest className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Link implementation PR
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              title="Assign agent"
              className="h-auto w-full justify-start gap-2 py-2 text-left"
              onClick={() => {
                closeMenu();
                onAssignAgent();
              }}
            >
              <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Assign an agent
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-auto w-full justify-start gap-2 py-2 text-left"
              disabled={isLoading || isError || Boolean(activeSession)}
              onClick={() => {
                closeMenu();
                setCreateOpen(true);
              }}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Start delivery session
            </Button>
            {activeSession && (
              <p className="text-meta px-2 pb-1 text-muted-foreground">
                This issue already has an open delivery session. Use its controls below.
              </p>
            )}
            {isError && (
              <p className="text-meta px-2 pb-1 text-warning">
                Check existing delivery ownership before starting a session. Retry below.
              </p>
            )}
          </div>
        </details>
        {children}
        <WorkCoordinationPanel
          issueId={issueId}
          issueKey={issueKey}
          embedded
          createOpen={createOpen}
          onCreateOpenChange={setCreateOpen}
        />
        <GitHubLinksPanel issueId={issueId} embedded />
      </div>
      <GitHubLinkModal
        issueId={issueId}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        defaultKind="IMPLEMENTS"
      />
    </section>
  );
}
