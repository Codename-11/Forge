"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/settings/card";
import { Section } from "@/components/ui";
import { trpc } from "@/lib/trpc";

export function GitHubReconciliationPolicy({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const { data: workspace } = trpc.workspace.current.useQuery();
  const [policy, setPolicy] = useState({
    enabled: true,
    staleMinutes: 15,
    batchSize: 25,
    backoffMinutes: 5,
    maxBackoffMinutes: 1440,
    requestTimeoutSeconds: 10,
    sweepBudgetSeconds: 45,
    closedReprobeMinutes: 1440,
    manualCooldownSeconds: 30,
  });

  useEffect(() => {
    if (!workspace) return;
    setPolicy({
      enabled: workspace.githubSyncEnabled,
      staleMinutes: workspace.githubSyncStaleMinutes,
      batchSize: workspace.githubSyncBatchSize,
      backoffMinutes: workspace.githubSyncBackoffMinutes,
      maxBackoffMinutes: workspace.githubSyncMaxBackoffMinutes,
      requestTimeoutSeconds: workspace.githubRequestTimeoutSeconds,
      sweepBudgetSeconds: workspace.githubSweepBudgetSeconds,
      closedReprobeMinutes: workspace.githubClosedReprobeMinutes,
      manualCooldownSeconds: workspace.githubManualCooldownSeconds,
    });
  }, [workspace]);

  const update = trpc.workspace.update.useMutation({
    onSuccess: () => {
      toast.success("GitHub reconciliation policy updated.");
      void utils.workspace.current.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Section
      title="GitHub status reconciliation"
      hint="Webhook-first repair loop for linked implementation pull requests. Only stale rows are polled."
    >
      <Card as="div" className="space-y-4 p-4">
        <ToggleRow
          label="Repair missed GitHub updates"
          hint="Refresh stale open, draft, or merged PRs and their aggregate checks. Closed PRs recheck slowly for missed reopen events; confirmed-green merged PRs stop polling."
          checked={policy.enabled}
          onChange={(enabled) => setPolicy((value) => ({ ...value, enabled }))}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField
            label="Stale after"
            suffix="min"
            value={policy.staleMinutes}
            min={0}
            max={10080}
            onChange={(staleMinutes) => setPolicy((value) => ({ ...value, staleMinutes }))}
          />
          <NumberField
            label="Batch"
            suffix="PRs"
            value={policy.batchSize}
            min={0}
            max={250}
            onChange={(batchSize) => setPolicy((value) => ({ ...value, batchSize }))}
          />
          <NumberField
            label="Retry"
            suffix="min"
            value={policy.backoffMinutes}
            min={1}
            max={1440}
            onChange={(backoffMinutes) => setPolicy((value) => ({ ...value, backoffMinutes }))}
          />
          <NumberField
            label="Max retry"
            suffix="min"
            value={policy.maxBackoffMinutes}
            min={1}
            max={10080}
            onChange={(maxBackoffMinutes) =>
              setPolicy((value) => ({ ...value, maxBackoffMinutes }))
            }
          />
        </div>
        <details className="rounded-md border border-border/60 bg-background/40 p-3">
          <summary className="cursor-pointer text-[0.75rem] font-medium">Safety limits</summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <NumberField
              label="Request timeout"
              suffix="sec"
              value={policy.requestTimeoutSeconds}
              min={1}
              max={60}
              onChange={(requestTimeoutSeconds) =>
                setPolicy((value) => ({ ...value, requestTimeoutSeconds }))
              }
            />
            <NumberField
              label="Sweep budget"
              suffix="sec"
              value={policy.sweepBudgetSeconds}
              min={5}
              max={300}
              onChange={(sweepBudgetSeconds) =>
                setPolicy((value) => ({ ...value, sweepBudgetSeconds }))
              }
            />
            <NumberField
              label="Closed recheck"
              suffix="min"
              value={policy.closedReprobeMinutes}
              min={60}
              max={43200}
              onChange={(closedReprobeMinutes) =>
                setPolicy((value) => ({ ...value, closedReprobeMinutes }))
              }
            />
            <NumberField
              label="Manual cooldown"
              suffix="sec"
              value={policy.manualCooldownSeconds}
              min={1}
              max={3600}
              onChange={(manualCooldownSeconds) =>
                setPolicy((value) => ({ ...value, manualCooldownSeconds }))
              }
            />
          </div>
        </details>
        <div className="flex items-center justify-between border-t border-border/60 pt-3">
          <p className="text-meta text-muted-foreground">
            Rate-limit reset headers override retry timing. Inaccessible PRs back off instead of
            unlinking.
          </p>
          <Button
            size="sm"
            variant="ember"
            disabled={!isAdmin || update.isPending}
            onClick={() =>
              update.mutate({
                githubSyncEnabled: policy.enabled,
                githubSyncStaleMinutes: policy.staleMinutes,
                githubSyncBatchSize: policy.batchSize,
                githubSyncBackoffMinutes: policy.backoffMinutes,
                githubSyncMaxBackoffMinutes: policy.maxBackoffMinutes,
                githubRequestTimeoutSeconds: policy.requestTimeoutSeconds,
                githubSweepBudgetSeconds: policy.sweepBudgetSeconds,
                githubClosedReprobeMinutes: policy.closedReprobeMinutes,
                githubManualCooldownSeconds: policy.manualCooldownSeconds,
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Save policy
          </Button>
        </div>
      </Card>
    </Section>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-border/60 bg-background/60 p-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <span className="min-w-0">
        <span className="block text-[0.8125rem] font-medium">{label}</span>
        <span className="block text-[0.6875rem] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function NumberField({
  label,
  suffix,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-[0.6875rem] font-medium text-muted-foreground">{label}</span>
      <span className="flex items-center rounded-md border border-input bg-background">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.target.value) || min)}
          className="focus-ring h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm"
        />
        <span className="pr-2 text-[0.6875rem] text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}
