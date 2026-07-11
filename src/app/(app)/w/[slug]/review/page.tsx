"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ReviewGateStatus } from "@prisma/client";
import { ArrowUpRight, Check, Shield, X } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { formatIssueId } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";

/** Deep-link a gate target where it can be acted on; null if not routable. */
function gateTargetHref(
  slug: string,
  gate: {
    targetType: string;
    targetId: string;
    targetContext?: {
      kind: string;
      step?: { plan?: { id: string } };
    } | null;
  },
): string | null {
  switch (gate.targetType) {
    case "execution-plan":
      return `/w/${slug}/plans/${gate.targetId}`;
    case "execution-step": {
      const planId = gate.targetContext?.step?.plan?.id;
      return planId ? `/w/${slug}/plans/${planId}#step-${gate.targetId}` : null;
    }
    case "goal":
      return `/w/${slug}/goals/${gate.targetId}`;
    case "issue":
      return `/w/${slug}/issues/${gate.targetId}`;
    default:
      return null;
  }
}

const STATUS_TONE: Record<string, string> = {
  PENDING: "bg-warning/10 text-warning",
  APPROVED: "bg-success/10 text-success",
  REJECTED: "bg-danger/10 text-danger",
  CANCELED: "bg-muted/40 text-muted-foreground line-through",
};

const FILTER_OPTIONS: Array<{ key: string; label: string; status?: ReviewGateStatus }> = [
  { key: "open", label: "Pending", status: ReviewGateStatus.PENDING },
  { key: "approved", label: "Approved", status: ReviewGateStatus.APPROVED },
  { key: "rejected", label: "Rejected", status: ReviewGateStatus.REJECTED },
  { key: "all", label: "All" },
];

/**
 * Review gate inbox. By default surfaces only PENDING gates so the
 * human reviewer can quickly approve / reject / cancel. Toggle the
 * filter chips to inspect resolved history. Each row shows the gate
 * target, prompt, requester, and the three decision buttons that
 * route through the existing reviewGate.resolve mutation.
 */
