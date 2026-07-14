import "server-only";
import type { PrismaClient } from "@prisma/client";
import { logger } from "@/server/logger";
import { GitHubRequestError } from "@/server/services/github/client";
import { syncGitHubExternalResource } from "@/server/services/github/resource-sync";

const PROVIDER = "GITHUB";
const RESOURCE_TYPE = "PULL_REQUEST";
const LEASE_MS = 2 * 60_000;

export type GitHubReconciliationResult = {
  workspaces: number;
  inspected: number;
  reconciled: number;
  failed: number;
  rateLimited: number;
  skipped: number;
};

type SyncResource = typeof syncGitHubExternalResource;

function retryAtForFailure(args: {
  error: unknown;
  failureCount: number;
  baseMinutes: number;
  maxMinutes: number;
  now: Date;
}): { retryAt: Date; rateLimited: boolean; message: string } {
  const error = args.error;
  const providerRetryAt = error instanceof GitHubRequestError ? error.retryAt : null;
  const rateLimited = error instanceof GitHubRequestError && error.rateLimited;
  const exponentialMinutes = Math.min(
    args.maxMinutes,
    args.baseMinutes * 2 ** Math.max(0, args.failureCount - 1),
  );
  const fallback = new Date(args.now.getTime() + exponentialMinutes * 60_000);
  return {
    retryAt: providerRetryAt && providerRetryAt > fallback ? providerRetryAt : fallback,
    rateLimited,
    message: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown GitHub sync error",
  };
}

function checksMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const checks = (value as Record<string, unknown>).checks;
  return checks && typeof checks === "object" && !Array.isArray(checks)
    ? (checks as Record<string, unknown>)
    : {};
}

/**
 * Reconcile stale native IMPLEMENTS links. GitHub webhooks stay primary; this
 * sweep is a bounded repair loop for missed delivery, permission recovery, and
 * worker restarts. A short DB lease prevents overlapping workers/manual jobs
 * from polling the same row at once and naturally expires after a crash.
 */
export async function sweepGitHubStatusReconciliation(
  db: PrismaClient,
  options: {
    workspaceId?: string;
    now?: Date;
    syncResource?: SyncResource;
  } = {},
): Promise<GitHubReconciliationResult> {
  const now = options.now ?? new Date();
  const syncResource = options.syncResource ?? syncGitHubExternalResource;
  const result: GitHubReconciliationResult = {
    workspaces: 0,
    inspected: 0,
    reconciled: 0,
    failed: 0,
    rateLimited: 0,
    skipped: 0,
  };
  const workspaces = await db.workspace.findMany({
    where: {
      deletedAt: null,
      githubSyncEnabled: true,
      ...(options.workspaceId ? { id: options.workspaceId } : {}),
    },
    select: {
      id: true,
      githubSyncStaleMinutes: true,
      githubSyncBatchSize: true,
      githubSyncBackoffMinutes: true,
      githubSyncMaxBackoffMinutes: true,
    },
  });

  for (const workspace of workspaces) {
    result.workspaces += 1;
    if (workspace.githubSyncBatchSize <= 0 || workspace.githubSyncStaleMinutes <= 0) {
      continue;
    }
    const staleBefore = new Date(now.getTime() - workspace.githubSyncStaleMinutes * 60_000);
    const candidates = await db.externalResource.findMany({
      where: {
        workspaceId: workspace.id,
        provider: PROVIDER,
        resourceType: RESOURCE_TYPE,
        syncTerminalAt: null,
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lte: staleBefore } }],
        AND: [{ OR: [{ syncRetryAt: null }, { syncRetryAt: { lte: now } }] }],
        links: {
          some: {
            workspaceId: workspace.id,
            kind: "IMPLEMENTS",
            issue: { workspaceId: workspace.id, deletedAt: null },
          },
        },
      },
      select: { id: true, syncFailureCount: true },
      orderBy: [{ lastSyncedAt: "asc" }, { id: "asc" }],
      take: workspace.githubSyncBatchSize,
    });

    for (const candidate of candidates) {
      result.inspected += 1;
      const leaseUntil = new Date(now.getTime() + LEASE_MS);
      const claimed = await db.externalResource.updateMany({
        where: {
          id: candidate.id,
          workspaceId: workspace.id,
          syncTerminalAt: null,
          OR: [{ syncRetryAt: null }, { syncRetryAt: { lte: now } }],
        },
        data: { syncAttemptedAt: now, syncRetryAt: leaseUntil },
      });
      if (claimed.count === 0) {
        result.skipped += 1;
        continue;
      }

      try {
        const resource = await syncResource({
          db,
          workspaceId: workspace.id,
          externalResourceId: candidate.id,
          actor: { actorId: null },
        });
        const checks = checksMetadata(resource.metadata);
        // A merged PR with zero/partially-readable checks must remain held, but
        // exponential retry keeps repositories with no CI from being polled at
        // the normal stale cadence forever. Provider retry headers win.
        if (resource.state === "merged" && checks.status === "unknown") {
          const failureCount = candidate.syncFailureCount + 1;
          const exponential = retryAtForFailure({
            error: new Error(
              typeof checks.diagnostic === "string"
                ? checks.diagnostic
                : "No aggregate GitHub checks are available for this merged PR.",
            ),
            failureCount,
            baseMinutes: Math.max(1, workspace.githubSyncBackoffMinutes),
            maxMinutes: Math.max(1, workspace.githubSyncMaxBackoffMinutes),
            now,
          });
          const providerRetryAt =
            typeof checks.retryAt === "string" ? new Date(checks.retryAt) : null;
          await db.externalResource.updateMany({
            where: { id: candidate.id, workspaceId: workspace.id },
            data: {
              syncFailureCount: failureCount,
              syncLastError: exponential.message,
              syncRetryAt:
                providerRetryAt &&
                Number.isFinite(providerRetryAt.getTime()) &&
                providerRetryAt > exponential.retryAt
                  ? providerRetryAt
                  : exponential.retryAt,
            },
          });
        }
        result.reconciled += 1;
      } catch (error) {
        const failureCount = candidate.syncFailureCount + 1;
        const retry = retryAtForFailure({
          error,
          failureCount,
          baseMinutes: Math.max(1, workspace.githubSyncBackoffMinutes),
          maxMinutes: Math.max(1, workspace.githubSyncMaxBackoffMinutes),
          now,
        });
        await db.externalResource.updateMany({
          where: { id: candidate.id, workspaceId: workspace.id },
          data: {
            syncAttemptedAt: now,
            syncRetryAt: retry.retryAt,
            syncFailureCount: failureCount,
            syncLastError: retry.message,
          },
        });
        result.failed += 1;
        if (retry.rateLimited) result.rateLimited += 1;
        logger.warn(
          {
            err: error,
            workspaceId: workspace.id,
            externalResourceId: candidate.id,
            retryAt: retry.retryAt,
            failureCount,
          },
          "github-reconciliation: resource sync failed",
        );
      }
    }
  }

  if (result.inspected > 0 || result.failed > 0) {
    logger.info(result, "github-reconciliation: sweep complete");
  }
  return result;
}
