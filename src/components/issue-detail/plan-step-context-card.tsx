"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck, ListChecks, Target, Workflow } from "lucide-react";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";
import { STEP_STATUS_STYLE, type StepStatus } from "@/components/orchestration/types";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn, formatIssueId } from "@/lib/utils";

type VerificationItem = {
  id?: string;
  label: string;
  kind?: "manual" | "command" | "artifact";
  value?: string;
  done?: boolean;
};

type PlanStepNeighbor = {
  id: string;
  title: string;
  position: number;
  status: StepStatus;
  dependsOnStepIds: string[];
  issue: {
    id: string;
    number: number;
    title: string;
    status: { name: string; category: string; color: string };
  } | null;
};

export type PlanStepIssueContext = {
  id: string;
  title: string;
  body: string | null;
  position: number;
  status: StepStatus;
  expectedOutput: string | null;
  verification: unknown;
  dependsOnStepIds: string[];
  retryCount: number;
  lastFeedback: string | null;
  plan: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    goal: {
      id: string;
      title: string;
      description: string | null;
      successCriteria: string | null;
      status: string;
    } | null;
    steps: PlanStepNeighbor[];
  };
};

function verificationItems(value: unknown): VerificationItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.label !== "string" || !row.label.trim()) return [];
    return [
      {
        id: typeof row.id === "string" ? row.id : undefined,
        label: row.label,
        kind:
          row.kind === "manual" || row.kind === "command" || row.kind === "artifact"
            ? row.kind
            : undefined,
        value: typeof row.value === "string" ? row.value : undefined,
        done: typeof row.done === "boolean" ? row.done : undefined,
      },
    ];
  });
}

function StepStatusPill({ status }: { status: StepStatus }) {
  const style = STEP_STATUS_STYLE[status] ?? STEP_STATUS_STYLE.TODO;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide",
        style.pill,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", style.dot)} aria-hidden />
      {style.label}
    </span>
  );
}

function StepLink({ step, planId }: { step: PlanStepNeighbor; planId: string }) {
  const ws = useWorkspace();
  const content = (
    <>
      <span className="text-id shrink-0 text-muted-foreground">
        {step.issue ? formatIssueId(ws.key, step.issue.number) : `step ${step.position + 1}`}
      </span>
      <span className="min-w-0 flex-1 truncate">{step.issue?.title ?? step.title}</span>
      <StepStatusPill status={step.status} />
    </>
  );
  const className =
    "flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5 text-meta transition hover:border-ember/40 hover:text-ember";
  return step.issue ? (
    <Link href={`/w/${ws.slug}/issues/${step.issue.id}`} className={className}>
      {content}
    </Link>
  ) : (
    <Link href={`/w/${ws.slug}/plans/${planId}#step-${step.id}`} className={className}>
      {content}
    </Link>
  );
}

/**
 * Full provenance + completion contract for an Issue materialized from an
 * ExecutionStep. This intentionally lives in the main reading column: the
 * small rail backlink is useful navigation, but it cannot carry enough
 * context for someone (or an agent) opening the Issue in isolation.
 */
export function PlanStepContextCards({ contexts }: { contexts: PlanStepIssueContext[] }) {
  if (contexts.length === 0) return null;
  return (
    <div className="space-y-4">
      {contexts.map((context) => (
        <PlanStepContextCard key={context.id} context={context} />
      ))}
    </div>
  );
}

