"use client";

import { useMemo, useState } from "react";
import { ArrowRight, MoveRight } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Combobox } from "@/components/ui/combobox";
import { useConfirm } from "@/components/ui/modal/use-confirm";
import { AdminButton, AdminPanel, AdminLoading } from "@/components/admin-shell/admin-ui";
import type { IssueMovePlan as MovePlan } from "@/server/services/cross-workspace-move";

/** Parse a pasted blob of issue ids (whitespace / comma separated). */
function parseIssueIds(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

export function AdminMoveIssues() {
  const { data: tenants, isLoading } = trpc.instanceAdmin.tenants.useQuery();
  const utils = trpc.useUtils();
  const { confirm, confirmElement } = useConfirm();

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [idsText, setIdsText] = useState("");
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const moveM = trpc.instanceAdmin.moveIssues.useMutation();

  const wsOptions = useMemo(
    () => (tenants ?? []).map((w) => ({ value: w.id, label: `${w.key} · ${w.name}` })),
    [tenants],
  );
  const issueIds = useMemo(() => parseIssueIds(idsText), [idsText]);
  const canPreview = Boolean(sourceId && targetId && sourceId !== targetId && issueIds.length > 0);

  async function runPreview() {
    if (!sourceId || !targetId) return;
    setPreviewing(true);
    setPlan(null);
    try {
      const result = await utils.instanceAdmin.previewIssueMove.fetch({
        sourceWorkspaceId: sourceId,
        targetWorkspaceId: targetId,
        issueIds,
      });
      setPlan(result as MovePlan);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function runMove() {
    if (!plan || !sourceId || !targetId) return;
    const ok = await confirm({
      title: `Move ${plan.movableIds.length} issue${plan.movableIds.length === 1 ? "" : "s"}?`,
      description: `They'll be renumbered into ${plan.target.key} and re-tenanted. ${
        plan.blockedIds.length ? `${plan.blockedIds.length} blocked issue(s) will be skipped.` : ""
      } This can't be auto-undone.`,
      primaryLabel: "Move",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await moveM.mutateAsync({
        sourceWorkspaceId: sourceId,
        targetWorkspaceId: targetId,
        issueIds,
      });
      toast.success(`Moved ${res.moved.length} issue(s) to ${plan.target.key}.`);
      setPlan(null);
      setIdsText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    }
  }

  if (isLoading) return <AdminLoading label="Loading workspaces…" />;

  return (
    <div className="flex flex-col gap-4">
      {confirmElement}
      <AdminPanel title="Select issues to move">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Source workspace
              </span>
              <Combobox
                value={sourceId}
                onChange={(v) => {
                  setSourceId(v);
                  setPlan(null);
                }}
                options={wsOptions.filter((o) => o.value !== targetId)}
                searchable
                placeholder="Where the issues live now"
              />
            </label>
            <div className="hidden items-center justify-center pb-2 text-muted-foreground sm:flex">
              <ArrowRight size={16} />
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Target workspace
              </span>
              <Combobox
                value={targetId}
                onChange={(v) => {
                  setTargetId(v);
                  setPlan(null);
                }}
                options={wsOptions.filter((o) => o.value !== sourceId)}
                searchable
                placeholder="Where they should go"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Issue ids ({issueIds.length})
            </span>
            <textarea
              value={idsText}
              onChange={(e) => {
                setIdsText(e.target.value);
                setPlan(null);
              }}
              rows={4}
              placeholder="Paste issue ids — whitespace or comma separated"
              className="rounded-md border border-border bg-card/40 p-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
            />
          </label>

          <div className="flex items-center gap-2">
            <AdminButton icon={MoveRight} tone="default" onClick={runPreview} disabled={!canPreview || previewing}>
              {previewing ? "Previewing…" : "Preview move"}
            </AdminButton>
            {plan && (
              <AdminButton
                icon={ArrowRight}
                tone="ember"
                onClick={runMove}
                disabled={plan.movableIds.length === 0 || moveM.isPending}
              >
                {moveM.isPending ? "Moving…" : `Move ${plan.movableIds.length}`}
              </AdminButton>
            )}
          </div>
        </div>
      </AdminPanel>

      {plan && (
        <AdminPanel
          title={`Preview — ${plan.movableIds.length} movable, ${plan.blockedIds.length} blocked`}
        >
          <div className="flex flex-col gap-3">
            {plan.overQuota && (
              <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-foreground">
                Heads up: moving {plan.attachmentMbMoving.toFixed(1)} MB of attachments would put{" "}
                {plan.target.key} over its {plan.targetQuotaMb} MB quota (used{" "}
                {plan.targetUsedMb.toFixed(1)} MB).
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Issue</th>
                    <th className="py-1 pr-3 font-medium">New key</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Labels</th>
                    <th className="py-1 pr-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  {plan.entries.map((e) => {
                    const blocked = e.blockedReasons.length > 0;
                    return (
                      <tr key={e.issueId} className="border-t border-border/60">
                        <td className="py-1.5 pr-3">
                          <span className="font-mono">{e.currentKey}</span>
                          <div className="max-w-[16ch] truncate text-muted-foreground">{e.title}</div>
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                          {e.newKey ?? "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {e.statusTo ? `${e.statusFrom} → ${e.statusTo}` : e.statusFrom}
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {e.keptLabels.length ? e.keptLabels.join(", ") : "—"}
                          {e.droppedLabels.length > 0 && (
                            <span className="text-danger"> · drops {e.droppedLabels.join(", ")}</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          {blocked ? (
                            <span className="text-danger">blocked: {e.blockedReasons.join("; ")}</span>
                          ) : (
                            <span className="text-muted-foreground">
                              nulls {e.nulledFields.length}
                              {e.droppedRelations > 0 ? ` · −${e.droppedRelations} rel` : ""}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </AdminPanel>
      )}
    </div>
  );
}
