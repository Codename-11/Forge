import "server-only";
import { Queue } from "bullmq";

/**
 * BullMQ queue handles, split out from `worker.ts` so that producer-side
 * code (tRPC mutations, admin retry, etc.) can enqueue jobs without
 * pulling in the `Worker` class — importing worker.ts would eagerly
 * construct a Worker inside the web process. Worker instantiation stays
 * in `worker.ts` and runs as a separate process (`pnpm worker`).
 *
 * These exports are intentionally lazy proxies. Next.js imports API route
 * modules while collecting page data during production builds; constructing
 * BullMQ queues at module load dials Redis immediately and creates noisy
 * ECONNREFUSED output inside the isolated Docker build container. The proxy
 * preserves the old `webhookQueue.add(...)` / `maintenanceQueue.add(...)`
 * call shape while opening Redis only when queue methods are actually used.
 */

type QueueName = "webhooks" | "maintenance" | "runtime-diagnostics";
type QueueCache = Partial<Record<QueueName, Queue>>;

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  lazyConnect: true,
};

const globalForQueues = globalThis as unknown as { forgeQueues?: QueueCache };
const queues: QueueCache = globalForQueues.forgeQueues ?? {};

if (process.env.NODE_ENV !== "production") {
  globalForQueues.forgeQueues = queues;
}

function getQueue(name: QueueName): Queue {
  queues[name] ??= new Queue(name, { connection });
  return queues[name];
}

function lazyQueue(name: QueueName): Queue {
  return new Proxy({} as Queue, {
    get(_target, prop) {
      const queue = getQueue(name);
      const value = Reflect.get(queue, prop);
      return typeof value === "function" ? value.bind(queue) : value;
    },
  });
}

export const webhookQueue = lazyQueue("webhooks");

export const maintenanceQueue = lazyQueue("maintenance");

export const runtimeDiagnosticQueue = lazyQueue("runtime-diagnostics");