function PlanStepContextCard({ context }: { context: PlanStepIssueContext }) {
  const ws = useWorkspace();
  const { plan } = context;
  const total = plan.steps.length;
  const done = plan.steps.filter((step) => step.status === "DONE").length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const dependencies = context.dependsOnStepIds.flatMap((id) => {
    const step = byId.get(id);
    return step ? [step] : [];
  });
  const dependents = plan.steps.filter((step) => step.dependsOnStepIds.includes(context.id));
  const checks = verificationItems(context.verification);

  return (
    <section
      aria-label="Plan step context"
      className="overflow-hidden rounded-lg border border-ember/25 bg-card/30"
    >
      <header className="border-b border-border bg-card/45 px-4 py-3">
        <div className="text-meta flex flex-wrap items-center gap-1.5 text-muted-foreground">
          {plan.goal ? (
            <>
              <Target className="h-3.5 w-3.5 text-ember" />
              <Link
                href={`/w/${ws.slug}/goals/${plan.goal.id}`}
                className="hover:text-ember hover:underline"
              >
                {plan.goal.title}
              </Link>
              <ArrowRight className="h-3 w-3" aria-hidden />
            </>
          ) : null}
          <Workflow className="h-3.5 w-3.5 text-ember" />
          <Link
            href={`/w/${ws.slug}/plans/${plan.id}`}
            className="hover:text-ember hover:underline"
          >
            {plan.title}
          </Link>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">
            Step {context.position + 1} of {total}: {context.title}
          </h2>
          <StepStatusPill status={context.status} />
          {context.retryCount > 0 ? (
            <span className="rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-warning">
              retry {context.retryCount}
            </span>
          ) : null}
        </div>
      </header>

      <div className="space-y-4 p-4">
        {plan.goal ? (
          <div className="grid gap-3 md:grid-cols-2">
            {plan.goal.description ? (
              <div>
                <h3 className="text-meta uppercase tracking-wide text-muted-foreground">
                  Goal context
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/85">
                  {plan.goal.description}
                </p>
              </div>
            ) : null}
            {plan.goal.successCriteria ? (
              <div className="rounded-md border border-border bg-background/35 p-2.5">
                <h3 className="text-meta flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
                  <CircleCheck className="h-3.5 w-3.5" /> Success criteria
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/85">
                  {plan.goal.successCriteria}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {plan.description ? (
          <div>
            <h3 className="text-meta uppercase tracking-wide text-muted-foreground">
              Plan context
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/85">
              {plan.description}
            </p>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          {context.body ? (
            <div className="rounded-md border border-border bg-background/35 p-3">
              <h3 className="text-meta mb-2 uppercase tracking-wide text-muted-foreground">
                Step instructions
              </h3>
              <MarkdownWithAttachments body={context.body} className="text-sm text-foreground/90" />
            </div>
          ) : null}
          <div className="space-y-3 rounded-md border border-border bg-background/35 p-3">
            {context.expectedOutput ? (
              <div>
                <h3 className="text-meta uppercase tracking-wide text-muted-foreground">
                  Expected output
                </h3>
                <MarkdownWithAttachments
                  body={context.expectedOutput}
                  className="mt-1 text-sm text-foreground/90"
                />
              </div>
            ) : null}
            {checks.length > 0 ? (
              <div>
                <h3 className="text-meta flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
                  <ListChecks className="h-3.5 w-3.5" /> Verification
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {checks.map((check, index) => (
                    <li key={check.id ?? `${check.label}-${index}`} className="flex gap-2 text-sm">
                      <span
                        aria-hidden
                        className={cn(
                          "mt-1 h-2 w-2 shrink-0 rounded-full border",
                          check.done ? "border-success bg-success" : "border-muted-foreground/50",
                        )}
                      />
                      <span>
                        {check.label}
                        {check.value ? (
                          <code className="text-meta ml-1.5 rounded bg-subtle px-1 py-0.5">
                            {check.value}
                          </code>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {!context.expectedOutput && checks.length === 0 ? (
              <p className="text-meta text-muted-foreground">
                No completion contract was provided.
              </p>
            ) : null}
          </div>
        </div>

        {context.lastFeedback ? (
          <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
            <h3 className="text-meta uppercase tracking-wide text-warning">
              Latest review feedback
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-sm">{context.lastFeedback}</p>
          </div>
        ) : null}

        {dependencies.length > 0 || dependents.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h3 className="text-meta mb-1.5 uppercase tracking-wide text-muted-foreground">
                Depends on
              </h3>
              {dependencies.length > 0 ? (
                <div className="space-y-1.5">
                  {dependencies.map((step) => (
                    <StepLink key={step.id} step={step} planId={plan.id} />
                  ))}
                </div>
              ) : (
                <p className="text-meta text-muted-foreground">No prerequisites</p>
              )}
            </div>
            <div>
              <h3 className="text-meta mb-1.5 uppercase tracking-wide text-muted-foreground">
                Unlocks
              </h3>
              {dependents.length > 0 ? (
                <div className="space-y-1.5">
                  {dependents.map((step) => (
                    <StepLink key={step.id} step={step} planId={plan.id} />
                  ))}
                </div>
              ) : (
                <p className="text-meta text-muted-foreground">No downstream steps</p>
              )}
            </div>
          </div>
        ) : null}

        <div>
          <div className="text-meta flex items-center justify-between text-muted-foreground">
            <span>Plan progress</span>
            <span className="font-mono tabular-nums">
              {done}/{total} steps
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-subtle">
            <span
              className="block h-full rounded-full bg-ember"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-2 grid gap-1.5 lg:grid-cols-2">
            {plan.steps.map((step) => (
              <StepLink key={step.id} step={step} planId={plan.id} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
