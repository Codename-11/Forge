/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Used to start lightweight web-process tickers and, in development or
 * explicitly opted-in single-process deployments, BullMQ workers.
 */
export function shouldStartInProcessWorker(env: {
  nodeEnv?: string;
  disableInProcessWorker?: string;
  enableInProcessWorker?: string;
}): boolean {
  if (env.disableInProcessWorker === "1") return false;
  if (env.enableInProcessWorker === "1") return true;
  return env.nodeEnv !== "production";
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startRecurringTicker } = await import("@/server/services/recurring");
  startRecurringTicker();

  if (
    !shouldStartInProcessWorker({
      nodeEnv: process.env.NODE_ENV,
      disableInProcessWorker: process.env.FORGE_DISABLE_IN_PROCESS_WORKER,
      enableInProcessWorker: process.env.FORGE_ENABLE_IN_PROCESS_WORKER,
    })
  ) {
    return;
  }

  // Boot BullMQ workers in-process for dev/single-process installs. Production
  // Docker deployments run the dedicated forge-worker container; starting a
  // second worker in the web process splits in-memory provider state such as
  // Codex app-server WebSocket sessions across processes.
  await import("@/server/worker");
}
