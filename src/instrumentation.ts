/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Used to start background tickers that don't warrant a separate worker
 * container (recurring-issue scheduler, etc.).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startRecurringTicker } = await import("@/server/services/recurring");
  startRecurringTicker();
}
