"use client";
import { useEffect, useState } from "react";
import { Sparkles, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * AI triage suggestion card. Renders above the issue description when the
 * suggestion is READY. Shows what the model proposed, lets the operator
 * apply (all or in part) or dismiss. Hidden once aiTriageStatus is
 * APPLIED / DISMISSED, and shows a loading state when PENDING.
 */

interface Issue {
  id: string;
  aiTriageStatus: "PENDING" | "READY" | "APPLIED" | "DISMISSED" | "ERROR" | null;
  aiSuggestedPriority:
    | "NONE"
    | "LOW"
    | "MEDIUM"
    | "HIGH"
    | "URGENT"
    | null;
  aiSuggestedLabelIds: string[];
  aiSuggestedAgentId: string | null;
  aiTriageReasoning: string | null;
  aiTriagedAt: Date | string | null;
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  assignedAgent: { id: string; profileKey: string; name: string } | null;
  labels: Array<{ labelId: string }>;
}

const PRIORITY_LABEL: Record<Issue["priority"], string> = {
  NONE: "None",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

const PRIORITY_TONE: Record<Issue["priority"], string> = {
  NONE: "bg-muted/40 text-muted-foreground",
  LOW: "bg-muted/40 text-muted-foreground",
  MEDIUM: "bg-amber-200/15 text-amber-300",
  HIGH: "bg-orange-300/15 text-orange-200",
  URGENT: "bg-red-400/15 text-red-200",
};

export function AiTriageCard({ issue }: { issue: Issue }) {
  const utils = trpc.useUtils();
  const { data: allLabels } = trpc.label.list.useQuery();
  const { data: agents } = trpc.agent.list.useQuery();
  const status = issue.aiTriageStatus;

  // Local controls — operator can deselect parts of the suggestion before
  // pressing Apply. Default everything on; flip off if the suggested value
  // would be a no-op.
  const [applyPriority, setApplyPriority] = useState(true);
  const [applyLabels, setApplyLabels] = useState(true);
  const [applyAgent, setApplyAgent] = useState(true);

  useEffect(() => {
    if (issue.aiSuggestedPriority === issue.priority) setApplyPriority(false);
    if (issue.aiSuggestedAgentId === (issue.assignedAgent?.id ?? null))
      setApplyAgent(false);
  }, [
    issue.aiSuggestedPriority,
    issue.priority,
    issue.aiSuggestedAgentId,
    issue.assignedAgent,
  ]);

  const apply = trpc.ai.triageApply.useMutation({
    onSuccess: () => {
      toast.success("Triage applied.");
      utils.issue.byId.invalidate({ id: issue.id });
      utils.issue.activity.invalidate({ issueId: issue.id });
    },
    onError: (e) => toast.error(e.message),
  });
  const dismiss = trpc.ai.triageDismiss.useMutation({
    onSuccess: () => utils.issue.byId.invalidate({ id: issue.id }),
    onError: (e) => toast.error(e.message),
  });
  const rerun = trpc.ai.triageRerun.useMutation({
    onSuccess: () => {
      toast.success("Re-running triage...");
      utils.issue.byId.invalidate({ id: issue.id });
    },
    onError: (e) => toast.error(e.message),
  });

  // Soft-poll while PENDING so the card updates without realtime wiring.
  const refetch = utils.issue.byId.refetch;
  useEffect(() => {
    if (status !== "PENDING") return;
    const t = window.setInterval(() => {
      void refetch({ id: issue.id });
    }, 2000);
    return () => window.clearInterval(t);
  }, [status, refetch, issue.id]);

  if (!status) return null;
  if (status === "APPLIED" || status === "DISMISSED") return null;

  if (status === "PENDING") {
    return (
      <div className="mb-5 flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 animate-pulse text-amber-300" />
        <span>Triaging…</span>
      </div>
    );
  }

  if (status === "ERROR") {
    return (
      <div className="mb-5 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground/70" />
          <span>AI triage unavailable.</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => rerun.mutate({ issueId: issue.id })}
          disabled={rerun.isPending}
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Retry
        </Button>
      </div>
    );
  }

  // READY
  const labelLookup = new Map(
    (allLabels ?? []).map((l) => [l.id, l]),
  );
  const agentLookup = new Map((agents ?? []).map((a) => [a.id, a]));

  const newLabels = issue.aiSuggestedLabelIds.filter(
    (id) => !issue.labels.some((l) => l.labelId === id),
  );
  const suggestedAgent = issue.aiSuggestedAgentId
    ? agentLookup.get(issue.aiSuggestedAgentId)
    : null;
  const priorityChanged =
    issue.aiSuggestedPriority &&
    issue.aiSuggestedPriority !== issue.priority;

  const nothingToApply =
    !priorityChanged && newLabels.length === 0 && !suggestedAgent;

  return (
    <div className="mb-5 rounded-lg border border-amber-300/20 bg-amber-300/[0.03] p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-amber-300" />
          <span className="text-[0.6875rem] font-medium uppercase tracking-wider text-amber-200/80">
            AI triage suggestion
          </span>
        </div>
        <button
          type="button"
          onClick={() => dismiss.mutate({ issueId: issue.id })}
          className="text-muted-foreground hover:text-foreground"
          title="Dismiss"
          disabled={dismiss.isPending}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {issue.aiTriageReasoning && (
        <p className="mb-3 text-[0.75rem] leading-relaxed text-muted-foreground">
          {issue.aiTriageReasoning}
        </p>
      )}

      <div className="space-y-2">
        {priorityChanged && (
          <SuggestionRow
            checked={applyPriority}
            onChange={setApplyPriority}
            label="Priority"
          >
            <span
              className={`rounded-md px-2 py-0.5 text-[0.6875rem] font-medium ${PRIORITY_TONE[issue.priority]}`}
            >
              {PRIORITY_LABEL[issue.priority]}
            </span>
            <span className="text-muted-foreground">→</span>
            <span
              className={`rounded-md px-2 py-0.5 text-[0.6875rem] font-medium ${PRIORITY_TONE[issue.aiSuggestedPriority!]}`}
            >
              {PRIORITY_LABEL[issue.aiSuggestedPriority!]}
            </span>
          </SuggestionRow>
        )}

        {newLabels.length > 0 && (
          <SuggestionRow
            checked={applyLabels}
            onChange={setApplyLabels}
            label="Add labels"
          >
            <div className="flex flex-wrap gap-1.5">
              {newLabels.map((id) => {
                const l = labelLookup.get(id);
                return (
                  <Badge key={id} color={l?.color}>
                    {l?.name ?? id.slice(0, 6)}
                  </Badge>
                );
              })}
            </div>
          </SuggestionRow>
        )}

        {suggestedAgent && (
          <SuggestionRow
            checked={applyAgent}
            onChange={setApplyAgent}
            label="Assign agent"
          >
            <span className="font-mono text-[0.6875rem] text-foreground">
              {suggestedAgent.profileKey}
            </span>
            <span className="text-[0.6875rem] text-muted-foreground">
              ({suggestedAgent.name})
            </span>
          </SuggestionRow>
        )}

        {nothingToApply && (
          <p className="text-[0.6875rem] italic text-muted-foreground">
            No changes proposed beyond what&apos;s already set.
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => rerun.mutate({ issueId: issue.id })}
          disabled={rerun.isPending}
          className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
          title="Re-run on the current title + description"
        >
          <RefreshCw className="h-3 w-3" />
          Re-run
        </button>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dismiss.mutate({ issueId: issue.id })}
            disabled={dismiss.isPending}
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            variant="ember"
            onClick={() =>
              apply.mutate({
                issueId: issue.id,
                applyPriority,
                applyLabels,
                applyAgent,
              })
            }
            disabled={
              apply.isPending ||
              nothingToApply ||
              (!applyPriority && !applyLabels && !applyAgent)
            }
          >
            {apply.isPending ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SuggestionRow({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5"
      />
      <span className="w-24 shrink-0 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">{children}</span>
    </label>
  );
}
