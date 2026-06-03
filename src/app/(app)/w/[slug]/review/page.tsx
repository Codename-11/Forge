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
import { useWorkspace } from "@/hooks/use-workspace";

/** Deep-link a gate target where it can be acted on; null if not routable. */
function gateTargetHref(slug: string, targetType: string, targetId: string): string | null {
  switch (targetType) {
    case "execution-plan":
      return `/w/${slug}/plans/${targetId}`;
    case "goal":
      return `/w/${slug}/goals/${targetId}`;
    case "issue":
      return `/w/${slug}/issues/${targetId}`;
    default:
      return null;
  }
}

const STATUS_TONE: Record<string, string> = {
  PENDING: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  APPROVED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  REJECTED: "bg-destructive/10 text-destructive",
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

  const status = useMemo(
    () => FILTER_OPTIONS.find((f) => f.key === filter)?.status,
    [filter],
  );

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
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-meta uppercase tracking-wide text-muted-foreground">
                      <Shield className="h-3 w-3" />
                      {gate.targetType.replace("-", " ")} ·{" "}
                      {gateTargetHref(ws.slug, gate.targetType, gate.targetId) ? (
                        <Link
                          href={gateTargetHref(ws.slug, gate.targetType, gate.targetId)!}
                          className="inline-flex min-w-0 items-center gap-0.5 font-mono text-id text-ember hover:underline"
                        >
                          <span className="truncate">{gate.targetId.slice(0, 12)}…</span>
                          <ArrowUpRight className="h-3 w-3" />
                        </Link>
                      ) : (
                        <span className="min-w-0 truncate font-mono text-id">{gate.targetId}</span>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{gate.prompt}</p>
                    {gate.resolution ? (
                      <p className="mt-1 whitespace-pre-wrap text-meta text-muted-foreground">
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
  onResolve,
}: {
  busy: boolean;
  onResolve: (decision: "APPROVED" | "REJECTED" | "CANCELED", resolution: string) => void;
}) {
  const [resolution, setResolution] = useState("");
  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
      <input
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        placeholder="Resolution note (optional)"
        className="w-full rounded-md border border-border bg-card/40 px-3 py-1.5 text-meta"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ember"
          disabled={busy}
          onClick={() => onResolve("APPROVED", resolution)}
        >
          <Check className="h-3.5 w-3.5" /> Approve
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={busy}
          onClick={() => onResolve("REJECTED", resolution)}
        >
          <X className="h-3.5 w-3.5" /> Reject
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
