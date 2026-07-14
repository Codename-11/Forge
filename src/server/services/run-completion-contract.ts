import "server-only";
import type { EngagementMode, Prisma } from "@prisma/client";
import { FORGE_RUN_CONTRACT_VERSION } from "@/server/services/engagement-mode";

export const RUN_COMPLETION_CONFIDENCE_VALUES = ["LOW", "MEDIUM", "HIGH"] as const;
export type RunCompletionConfidence = (typeof RUN_COMPLETION_CONFIDENCE_VALUES)[number];

export const RUN_REVIEW_VERDICT_VALUES = ["APPROVE", "REQUEST_CHANGES"] as const;
export type RunReviewVerdict = (typeof RUN_REVIEW_VERDICT_VALUES)[number];

export type RunVerificationResultItem = {
  id?: string;
  label: string;
  kind?: "manual" | "command" | "artifact";
  value?: string;
  done: boolean;
};

export type RunCompletionInput = {
  summary?: string;
  completionCommentId?: string;
  producedArtifactIds?: string[];
  verificationResult?: RunVerificationResultItem[];
  followUps?: Array<{ title: string; body?: string; kind?: string }>;
  confidence?: RunCompletionConfidence;
  verdict?: RunReviewVerdict;
};

export type IssueCompletionContract = {
  expectedOutput?: string | null;
  verificationChecklist?: Prisma.JsonValue | null;
  artifactRequired: boolean;
};

export type RunCompletionMeta = {
  contractVersion: string;
  mode: EngagementMode;
  confidence?: RunCompletionConfidence;
  verdict?: RunReviewVerdict;
};

type ChecklistItem = {
  id?: string;
  label: string;
};

function nonEmpty(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

function checklistItems(value: Prisma.JsonValue | null | undefined): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const obj = raw as Record<string, unknown>;
    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    if (!label) return [];
    return [
      {
        label,
        ...(typeof obj.id === "string" && obj.id.trim() ? { id: obj.id.trim() } : {}),
      },
    ];
  });
}

function verificationKey(item: { id?: string; label: string }): string {
  return item.id?.trim() || item.label.trim().toLowerCase();
}

export function runCompletionMeta(
  mode: EngagementMode,
  input: RunCompletionInput,
): RunCompletionMeta {
  return {
    contractVersion: FORGE_RUN_CONTRACT_VERSION,
    mode,
    ...(input.confidence ? { confidence: input.confidence } : {}),
    ...(input.verdict ? { verdict: input.verdict } : {}),
  };
}

export function validateRunCompletion(input: {
  mode: EngagementMode;
  issue: IssueCompletionContract;
  completion: RunCompletionInput;
  issueLinkedArtifactIds?: Set<string>;
}): string[] {
  const errors: string[] = [];
  const { mode, issue, completion } = input;

  if (!nonEmpty(completion.summary)) {
    errors.push("summary is required.");
  }

  if (mode === "RESEARCH") {
    if (!completion.confidence) {
      errors.push("RESEARCH completion requires confidence (LOW, MEDIUM, or HIGH).");
    }
    return errors;
  }

  if (mode === "REVIEW") {
    if (!completion.verdict) {
      errors.push("REVIEW completion requires verdict (APPROVE or REQUEST_CHANGES).");
    }
    return errors;
  }

  if (mode === "DISCUSS") {
    if ((completion.producedArtifactIds?.length ?? 0) > 0) {
      errors.push("DISCUSS completion cannot attach produced artifacts.");
    }
    if ((completion.verificationResult?.length ?? 0) > 0) {
      errors.push("DISCUSS completion cannot submit verification results.");
    }
    if ((completion.followUps?.length ?? 0) > 0) {
      errors.push("DISCUSS completion cannot submit follow-up work items.");
    }
    return errors;
  }

  const produced = completion.producedArtifactIds ?? [];
  if (issue.artifactRequired) {
    if (produced.length === 0) {
      errors.push("EXECUTE completion requires at least one produced artifact.");
    } else {
      const issueLinked = input.issueLinkedArtifactIds ?? new Set<string>();
      if (!produced.some((id) => issueLinked.has(id))) {
        errors.push("EXECUTE completion requires an artifact linked to this issue.");
      }
    }
  }

  const checklist = checklistItems(issue.verificationChecklist);
  if (checklist.length > 0) {
    const done = new Set(
      (completion.verificationResult ?? []).filter((item) => item.done).map(verificationKey),
    );
    for (const item of checklist) {
      if (!done.has(verificationKey(item))) {
        errors.push(`EXECUTE completion is missing verification: ${item.label}.`);
      }
    }
  }

  return errors;
}
