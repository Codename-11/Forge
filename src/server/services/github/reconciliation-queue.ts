import "server-only";
import { maintenanceQueue } from "@/server/queues";

export type GitHubResourceReconcileJob = {
  workspaceId: string;
  externalResourceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
};

/**
 * Debounce webhook/card refresh hints into one trusted GitHub aggregate read.
 * The scheduled reconciliation sweep remains the restart-safe repair path.
 */
export async function enqueueGitHubResourceReconciliation(
  input: GitHubResourceReconcileJob,
): Promise<void> {
  await maintenanceQueue.add("github-resource-reconcile", input, {
    jobId: `github-resource-reconcile-${input.externalResourceId}`,
    delay: 1_000,
    attempts: 4,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}
