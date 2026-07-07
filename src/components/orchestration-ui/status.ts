/**
 * Status-tone tables for the orchestration cockpit (Goal + ExecutionPlan
 * + ExecutionStep). Token-driven warm-earthy palette — no raw hex.
 *
 * Goal/Plan/Step status enums are part of the backend contract; we type
 * them loosely as string keys so this module compiles before the Prisma
 * client regenerates the `GoalStatus` enum.
 */

export type GoalStatus =
  | "OPEN"
  | "PLANNING"
  | "ACTIVE"
  | "ACHIEVED"
  | "ABANDONED";

export const GOAL_STATUS_TONE: Record<GoalStatus, string> = {
  OPEN: "bg-subtle text-muted-foreground",
  PLANNING: "bg-warning/10 text-warning",
  ACTIVE: "bg-ember/15 text-ember",
  ACHIEVED: "bg-success/20 text-success",
  ABANDONED: "bg-muted/40 text-muted-foreground line-through",
};

export const GOAL_STATUSES: GoalStatus[] = [
  "OPEN",
  "PLANNING",
  "ACTIVE",
  "ACHIEVED",
  "ABANDONED",
];

/** A goal is "live" (worth auto-refreshing / pulsing) while in flight. */
export function isGoalLive(status: string): boolean {
  return status === "ACTIVE" || status === "PLANNING";
}
