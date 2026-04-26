/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Used to start background tickers that don't warrant a separate worker
 * container (recurring-issue scheduler, BullMQ workers, etc.).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startRecurringTicker } = await import("@/server/services/recurring");
  startRecurringTicker();

  // Boot BullMQ workers in-process. Importing `@/server/worker` triggers
  // the side-effect Worker(...) constructors and the recurring sweep
  // registrations. We run the workers inside the Next.js node process to
  // avoid a separate container — fine at this scale; split into a
  // dedicated worker service when throughput demands it.
  await import("@/server/worker");
}
