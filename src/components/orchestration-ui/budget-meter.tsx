/**
 * Re-export shim. The canonical BudgetMeter now lives in
 * `@/components/orchestration/budget-meter` (the two parallel
 * implementations were consolidated there). This shim only exists so
 * the goals LIST page — owned by another agent — keeps resolving its
 * `fmtUsd` import without an edit. Prefer importing from
 * `@/components/orchestration/budget-meter` directly in new code.
 */
export {
  BudgetMeter,
  fmtUsd,
  fmtMinutes,
} from "@/components/orchestration/budget-meter";
