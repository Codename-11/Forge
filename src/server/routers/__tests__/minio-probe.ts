/**
 * Liveness probe for the dev MinIO container used by storage-touching
 * test suites. When the container isn't running, the storage tests
 * surface as ECONNREFUSED on every assertion — useless noise.
 *
 * `isMinioUp` returns true if `${endpoint}/minio/health/live` returns
 * a 2xx within 1.5s. Suites that require MinIO swap their `describe`
 * for `describeIfMinio`, which becomes `describe.skip` when the probe
 * fails. Skipped tests still appear in the runner output (with a
 * "skipped" label and the reason in the suite name) instead of
 * polluting the failure count.
 *
 * Usage:
 *
 *   import { describeIfMinio } from "@/server/routers/__tests__/minio-probe";
 *   const minio = await describeIfMinio();
 *   minio.describe("attachmentRouter", () => { ... });
 *
 * The endpoint resolves from `S3_ENDPOINT` env (set by the suite's
 * `beforeAll`) with a localhost:9000 default. We rely on MinIO's
 * unauthenticated health endpoint — no creds needed.
 */
import { describe } from "vitest";

const PROBE_PATH = "/minio/health/live";
const PROBE_TIMEOUT_MS = 1500;

let cached: Promise<boolean> | null = null;

function probeOnce(): Promise<boolean> {
  const endpoint =
    process.env.S3_ENDPOINT ??
    process.env.MINIO_ENDPOINT ??
    "http://localhost:9000";
  return fetch(`${endpoint}${PROBE_PATH}`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
    .then((r) => r.ok)
    .catch(() => false);
}

/**
 * Cached liveness probe. Runs once per test process.
 */
export function isMinioUp(): Promise<boolean> {
  if (!cached) cached = probeOnce();
  return cached;
}

/**
 * Returns the appropriate describe function — real `describe` when
 * MinIO is reachable, `describe.skip` otherwise. Await once at the top
 * of a suite that touches storage.
 *
 * Typed as the loose suite-collector signature so the returned function
 * can be called as `describe(name, fn)` without TypeScript complaining
 * about the `skipIf`/`runIf` shape on `describe.skip`.
 */
type DescribeLike = (name: string, fn: () => void) => void;

export async function describeIfMinio(): Promise<{
  describe: DescribeLike;
  up: boolean;
}> {
  const up = await isMinioUp();
  const fn: DescribeLike = up
    ? (name, body) => describe(name, body)
    : (name, body) => describe.skip(name, body);
  return { describe: fn, up };
}
