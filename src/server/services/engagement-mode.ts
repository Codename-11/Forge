import "server-only";
import { EngagementMode, MentionEngagementPolicy } from "@prisma/client";

/**
 * Engagement modes — the *intent* of a dispatched agent turn. See
 * docs/agents/engagement-modes.md. This module is the single resolver
 * (mirrors resolveRunEngine) plus the canonical per-mode instruction blocks
 * injected into the agent's turn. Pure + dependency-free so it's trivially
 * unit-testable.
 */

export type EngagementSurface =
  | "assignment"
  | "queue"
  | "mention"
  | "chat"
  | "plan"
  | "watcher";

export type EngagementSource =
  | "explicit"
  | "surface-default"
  | "policy-infer"
  | "policy-fixed"
  | "policy-require-marker";

export interface ResolvedEngagement {
  mode: EngagementMode;
  source: EngagementSource;
  /** True when the agent should infer intent and ask before irreversible work. */
  inferable: boolean;
}

export interface WorkspaceEngagementConfig {
  assignmentEngagementMode: EngagementMode;
  /**
   * Per-agent binding override for assignment/queue dispatch. Null means
   * inherit the workspace assignment default.
   */
  assignmentAgentEngagementMode?: EngagementMode | null;
  mentionEngagementPolicy: MentionEngagementPolicy;
  mentionDefaultMode: EngagementMode;
}

/**
 * Resolve the engagement mode for a dispatch. Precedence:
 *   explicit (per-dispatch override) > mention policy > surface default.
 *
 * - assignment / queue → workspace.assignmentEngagementMode (default EXECUTE)
 * - chat               → DISCUSS (conversational)
 * - plan               → EXECUTE (a plan step is declared work)
 * - watcher            → DISCUSS (awareness; never auto-execute)
 * - mention            → policy-driven (INFER / FIXED / REQUIRE_MARKER)
 */
export function resolveEngagementMode(input: {
  surface: EngagementSurface;
  explicit?: EngagementMode | null;
  workspace: WorkspaceEngagementConfig;
}): ResolvedEngagement {
  if (input.explicit) {
    return { mode: input.explicit, source: "explicit", inferable: false };
  }

  switch (input.surface) {
    case "assignment":
    case "queue":
      return {
        mode:
          input.workspace.assignmentAgentEngagementMode ??
          input.workspace.assignmentEngagementMode,
        source: "surface-default",
        inferable: false,
      };
    case "chat":
      return { mode: EngagementMode.DISCUSS, source: "surface-default", inferable: false };
    case "plan":
      return { mode: EngagementMode.EXECUTE, source: "surface-default", inferable: false };
    case "watcher":
      return { mode: EngagementMode.DISCUSS, source: "surface-default", inferable: false };
    case "mention": {
      switch (input.workspace.mentionEngagementPolicy) {
        case MentionEngagementPolicy.FIXED:
          return {
            mode: input.workspace.mentionDefaultMode,
            source: "policy-fixed",
            inferable: false,
          };
        case MentionEngagementPolicy.REQUIRE_MARKER:
          return { mode: EngagementMode.DISCUSS, source: "policy-require-marker", inferable: false };
        case MentionEngagementPolicy.INFER:
        default:
          // INFER: start from the conversational default but let the agent
          // infer a different intent — asking first before irreversible work.
          return {
            mode: input.workspace.mentionDefaultMode,
            source: "policy-infer",
            inferable: true,
          };
      }
    }
    default:
      return { mode: EngagementMode.EXECUTE, source: "surface-default", inferable: false };
  }
}

/** True only for EXECUTE — the mode that may mutate code/status and deploy. */
export function modeMayExecute(mode: EngagementMode): boolean {
  return mode === EngagementMode.EXECUTE;
}

const BASE_INSTRUCTIONS: Record<EngagementMode, string> = {
  EXECUTE:
    "ENGAGEMENT MODE: EXECUTE. Take this to completion. The definition of done " +
    "is the issue's `expectedOutput`; verify against its `verificationChecklist`. " +
    "You may modify code, move the issue's status, and open PRs/artifacts. Respect " +
    "any approval/review gate before an irreversible step (e.g. deploy).",
  RESEARCH:
    "ENGAGEMENT MODE: RESEARCH. Investigate and report your findings as a comment " +
    "with a confidence flag (LOW/MEDIUM/HIGH). Do NOT modify code, move the issue, " +
    "or open a PR. If you believe execution is warranted, say so and stop.",
  REVIEW:
    "ENGAGEMENT MODE: REVIEW. Critique the existing work/diff/PR and record a verdict " +
    "(approve or request changes). Do NOT implement changes yourself.",
  DISCUSS:
    "ENGAGEMENT MODE: DISCUSS. Answer / weigh in on the thread. No work product, no " +
    "code changes, no status moves — just a reply.",
};

const INFER_SUFFIX =
  " You were @-mentioned without an explicit mode. Infer the intent from the " +
  "message; if it implies real work, ASK for confirmation before doing anything " +
  "irreversible rather than assuming.";

/** The instruction block injected into the agent's turn for a resolved mode. */
export function engagementInstruction(resolved: ResolvedEngagement): string {
  const base = BASE_INSTRUCTIONS[resolved.mode];
  return resolved.inferable ? base + INFER_SUFFIX : base;
}
