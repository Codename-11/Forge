import { Worker } from "bullmq";

const blockedOrigin = process.env.FORGE_TEST_BLOCKED_RUNTIME_ORIGIN;
if (!blockedOrigin) throw new Error("FORGE_TEST_BLOCKED_RUNTIME_ORIGIN is required.");

const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(blockedOrigin)) {
    return Promise.reject(new TypeError("Worker test egress blocked."));
  }
  return nativeFetch(input, init);
}) as typeof globalThis.fetch;

async function main() {
  const { executeQueuedRuntimeDiagnostic } = await import(
    "../../src/server/services/runtime-diagnostics"
  );

  const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };
  const worker = new Worker(
    "runtime-diagnostics",
    async (job) => executeQueuedRuntimeDiagnostic(job.data),
    { connection, concurrency: 1 },
  );

  await worker.waitUntilReady();
  process.stdout.write("RUNTIME_DIAGNOSTIC_WORKER_READY\n");

  async function shutdown() {
    await worker.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
