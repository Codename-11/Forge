"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { RelationKind } from "@prisma/client";
import { ArrowRight, CheckCircle2, Plus, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { formatIssueId } from "@/lib/utils";

export type IssueBlockerRelation = {
  relationId: string;
  target: {
    id: string;
    number: number;
    title: string;
    statusCategory: string;
  };
};

export function activeIssueBlockers(rows: IssueBlockerRelation[]): IssueBlockerRelation[] {
  return rows.filter(
    (row) => row.target.statusCategory !== "DONE" && row.target.statusCategory !== "CANCELED",
  );
}

function useIssueBlockers(issueId: string) {
  const query = trpc.relation.listForIssue.useQuery(
    { issueId },
    {
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  );
  const all = (query.data?.[RelationKind.BLOCKED_BY] ?? []) as IssueBlockerRelation[];
  return { ...query, all, active: activeIssueBlockers(all) };
}

export function IssueBlockerControl({ issueId }: { issueId: string }) {
  const [open, setOpen] = useState(false);
  const { active, all } = useIssueBlockers(issueId);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={
          active.length > 0
            ? "border-warning/50 bg-warning/10 text-warning hover:bg-warning/15"
            : "text-muted-foreground"
        }
      >
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
        {active.length > 0 ? `Blocked · ${active.length}` : "Set blocker"}
      </Button>
      <BlockerDialog
        issueId={issueId}
        open={open}
        onClose={() => setOpen(false)}
        existingTargetIds={new Set(all.map((row) => row.target.id))}
      />
    </>
  );
}

export function IssueBlockerBanner({ issueId }: { issueId: string }) {
  const workspace = useWorkspace();
  const utils = trpc.useUtils();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { active, all, isLoading } = useIssueBlockers(issueId);
  const remove = trpc.relation.remove.useMutation({
    onSuccess: () => {
      void utils.relation.listForIssue.invalidate({ issueId });
      void utils.issue.byId.invalidate({ id: issueId });
      void utils.issue.list.invalidate();
      toast.success("Blocker removed.");
    },
    onError: (error) => toast.error(error.message),
  });

  if (isLoading || active.length === 0) return null;

  return (
    <>
      <section
        className="mb-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-3"
        aria-labelledby="issue-blocked-heading"
        data-testid="issue-blocker-banner"
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-warning/10 text-warning">
            <ShieldAlert className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 id="issue-blocked-heading" className="text-sm font-semibold text-warning">
                Blocked by {active.length} open {active.length === 1 ? "issue" : "issues"}
              </h2>
              <span className="text-meta text-muted-foreground">
                Clears automatically when every blocker is done or canceled.
              </span>
            </div>
            <ul className="mt-2 divide-y divide-border/70 overflow-hidden rounded-md border border-border bg-background/55">
              {active.map((row) => (
                <li key={row.relationId} className="flex min-w-0 items-center gap-2 px-2.5 py-2">
                  <Link
                    href={`/w/${workspace.slug}/issues/${row.target.id}`}
                    className="group flex min-w-0 flex-1 items-center gap-2 hover:text-ember"
                  >
                    <span className="text-id shrink-0 text-muted-foreground">
                      {formatIssueId(workspace.key, row.target.number)}
                    </span>
                    <span className="truncate text-xs font-medium">{row.target.title}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </Link>
                  <button
                    type="button"
                    onClick={() => remove.mutate({ relationId: row.relationId })}
                    disabled={remove.isPending}
                    className="focus-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-danger disabled:opacity-40"
                    aria-label={`Remove blocker ${formatIssueId(workspace.key, row.target.number)}`}
                    title="Remove blocker"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 h-6 px-1.5 text-muted-foreground"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="h-3 w-3" aria-hidden /> Add another blocker
            </Button>
          </div>
        </div>
      </section>
      <BlockerDialog
        issueId={issueId}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        existingTargetIds={new Set(all.map((row) => row.target.id))}
      />
    </>
  );
}

function BlockerDialog({
  issueId,
  open,
  onClose,
  existingTargetIds,
}: {
  issueId: string;
  open: boolean;
  onClose: () => void;
  existingTargetIds: Set<string>;
}) {
  const workspace = useWorkspace();
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const search = trpc.issue.list.useQuery(
    { query: query.trim() || undefined, includeDone: false, limit: 10 },
    { enabled: open, staleTime: 15_000 },
  );
  const candidates = useMemo(
    () =>
      (search.data?.items ?? []).filter(
        (candidate) => candidate.id !== issueId && !existingTargetIds.has(candidate.id),
      ),
    [existingTargetIds, issueId, search.data?.items],
  );
  const add = trpc.relation.add.useMutation({
    onSuccess: () => {
      void utils.relation.listForIssue.invalidate({ issueId });
      void utils.issue.byId.invalidate({ id: issueId });
      void utils.issue.list.invalidate();
      setQuery("");
      onClose();
      toast.success("Issue marked blocked.");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-warning/10 text-warning">
            <ShieldAlert className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Set an issue blocker</h2>
            <p className="text-meta mt-0.5 text-muted-foreground">
              This issue stays blocked until the selected issue is done, canceled, or removed.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring ml-auto grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
            aria-label="Close blocker dialog"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </header>
      <div className="p-4">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by issue key or title…"
          aria-label="Search issues to use as a blocker"
          autoFocus
        />
        <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border">
          {search.isLoading ? (
            <div className="text-meta p-4 text-center text-muted-foreground">Loading issues…</div>
          ) : candidates.length === 0 ? (
            <div className="text-meta flex flex-col items-center gap-2 p-5 text-center text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
              {query.trim() ? "No matching open issues." : "No additional open issues available."}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() =>
                      add.mutate({
                        fromIssueId: issueId,
                        toIssueId: candidate.id,
                        kind: RelationKind.BLOCKED_BY,
                      })
                    }
                    disabled={add.isPending}
                    className="focus-ring flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left hover:bg-subtle/45 disabled:opacity-40"
                  >
                    <span className="text-id shrink-0 text-muted-foreground">
                      {formatIssueId(workspace.key, candidate.number)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {candidate.title}
                    </span>
                    <Badge className="shrink-0" color={candidate.status.color}>
                      {candidate.status.name}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-meta mt-3 text-muted-foreground">
          Need a person or decision instead? Use <span className="font-mono">/blocked reason</span>{" "}
          in a comment to open an operator-attention request.
        </p>
      </div>
    </Dialog>
  );
}
