import "server-only";
import { Queue } from "bullmq";

/**
 * BullMQ queue handles, split out from `worker.ts` so that producer-side
 * code (tRPC mutations, admin retry, etc.) can enqueue jobs without
 * pulling in the `Worker` class — importing worker.ts would eagerly
 * construct a Worker inside the web process. Worker instantiation stays
 * in `worker.ts` and runs as a separate process (`pnpm worker`).
 */
const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };

export const webhookQueue = new Queue("webhooks", { connection });
