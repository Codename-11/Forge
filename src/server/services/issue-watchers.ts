import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Auto-watch primitives — keep a single source of truth so the watcher
 * upsert logic doesn't drift between issue.create, issue.update,
 * comment.create, and the dispatcher.
 *
 * All inserts are `upsert` (create-if-missing, no-op-if-present) so
 * concurrent writers don't race the unique constraints
 * (`@@unique([issueId, userId])` / `@@unique([issueId, agentId])`).
 *
 * Watch is "sticky" — once a user or agent is watching, they stay
 * watching until they manually unwatch (matches GitHub behavior).
 * Agent wake fan-out is a separate opt-in bit (`wakeOnActivity`):
 * assignment enables it, reassignment can demote old agent rows, and
 * passive mentions can stay visible without becoming future ghost work.
 */

/**
 * Upsert a user as a watcher of an issue. Workspace-scoped so a stray
 * call with a mismatched workspaceId would create a row scoped to the
 * caller's tenant, not the issue's — the @@unique on (issueId, userId)
 * still prevents duplicates within an issue.
 */
export async function autoWatchUser(
  db: DbClient,
  params: { workspaceId: string; issueId: string; userId: string },
): Promise<void> {
  await db.issueWatcher.upsert({
    where: {
      issueId_userId: { issueId: params.issueId, userId: params.userId },
    },
    create: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      userId: params.userId,
    },
    update: {},
  });
}

/**
 * Upsert an agent as a watcher of an issue. Same semantics as
 * `autoWatchUser`, but on the `(issueId, agentId)` unique tuple.
 */
export async function autoWatchAgent(
  db: DbClient,
  params: {
    workspaceId: string;
    issueId: string;
    agentId: string;
    wakeOnActivity?: boolean;
  },
): Promise<void> {
  await db.issueWatcher.upsert({
    where: {
      issueId_agentId: { issueId: params.issueId, agentId: params.agentId },
    },
    create: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      wakeOnActivity: params.wakeOnActivity ?? false,
    },
    update: params.wakeOnActivity ? { wakeOnActivity: true } : {},
  });
}

/**
 * Mark exactly one agent watcher as activity-wake eligible for an issue.
 * Existing watcher rows stay in place for visibility/history, but previous
 * assignees are demoted so generic issue activity cannot page them.
 */
export async function setIssueAgentWakeTarget(
  db: DbClient,
  params: { workspaceId: string; issueId: string; agentId: string | null },
): Promise<void> {
  await db.issueWatcher.updateMany({
    where: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      AND: [
        { agentId: { not: null } },
        ...(params.agentId ? [{ agentId: { not: params.agentId } }] : []),
      ],
    },
    data: { wakeOnActivity: false },
  });
  if (!params.agentId) return;
  await autoWatchAgent(db, {
    workspaceId: params.workspaceId,
    issueId: params.issueId,
    agentId: params.agentId,
    wakeOnActivity: true,
  });
}

/**
 * Convenience wrapper for the common case "watch the actor of this
 * mutation." Picks user-watch vs. agent-watch based on whether the
 * caller authenticated via an agent-linked API key.
 *
 * - `callerAgentId` set → agent watcher (humans never see "Victor was
 *   added as a watcher" for their own automation).
 * - `callerAgentId` null + `userId` set → user watcher.
 * - Both null → no-op (system-driven mutation; nobody to subscribe).
 */
export async function autoWatchActor(
  db: DbClient,
  params: {
    workspaceId: string;
    issueId: string;
    userId: string | null;
    callerAgentId: string | null;
  },
): Promise<void> {
  if (params.callerAgentId) {
    await autoWatchAgent(db, {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.callerAgentId,
      wakeOnActivity: false,
    });
    return;
  }
  if (params.userId) {
    await autoWatchUser(db, {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      userId: params.userId,
    });
  }
}
