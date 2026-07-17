import "server-only";
import type { PrismaClient } from "@prisma/client";
import { logger } from "@/server/logger";
import { GitHubRequestError } from "@/server/services/github/client";
import { syncGitHubExternalResource } from "@/server/services/github/resource-sync";
import { IMPLEMENTATION_LINK_KINDS } from "@/server/services/github/types";

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
  partial: number;
  budgetExhausted: boolean;
  circuitBroken: boolean;
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

type ReconciliationCandidate = {
  id: string;
  state: string;
  lastSyncedAt: Date | null;
  syncTerminalAt: Date | null;
  syncFailureCount: number;
  connectionMappingId: string | null;
};

export async function claimGitHubReconciliationCandidate(args: {
  db: PrismaClient;
  workspaceId: string;
  candidate: ReconciliationCandidate;
  now: Date;
  staleBefore: Date;
  dormantBefore: Date;
  leaseUntil: Date;
}): Promise<boolean> {
  const candidateEligibility = args.candidate.syncTerminalAt
    ? {
        state: "closed",
        syncTerminalAt: args.candidate.syncTerminalAt,
        AND: [{ syncTerminalAt: { lte: args.dormantBefore } }],
      }
    : {
        syncTerminalAt: null,
        lastSyncedAt: args.candidate.lastSyncedAt,
        AND: [
          {
            OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lte: args.staleBefore } }],
          },
        ],
      };
  const claimed = await args.db.externalResource.updateMany({
    where: {
      id: args.candidate.id,
      workspaceId: args.workspaceId,
      provider: PROVIDER,
      resourceType: RESOURCE_TYPE,
      ...candidateEligibility,
      OR: [{ syncRetryAt: null }, { syncRetryAt: { lte: args.now } }],
    },
    data: { syncAttemptedAt: args.now, syncRetryAt: args.leaseUntil },
  });
  return claimed.count === 1;
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
    clock?: () => number;
  } = {},
): Promise<GitHubReconciliationResult> {
  const now = options.now ?? new Date();
  const syncResource = options.syncResource ?? syncGitHubExternalResource;
  const clock = options.clock ?? Date.now;
  const sweepStartedMs = clock();
  const result: GitHubReconciliationResult = {
    workspaces: 0,
    inspected: 0,
    reconciled: 0,
    failed: 0,
    rateLimited: 0,
    skipped: 0,
    partial: 0,
    budgetExhausted: false,
    circuitBroken: false,
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
      githubRequestTimeoutSeconds: true,
      githubSweepBudgetSeconds: true,
      githubClosedReprobeMinutes: true,
    },
  });
  // The scheduled job spans workspaces, so it needs one deterministic hard
  // ceiling as well as each workspace's local budget. The largest configured
  // budget preserves an administrator's explicit allowance without letting
  // the job consume the sum of every tenant's allowance.
  const globalDeadlineMs =
    sweepStartedMs +
    Math.max(0, ...workspaces.map((workspace) => workspace.githubSweepBudgetSeconds)) * 1000;
  let globalBudgetExhausted = false;

  for (const workspace of workspaces) {
    let workspaceCircuitBroken = false;
    result.workspaces += 1;
    if (workspace.githubSyncBatchSize <= 0 || workspace.githubSyncStaleMinutes <= 0) {
      continue;
    }
    const staleBefore = new Date(now.getTime() - workspace.githubSyncStaleMinutes * 60_000);
    const dormantBefore = new Date(now.getTime() - workspace.githubClosedReprobeMinutes * 60_000);
    const workspaceDeadlineMs = Math.min(
      globalDeadlineMs,
      clock() + workspace.githubSweepBudgetSeconds * 1000,
    );
    const candidates = await db.externalResource.findMany({
      where: {
        workspaceId: workspace.id,
        provider: PROVIDER,
        resourceType: RESOURCE_TYPE,
        OR: [
          {
            syncTerminalAt: null,
            OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lte: staleBefore } }],
          },
          {
            state: "closed",
            syncTerminalAt: { lte: dormantBefore },
          },
        ],
        AND: [{ OR: [{ syncRetryAt: null }, { syncRetryAt: { lte: now } }] }],
        links: {
          some: {
            workspaceId: workspace.id,
            kind: { in: [...IMPLEMENTATION_LINK_KINDS] },
            issue: { workspaceId: workspace.id, deletedAt: null },
          },
        },
      },
      select: {
        id: true,
        state: true,
        lastSyncedAt: true,
        syncTerminalAt: true,
        syncFailureCount: true,
        connectionMappingId: true,
      },
      orderBy: [{ syncTerminalAt: "asc" }, { lastSyncedAt: "asc" }, { id: "asc" }],
      take: workspace.githubSyncBatchSize,
    });

    for (const candidate of candidates) {
      const currentMs = clock();
      const remainingMs = workspaceDeadlineMs - currentMs;
      if (remainingMs <= 0) {
        result.budgetExhausted = true;
        globalBudgetExhausted = currentMs >= globalDeadlineMs;
        break;
      }
      result.inspected += 1;
      const leaseMs = Math.max(LEASE_MS, workspace.githubSweepBudgetSeconds * 1000 + 5_000);
      const leaseUntil = new Date(now.getTime() + leaseMs);
      const claimed = await claimGitHubReconciliationCandidate({
        db,
        workspaceId: workspace.id,
        candidate,
        now,
        staleBefore,
        dormantBefore,
        leaseUntil,
      });
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      try {
        const resource = await syncResource({
          db,
          workspaceId: workspace.id,
          externalResourceId: candidate.id,
          actor: { actorId: null },
          skipCollisionGuard: true,
          signal: AbortSignal.timeout(Math.max(1, remainingMs)),
        });
        const checks = checksMetadata(resource.metadata);
        const untrustedChecks =
          checks.source !== "api-aggregate" ||
          checks.status === "unknown" ||
          checks.partial === true;
        // Merged implementation PRs still require trusted completion evidence;
        // keep retrying partial/unknown aggregates even though merge state is a
        // separate terminal GitHub fact. Closed, unmerged PRs do not.
        if (untrustedChecks && resource.state !== "closed") {
          const failureCount = candidate.syncFailureCount + 1;
          const exponential = retryAtForFailure({
            error: new Error(
              typeof checks.diagnostic === "string"
                ? checks.diagnostic
                : "No trusted aggregate GitHub checks are available for this PR.",
            ),
            failureCount,
            baseMinutes: Math.max(1, workspace.githubSyncBackoffMinutes),
            maxMinutes: Math.max(1, workspace.githubSyncMaxBackoffMinutes),
            now,
          });
          const providerRetryAt =
            typeof checks.retryAt === "string" ? new Date(checks.retryAt) : null;
          const nextRetryAt =
            providerRetryAt &&
            Number.isFinite(providerRetryAt.getTime()) &&
            providerRetryAt > exponential.retryAt
              ? providerRetryAt
              : exponential.retryAt;
          await db.externalResource.updateMany({
            where: { id: candidate.id, workspaceId: workspace.id },
            data: {
              syncFailureCount: failureCount,
              syncLastError: exponential.message,
              syncRetryAt: nextRetryAt,
            },
          });
          result.partial += 1;
          if (checks.rateLimited === true) {
            result.rateLimited += 1;
          }
          const mappingWidePartial =
            checks.rateLimited === true ||
            checks.timedOut === true ||
            checks.permissionDenied === true;
          if (mappingWidePartial) {
            // Permission, timeout, or rate-limit failures generally affect the
            // installation/mapping, not one PR. Open a persisted circuit for
            // every resource on that mapping before ending this sweep.
            if (resource.connectionMappingId) {
              await db.externalResource.updateMany({
                where: {
                  workspaceId: workspace.id,
                  provider: PROVIDER,
                  connectionMappingId: resource.connectionMappingId,
                },
                data: {
                  syncRetryAt: nextRetryAt,
                  syncLastError: exponential.message,
                },
              });
            }
            result.circuitBroken = true;
            workspaceCircuitBroken = true;
          }
        }
        result.reconciled += 1;
        if (workspaceCircuitBroken) break;
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
        const mappingWideFailure =
          retry.rateLimited ||
          (error instanceof GitHubRequestError &&
            (error.timedOut || [401, 403].includes(error.status)));
        if (mappingWideFailure && candidate.connectionMappingId) {
          await db.externalResource.updateMany({
            where: {
              workspaceId: workspace.id,
              provider: PROVIDER,
              connectionMappingId: candidate.connectionMappingId,
            },
            data: { syncRetryAt: retry.retryAt, syncLastError: retry.message },
          });
        }
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
        if (mappingWideFailure) {
          result.circuitBroken = true;
          workspaceCircuitBroken = true;
          break;
        }
      }
    }
    if (globalBudgetExhausted) break;
  }

  if (result.inspected > 0 || result.failed > 0) {
    logger.info(result, "github-reconciliation: sweep complete");
  }
  return result;
}
