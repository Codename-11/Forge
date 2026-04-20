import { db } from "@/server/db";
import { Priority } from "@prisma/client";

/**
 * Local-runtime skill. Invoked in-process by the plugin runtime when
 * an agent (or a workflow) calls `issue-triage/triage`.
 *
 * This is a *deliberately* simple heuristic — swap for an LLM call once
 * the plugin has credentials and a real model route. The point is the
 * contract: input/output shapes match the manifest JSON Schemas.
 */

type Input = { issueId: string; title: string; description?: string };
type Ctx = { workspaceId: string; invokerUserId: string | null };
type Output = { priority: Priority; labels: string[]; confidence: number };

const urgentSignals = [/\bprod\w*\b/i, /\boutage\b/i, /\bdown\b/i, /\bp0\b/i, /\bcritical\b/i];
const highSignals = [/\bregression\b/i, /\bbroken\b/i, /\bfailing\b/i, /\bdata ?loss\b/i];
const bugSignals = [/\bbug\b/i, /\berror\b/i, /\bcrash\b/i, /\bstack ?trace\b/i];
const chorSignals = [/\bchore\b/i, /\brefactor\b/i, /\bcleanup\b/i];

export const skills = {
  triage: async (input: Input, ctx: Ctx): Promise<Output> => {
    const text = `${input.title}\n${input.description ?? ""}`;
    let priority: Priority = Priority.NONE;
    let confidence = 0.3;

    if (urgentSignals.some((r) => r.test(text))) {
      priority = Priority.URGENT;
      confidence = 0.85;
    } else if (highSignals.some((r) => r.test(text))) {
      priority = Priority.HIGH;
      confidence = 0.7;
    } else if (chorSignals.some((r) => r.test(text))) {
      priority = Priority.LOW;
      confidence = 0.6;
    } else {
      priority = Priority.MEDIUM;
      confidence = 0.4;
    }

    const labels: string[] = [];
    if (bugSignals.some((r) => r.test(text))) labels.push("bug");
    if (chorSignals.some((r) => r.test(text))) labels.push("chore");

    // Apply triage result. In a "suggest-only" mode the handler would return
    // without mutating — for the demo we write the priority directly.
    await db.issue.update({
      where: { id: input.issueId },
      data: { priority },
    });

    return { priority, labels, confidence };
  },
};