export default function ReviewPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<string>("open");

  const status = useMemo(() => FILTER_OPTIONS.find((f) => f.key === filter)?.status, [filter]);

  const { data, isLoading } = trpc.reviewGate.list.useQuery({
    status,
    limit: 100,
  });
  const items = useMemo(() => data?.items ?? [], [data]);

  const resolve = trpc.reviewGate.resolve.useMutation({
    onSuccess: () => {
      toast.success("Gate resolved");
      utils.reviewGate.list.invalidate();
      utils.commandCenter.summary.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Live-refresh the inbox as gates are opened/resolved elsewhere (a crew
  // member requests approval, or another operator acts). Previously the
  // list was static until the viewer's own resolve or a manual reload.
  useRealtime(
    () => {
      void utils.reviewGate.list.invalidate();
      void utils.commandCenter.summary.invalidate();
    },
    { subjectType: "review-gate" },
  );

  return (
    <>
      <Topbar
        title="Review"
        subtitle={data ? `${items.length} gate${items.length === 1 ? "" : "s"}` : undefined}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setFilter(opt.key)}
              className={`rounded-md border px-2 py-1 text-xs ${
                filter === opt.key
                  ? "border-ember bg-ember/15 text-ember"
                  : "border-border bg-card/40 text-muted-foreground hover:bg-subtle"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <SkeletonList rows={4} />
        ) : items.length === 0 ? (
          <EmptyState
            variant="page"
            icon={<Shield />}
            title="No review gates"
            description="Review gates pause critical automation until a human or designated reviewer approves. Agents open gates via the MCP tools; you'll see them here when they're waiting on you."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((gate) => (
              <li
                key={gate.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2 sm:flex-nowrap">
                  <div className="min-w-0 flex-1">
                    <div className="text-meta flex min-w-0 flex-wrap items-center gap-2 uppercase tracking-wide text-muted-foreground">
                      <Shield className="h-3 w-3" />
                      <span>{gate.targetType.replace("-", " ")}</span>
                      <span aria-hidden>·</span>
                      {gateTargetHref(ws.slug, gate) ? (
                        <Link
                          href={gateTargetHref(ws.slug, gate)!}
                          className="inline-flex min-w-0 items-center gap-1 normal-case hover:underline"
                        >
                          {gate.targetNumber != null && (
                            <span className="text-id shrink-0 font-mono text-ember">
                              {formatIssueId(ws.key, gate.targetNumber)}
                            </span>
                          )}
                          <span className="min-w-0 truncate text-foreground">
                            {gate.targetLabel ?? `${gate.targetId.slice(0, 8)}…`}
                          </span>
                          <ArrowUpRight className="h-3 w-3 shrink-0 text-ember" />
                        </Link>
                      ) : (
                        <span className="min-w-0 truncate normal-case text-foreground">
                          {gate.targetLabel ?? gate.targetId}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{gate.prompt}</p>
                    {gate.targetContext?.kind === "execution-step" ? (
                      <StepReviewEvidence
                        slug={ws.slug}
                        workspaceKey={ws.key}
                        step={gate.targetContext.step}
                      />
                    ) : null}
                    {gate.resolution ? (
                      <p className="text-meta mt-1 whitespace-pre-wrap text-muted-foreground">
                        <span className="uppercase tracking-wide opacity-70">Resolution: </span>
                        {gate.resolution}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${STATUS_TONE[gate.status] ?? "bg-subtle"}`}
                  >
                    {gate.status.toLowerCase()}
                  </span>
                </div>
                {gate.status === "PENDING" ? (
                  <GateDecisionRow
                    busy={resolve.isPending}
                    stepReview={
                      gate.targetContext?.kind === "execution-step" &&
                      gate.targetContext.step.status === "REVIEW"
                    }
                    onResolve={(decision, resolution) =>
                      resolve.mutate({ id: gate.id, decision, resolution: resolution || null })
                    }
                  />
                ) : (
                  <p className="text-meta text-muted-foreground">
                    Resolved {gate.resolvedAt ? new Date(gate.resolvedAt).toLocaleString() : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function GateDecisionRow({
  busy,
  stepReview,
  onResolve,
}: {
  busy: boolean;
  stepReview: boolean;
  onResolve: (decision: "APPROVED" | "REJECTED" | "CANCELED", resolution: string) => void;
}) {
  const [resolution, setResolution] = useState("");
  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
      <input
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        placeholder={
          stepReview
            ? "Review note (required when requesting changes)"
            : "Resolution note (optional)"
        }
        className="text-meta w-full rounded-md border border-border bg-card/40 px-3 py-1.5"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ember"
          disabled={busy}
          onClick={() => onResolve("APPROVED", resolution)}
        >
          <Check className="h-3.5 w-3.5" /> {stepReview ? "Pass & continue" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={busy || (stepReview && !resolution.trim())}
          onClick={() => onResolve("REJECTED", resolution)}
        >
          <X className="h-3.5 w-3.5" /> {stepReview ? "Request changes" : "Reject"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy}
          onClick={() => onResolve("CANCELED", resolution)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

type StepReviewEvidenceProps = {
  slug: string;
  workspaceKey: string;
  step: {
    id: string;
    title: string;
    position: number;
    status: string;
    expectedOutput: string | null;
    plan: {
      id: string;
      title: string;
      _count: { steps: number };
      goal: { id: string; title: string } | null;
    };
    issue: { id: string; number: number; title: string } | null;
    assignedAgent: { name: string; profileKey: string } | null;
    runs: Array<{
      id: string;
      summary: string | null;
      verificationResult: unknown;
      producedArtifactIds: string[];
      completedAt: string | Date | null;
      agent: { name: string; profileKey: string };
    }>;
  };
};

function StepReviewEvidence({ slug, workspaceKey, step }: StepReviewEvidenceProps) {
  const run = step.runs[0] ?? null;
  const checks = Array.isArray(run?.verificationResult) ? run.verificationResult : [];
  const completedChecks = checks.filter(
    (item) => item && typeof item === "object" && "done" in item && item.done === true,
  ).length;
  return (
    <div className="mt-3 rounded-md border border-border bg-background/40 p-2.5">
      <div className="text-meta flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        {step.plan.goal ? <span>{step.plan.goal.title}</span> : null}
        {step.plan.goal ? <span aria-hidden>›</span> : null}
        <Link
          href={`/w/${slug}/plans/${step.plan.id}#step-${step.id}`}
          className="text-ember hover:underline"
        >
          {step.plan.title} · step {step.position + 1} of {step.plan._count.steps}
        </Link>
        {step.issue ? (
          <>
            <span aria-hidden>·</span>
            <Link
              href={`/w/${slug}/issues/${step.issue.id}`}
              className="font-mono text-ember hover:underline"
            >
              {formatIssueId(workspaceKey, step.issue.number)}
            </Link>
          </>
        ) : null}
      </div>
      <div className="text-meta mt-2 flex flex-wrap gap-2 text-muted-foreground">
        <span>
          Worker · @{step.assignedAgent?.profileKey ?? run?.agent.profileKey ?? "unassigned"}
        </span>
        {run?.completedAt ? (
          <span>Completed · {new Date(run.completedAt).toLocaleString()}</span>
        ) : null}
        {checks.length > 0 ? (
          <span>
            Checks · {completedChecks}/{checks.length}
          </span>
        ) : null}
        {run?.producedArtifactIds.length ? (
          <span>Artifacts · {run.producedArtifactIds.length}</span>
        ) : null}
      </div>
      {run?.summary ? (
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-foreground/85">
          {run.summary}
        </p>
      ) : null}
      {step.expectedOutput ? (
        <p className="text-meta mt-2 text-muted-foreground">
          <span className="uppercase tracking-wide opacity-70">Expected · </span>
          {step.expectedOutput}
        </p>
      ) : null}
    </div>
  );
}
