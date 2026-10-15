import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";

/**
 * Must run inside an interactive transaction. The parent-row lock conflicts
 * with the FK key-share lock used by concurrent runtime registrations, so a
 * runtime cannot be inserted between the safety check and workspace deletion.
 * Run optional cleanup only after these guards, while the workspace still
 * reserves its unique slug. Buckets are slug-named: post-commit cleanup could
 * delete a replacement workspace's bucket if that slug has been reused.
 * Storage and Postgres remain non-atomic: a later DB failure cannot restore
 * removed objects. This preserves the existing cleanup-before-delete contract.
 */
export async function deleteWorkspacePreservingRuntimes(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  confirmName: string,
  beforeDelete?: () => Promise<void>,
) {
  const rows = await tx.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT "id", "name" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE
  `;
  const workspace = rows[0];
  if (!workspace) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace no longer exists." });
  }
  if (confirmName !== workspace.name) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Confirmation name does not match workspace name.",
    });
  }

  // Runtime.workspaceId is still a cascading registration-home FK, while
  // ownership and profile use can extend beyond this workspace. Include
  // archived, disabled, unbound, and legacy ownerless hosts: archival does
  // not abandon their configuration or invalidate references elsewhere.
  const runtime = await tx.runtime.findFirst({
    where: { workspaceId },
    select: { id: true },
  });
  if (runtime) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This workspace is the registration home of a runtime, including possibly an archived runtime. Deleting it would also remove that runtime and could affect agents elsewhere. Archive the workspace instead, or ask an instance administrator to review runtime relocation before deletion. Archiving a runtime does not remove this protection.",
    });
  }
  await beforeDelete?.();
  return tx.workspace.delete({ where: { id: workspaceId } });
}
