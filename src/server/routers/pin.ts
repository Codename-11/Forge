import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { PinTargetType, type Prisma } from "@prisma/client";
import type { db as DbInstance } from "@/server/db";
import { router, protectedProcedure } from "@/server/trpc";

/**
 * Personal pins — per-user bookmarks pointing at any first-class entity
 * (issue / project / initiative / saved view / cycle / agent).
 *
 * Storage moved from `User.pinnedIssueIds String[]` (legacy) to the
 * polymorphic `Pin` table in migration 0023. Existing values were
 * backfilled as ISSUE-typed, `workspaceId = NULL` rows so the legacy
 * cross-workspace topbar strip keeps rendering verbatim.
 *
 * Two callable surfaces share this file:
 *
 *   1. Legacy issue-only procs — `list` (no input), `set({issueIds})`,
 *      `toggle({issueId})`. These are the procedures MCP `pins.list` /
 *      `pins.set` and the existing `<PinToggleButton>` consume; their
 *      input/output shapes are preserved verbatim. Internally they
 *      operate on the new Pin table filtered to
 *      `targetType = ISSUE, workspaceId IS NULL`.
 *
 *   2. New polymorphic procs — `listAll`, `add`, `remove`, `toggleEntity`,
 *      `reorder`. These are what Phase 1 consumers (sidebar pin section,
 *      `<PinButton>`, command palette) call. They speak in terms of
 *      `(targetType, targetId, workspaceId?)` triples.
 *
 * Hydration: `listAll` resolves each pin's target to a small "card"
 * object (id / key / name / status / etc.) so the UI doesn't need a
 * second round-trip per row. Dead targets (soft-deleted, gone) are
 * silently filtered — keeping pins for items the user can't see leaves
 * the row in place so a re-pin restores it later.
 */

const MAX_LEGACY_PINS = 3;
/**
 * Cap for the modern polymorphic pin surface (per-(user, workspaceId)
 * scope). Workspace-scoped pins and cross-workspace pins each get their
 * own bucket of 5, so a user can have up to 5 pins in this workspace's
 * sidebar AND up to 5 cross-workspace pins shown in the topbar strip /
 * "All workspaces" sidebar slot.
 *
 * Enforced in `add` and the add-branch of `toggleEntity` only — unpin
 * is always allowed regardless of count so a user can recover from
 * legacy data that's already over cap.
 */
const MAX_PINS_PER_SCOPE = 5;

// Migration 0023 backfilled existing pins as `pin_${md5(...)}` while
// Prisma-generated rows use CUIDs. Both are durable public row ids and
// must remain accepted anywhere a pin id is supplied.
const pinRowIdSchema = z.union([
  z.string().cuid(),
  z.string().regex(/^pin_[a-f0-9]{32}$/, "Invalid pin id."),
]);

// ---------------------------------------------------------------------------
// Hydration helpers
// ---------------------------------------------------------------------------

type DbClient = Prisma.TransactionClient | typeof DbInstance;

interface IssueCard {
  id: string;
  key: string;
  number: number;
  title: string;
  priority: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceKey: string;
  workspaceName: string;
  status: { id: string; name: string; color: string; category: string };
  projectId: string | null;
  projectKey: string | null;
}

interface ProjectCard {
  id: string;
  key: string;
  name: string;
  color: string | null;
  icon: string | null;
  workspaceId: string;
  workspaceSlug: string;
}

interface InitiativeCard {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  status: string;
  workspaceId: string;
  workspaceSlug: string;
}

interface SavedViewCard {
  id: string;
  name: string;
  workspaceId: string;
  workspaceSlug: string;
}

interface CycleCard {
  id: string;
  name: string;
  status: string;
  workspaceId: string;
  workspaceSlug: string;
}

interface AgentCard {
  id: string;
  profileKey: string;
  name: string;
  status: string;
  workspaceId: string;
  workspaceSlug: string;
}

export type HydratedPinTarget =
  | ({ targetType: "ISSUE" } & IssueCard)
  | ({ targetType: "PROJECT" } & ProjectCard)
  | ({ targetType: "INITIATIVE" } & InitiativeCard)
  | ({ targetType: "SAVED_VIEW" } & SavedViewCard)
  | ({ targetType: "CYCLE" } & CycleCard)
  | ({ targetType: "AGENT" } & AgentCard);

export interface HydratedPin {
  id: string;
  userId: string;
  workspaceId: string | null;
  targetType: PinTargetType;
  targetId: string;
  orderIndex: number;
  createdAt: Date;
  target: HydratedPinTarget | null;
}

/**
 * Bulk-resolve a set of pin rows to their `target` cards. Issues are
 * additionally filtered to workspaces the caller has access to — same
 * gate the legacy `pin.list` query enforced. Other target types are
 * filtered through their workspace relation.
 */
export async function hydratePinTargets(
  db: DbClient,
  userId: string,
  pins: Array<{ targetType: PinTargetType; targetId: string }>,
): Promise<Map<string, HydratedPinTarget>> {
  const out = new Map<string, HydratedPinTarget>();
  if (pins.length === 0) return out;

  const byType = new Map<PinTargetType, string[]>();
  for (const p of pins) {
    const arr = byType.get(p.targetType) ?? [];
    arr.push(p.targetId);
    byType.set(p.targetType, arr);
  }

  const accessibleWorkspace = {
    deletedAt: null,
    memberships: { some: { userId } },
  } as const;

  // ISSUE
  const issueIds = byType.get("ISSUE");
  if (issueIds && issueIds.length > 0) {
    const rows = await db.issue.findMany({
      where: {
        id: { in: issueIds },
        deletedAt: null,
        workspace: accessibleWorkspace,
      },
      select: {
        id: true,
        number: true,
        title: true,
        priority: true,
        workspaceId: true,
        projectId: true,
        workspace: { select: { slug: true, key: true, name: true } },
        project: { select: { key: true } },
        status: { select: { id: true, name: true, color: true, category: true } },
      },
    });
    for (const r of rows) {
      out.set(`ISSUE:${r.id}`, {
        targetType: "ISSUE",
        id: r.id,
        number: r.number,
        title: r.title,
        priority: r.priority,
        key: `${r.workspace.key}-${r.number}`,
        workspaceId: r.workspaceId,
        workspaceSlug: r.workspace.slug,
        workspaceKey: r.workspace.key,
        workspaceName: r.workspace.name,
        status: r.status,
        projectId: r.projectId,
        projectKey: r.project?.key ?? null,
      });
    }
  }

  // PROJECT
  const projectIds = byType.get("PROJECT");
  if (projectIds && projectIds.length > 0) {
    const rows = await db.project.findMany({
      where: {
        id: { in: projectIds },
        deletedAt: null,
        workspace: accessibleWorkspace,
      },
      select: {
        id: true,
        key: true,
        name: true,
        color: true,
        icon: true,
        workspaceId: true,
        workspace: { select: { slug: true } },
      },
    });
    for (const r of rows) {
      out.set(`PROJECT:${r.id}`, {
        targetType: "PROJECT",
        id: r.id,
        key: r.key,
        name: r.name,
        color: r.color,
        icon: r.icon,
        workspaceId: r.workspaceId,
        workspaceSlug: r.workspace.slug,
      });
    }
  }

  // INITIATIVE
  const initiativeIds = byType.get("INITIATIVE");
  if (initiativeIds && initiativeIds.length > 0) {
    const rows = await db.initiative.findMany({
      where: {
        id: { in: initiativeIds },
        workspace: accessibleWorkspace,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        color: true,
        status: true,
        workspaceId: true,
        workspace: { select: { slug: true } },
      },
    });
    for (const r of rows) {
      out.set(`INITIATIVE:${r.id}`, {
        targetType: "INITIATIVE",
        id: r.id,
        slug: r.slug,
        name: r.name,
        color: r.color,
        status: r.status,
        workspaceId: r.workspaceId,
        workspaceSlug: r.workspace.slug,
      });
    }
  }

  // SAVED_VIEW
  const viewIds = byType.get("SAVED_VIEW");
  if (viewIds && viewIds.length > 0) {
    const rows = await db.issueSavedView.findMany({
      where: {
        id: { in: viewIds },
        workspace: accessibleWorkspace,
      },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        workspace: { select: { slug: true } },
      },
    });
    for (const r of rows) {
      out.set(`SAVED_VIEW:${r.id}`, {
        targetType: "SAVED_VIEW",
        id: r.id,
        name: r.name,
        workspaceId: r.workspaceId,
        workspaceSlug: r.workspace.slug,
      });
    }
  }

  // CYCLE
  const cycleIds = byType.get("CYCLE");
  if (cycleIds && cycleIds.length > 0) {
    const rows = await db.cycle.findMany({
      where: {
        id: { in: cycleIds },
        workspace: accessibleWorkspace,
      },
      select: {
        id: true,
        name: true,
        status: true,
        workspaceId: true,
        workspace: { select: { slug: true } },
      },
    });
    for (const r of rows) {
      out.set(`CYCLE:${r.id}`, {
        targetType: "CYCLE",
        id: r.id,
        name: r.name,
        status: r.status,
        workspaceId: r.workspaceId,
        workspaceSlug: r.workspace.slug,
      });
    }
  }

  // AGENT
  const agentIds = byType.get("AGENT");
  if (agentIds && agentIds.length > 0) {
    const rows = await db.agent.findMany({
      where: {
        id: { in: agentIds },
        archivedAt: null,
        workspace: accessibleWorkspace,
      },
      select: {
        id: true,
        profileKey: true,
        name: true,
        status: true,
        workspaceId: true,
        workspace: { select: { slug: true } },
      },
    });
    for (const r of rows) {
      out.set(`AGENT:${r.id}`, {
        targetType: "AGENT",
        id: r.id,
        profileKey: r.profileKey,
        name: r.name,
        status: r.status,
        workspaceId: r.workspaceId,
        workspaceSlug: r.workspace.slug,
      });
    }
  }

  return out;
}

/**
 * Cross-tenant existence check for a candidate pin target. Returns
 * `true` only when the target row exists AND the caller has access to
 * its workspace (membership). Used by `add` / `toggleEntity` to refuse
 * pinning rows the caller can't see.
 */
async function targetIsAccessible(
  db: DbClient,
  userId: string,
  targetType: PinTargetType,
  targetId: string,
  workspaceId: string | null,
): Promise<boolean> {
  const accessibleWorkspace = {
    deletedAt: null,
    memberships: { some: { userId } },
  } as const;
  // When workspaceId is supplied, additionally require the target to
  // live in that workspace (defensive — the caller might pass mismatched
  // ids). When null, just check the target lives in any accessible
  // workspace.
  const wsClause = workspaceId
    ? { id: workspaceId, ...accessibleWorkspace }
    : accessibleWorkspace;

  switch (targetType) {
    case "ISSUE": {
      const row = await db.issue.findFirst({
        where: { id: targetId, deletedAt: null, workspace: wsClause },
        select: { id: true },
      });
      return !!row;
    }
    case "PROJECT": {
      const row = await db.project.findFirst({
        where: { id: targetId, deletedAt: null, workspace: wsClause },
        select: { id: true },
      });
      return !!row;
    }
    case "INITIATIVE": {
      const row = await db.initiative.findFirst({
        where: { id: targetId, workspace: wsClause },
        select: { id: true },
      });
      return !!row;
    }
    case "SAVED_VIEW": {
      const row = await db.issueSavedView.findFirst({
        where: { id: targetId, workspace: wsClause },
        select: { id: true },
      });
      return !!row;
    }
    case "CYCLE": {
      const row = await db.cycle.findFirst({
        where: { id: targetId, workspace: wsClause },
        select: { id: true },
      });
      return !!row;
    }
    case "AGENT": {
      const row = await db.agent.findFirst({
        where: { id: targetId, archivedAt: null, workspace: wsClause },
        select: { id: true },
      });
      return !!row;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const pinRouter = router({
  // ------------------------------------------------------------------ Legacy
  // Issue-only, cross-workspace, returns the same shape MCP/Hermes/the
  // pins-strip already consume. Backed by the new Pin table.

  /**
   * Ordered list of the caller's pinned issues (legacy contract). Filters
   * to `targetType = ISSUE` + `workspaceId IS NULL` so this is the
   * cross-workspace strip semantic the existing strip + MCP `pins.list`
   * expect. Silently drops dead/inaccessible rows.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const pins = await ctx.db.pin.findMany({
      where: {
        userId: ctx.session.user.id,
        workspaceId: null,
        targetType: "ISSUE",
      },
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      select: { targetId: true },
    });
    if (pins.length === 0) return [];

    const issues = await ctx.db.issue.findMany({
      where: {
        id: { in: pins.map((p) => p.targetId) },
        deletedAt: null,
        workspace: {
          deletedAt: null,
          memberships: { some: { userId: ctx.session.user.id } },
        },
      },
      select: {
        id: true,
        number: true,
        title: true,
        priority: true,
        workspace: { select: { id: true, slug: true, key: true, name: true } },
        status: {
          select: { id: true, name: true, color: true, category: true },
        },
      },
    });

    const byId = new Map(issues.map((i) => [i.id, i]));
    return pins
      .map((p) => byId.get(p.targetId))
      .filter((x): x is NonNullable<typeof x> => x !== undefined);
  }),

  /**
   * Replace the cross-workspace issue pin list. Caps at 3. Validates
   * every id is accessible. Rebuilds the Pin rows for
   * `(userId, workspaceId=null, targetType=ISSUE)` to match input order.
   */
  set: protectedProcedure
    .input(z.object({ issueIds: z.array(z.string().cuid()).max(MAX_LEGACY_PINS) }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.issueIds)];
      if (ids.length > MAX_LEGACY_PINS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Max ${MAX_LEGACY_PINS} pins.`,
        });
      }
      if (ids.length > 0) {
        const count = await ctx.db.issue.count({
          where: {
            id: { in: ids },
            deletedAt: null,
            workspace: {
              deletedAt: null,
              memberships: { some: { userId: ctx.session.user.id } },
            },
          },
        });
        if (count !== ids.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more pinned issues are not accessible.",
          });
        }
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.pin.deleteMany({
          where: {
            userId: ctx.session.user.id,
            workspaceId: null,
            targetType: "ISSUE",
          },
        });
        if (ids.length > 0) {
          await tx.pin.createMany({
            data: ids.map((id, i) => ({
              userId: ctx.session.user.id,
              workspaceId: null,
              targetType: "ISSUE" as const,
              targetId: id,
              orderIndex: i,
            })),
          });
        }
      });
      return { pinnedIssueIds: ids };
    }),

  /**
   * Toggle a single issue in the cross-workspace strip (legacy `p`
   * shortcut). Returns `{ pinnedIssueIds, pinned }` for backward compat
   * with the existing `<PinToggleButton>` optimistic-update shape.
   */
  toggle: protectedProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      // Prisma's generated compound unique input requires non-null
      // workspaceId; for the cross-workspace (null) lookup we fall
      // back to findFirst, which Postgres treats as a single-row hit
      // anyway thanks to the @@unique constraint.
      const existing = await ctx.db.pin.findFirst({
        where: {
          userId: ctx.session.user.id,
          workspaceId: null,
          targetType: "ISSUE",
          targetId: input.issueId,
        },
      });
      if (existing) {
        await ctx.db.pin.delete({ where: { id: existing.id } });
      } else {
        // Must be accessible before pin.
        const ok = await ctx.db.issue.findFirst({
          where: {
            id: input.issueId,
            deletedAt: null,
            workspace: {
              deletedAt: null,
              memberships: { some: { userId: ctx.session.user.id } },
            },
          },
          select: { id: true },
        });
        if (!ok) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Issue not accessible.",
          });
        }
        // Cap at MAX_LEGACY_PINS — drop the oldest entry to make room.
        const current = await ctx.db.pin.findMany({
          where: {
            userId: ctx.session.user.id,
            workspaceId: null,
            targetType: "ISSUE",
          },
          orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
        });
        const overflow = current.length - (MAX_LEGACY_PINS - 1);
        if (overflow > 0) {
          await ctx.db.pin.deleteMany({
            where: { id: { in: current.slice(0, overflow).map((p) => p.id) } },
          });
        }
        const nextOrderIndex =
          current.length === 0
            ? 0
            : Math.max(...current.map((p) => p.orderIndex)) + 1;
        await ctx.db.pin.create({
          data: {
            userId: ctx.session.user.id,
            workspaceId: null,
            targetType: "ISSUE",
            targetId: input.issueId,
            orderIndex: nextOrderIndex,
          },
        });
      }

      const pins = await ctx.db.pin.findMany({
        where: {
          userId: ctx.session.user.id,
          workspaceId: null,
          targetType: "ISSUE",
        },
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
        select: { targetId: true },
      });
      const ids = pins.map((p) => p.targetId);
      return {
        pinnedIssueIds: ids,
        pinned: ids.includes(input.issueId),
      };
    }),

  // ------------------------------------------------------------ Polymorphic
  // New procs Phase 1 consumes. Issue-only legacy procs above stay
  // untouched; these are the surface the sidebar pin section, the
  // generic PinButton, and the command palette use.

  /**
   * List pins, optionally narrowed by workspace and/or target type,
   * each hydrated with a small "card" of target details.
   *
   * - `workspaceId` undefined: ALL the user's pins (cross-workspace +
   *    every workspace).
   * - `workspaceId` null:      cross-workspace pins only (the strip
   *    semantic — `Pin.workspaceId IS NULL`).
   * - `workspaceId` <id>:      pins scoped to that workspace only.
   *
   * `targetType` narrows further. Dead targets are silently dropped.
   */
  listAll: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().cuid().nullable().optional(),
          targetType: z.nativeEnum(PinTargetType).optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }): Promise<HydratedPin[]> => {
      const where: Prisma.PinWhereInput = {
        userId: ctx.session.user.id,
        ...(input.targetType ? { targetType: input.targetType } : {}),
      };
      // workspaceId === undefined → no narrow; explicit null/value → narrow.
      if (input.workspaceId === null) {
        where.workspaceId = null;
      } else if (typeof input.workspaceId === "string") {
        where.workspaceId = input.workspaceId;
      }

      const pins = await ctx.db.pin.findMany({
        where,
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      });
      const targets = await hydratePinTargets(
        ctx.db,
        ctx.session.user.id,
        pins,
      );
      return pins
        .map((p) => ({
          id: p.id,
          userId: p.userId,
          workspaceId: p.workspaceId,
          targetType: p.targetType,
          targetId: p.targetId,
          orderIndex: p.orderIndex,
          createdAt: p.createdAt,
          target: targets.get(`${p.targetType}:${p.targetId}`) ?? null,
        }))
        .filter((p) => p.target !== null);
    }),

  /**
   * Add a pin pointing at any target. Idempotent: if the pin already
   * exists it's returned as-is. Refuses to pin a row the caller can't
   * see (cross-tenant gate).
   */
  add: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().cuid().nullable().optional(),
        targetType: z.nativeEnum(PinTargetType),
        targetId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? null;
      const accessible = await targetIsAccessible(
        ctx.db,
        ctx.session.user.id,
        input.targetType,
        input.targetId,
        workspaceId,
      );
      if (!accessible) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pin target not accessible.",
        });
      }

      // findFirst (not findUnique on the compound key) so the
      // nullable-workspaceId lookup works — see note in `toggle`.
      const existing = await ctx.db.pin.findFirst({
        where: {
          userId: ctx.session.user.id,
          workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      });
      const pin =
        existing ??
        (await (async () => {
          const peers = await ctx.db.pin.findMany({
            where: { userId: ctx.session.user.id, workspaceId },
            select: { orderIndex: true },
          });
          if (peers.length >= MAX_PINS_PER_SCOPE) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `You can pin up to ${MAX_PINS_PER_SCOPE} items per workspace. Unpin one to make room.`,
            });
          }
          const nextOrderIndex =
            peers.length === 0
              ? 0
              : Math.max(...peers.map((p) => p.orderIndex)) + 1;
          return ctx.db.pin.create({
            data: {
              userId: ctx.session.user.id,
              workspaceId,
              targetType: input.targetType,
              targetId: input.targetId,
              orderIndex: nextOrderIndex,
            },
          });
        })());

      const targets = await hydratePinTargets(ctx.db, ctx.session.user.id, [pin]);
      return {
        ...pin,
        target: targets.get(`${pin.targetType}:${pin.targetId}`) ?? null,
      };
    }),

  /**
   * Remove a pin by row id, OR by (targetType, targetId, workspaceId?).
   * The triple form is convenient for callers that don't track the
   * row id (e.g. the toggle button knows what entity it's looking at,
   * not the Pin.id).
   */
  remove: protectedProcedure
    .input(
      z.union([
        z.object({ id: pinRowIdSchema }),
        z.object({
          targetType: z.nativeEnum(PinTargetType),
          targetId: z.string(),
          workspaceId: z.string().cuid().nullable().optional(),
        }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      if ("id" in input) {
        const res = await ctx.db.pin.deleteMany({
          where: { id: input.id, userId: ctx.session.user.id },
        });
        return { removed: res.count };
      }
      const res = await ctx.db.pin.deleteMany({
        where: {
          userId: ctx.session.user.id,
          workspaceId: input.workspaceId ?? null,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      });
      return { removed: res.count };
    }),

  /**
   * Toggle a polymorphic pin. Returns `{ pinned, pin? }` so PinButton
   * can flip its visual state with the canonical row when adding.
   */
  toggleEntity: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().cuid().nullable().optional(),
        targetType: z.nativeEnum(PinTargetType),
        targetId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? null;
      const existing = await ctx.db.pin.findFirst({
        where: {
          userId: ctx.session.user.id,
          workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
        },
      });
      if (existing) {
        await ctx.db.pin.delete({ where: { id: existing.id } });
        return { pinned: false as const };
      }
      const accessible = await targetIsAccessible(
        ctx.db,
        ctx.session.user.id,
        input.targetType,
        input.targetId,
        workspaceId,
      );
      if (!accessible) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pin target not accessible.",
        });
      }
      const peers = await ctx.db.pin.findMany({
        where: { userId: ctx.session.user.id, workspaceId },
        select: { orderIndex: true },
      });
      if (peers.length >= MAX_PINS_PER_SCOPE) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `You can pin up to ${MAX_PINS_PER_SCOPE} items per workspace. Unpin one to make room.`,
        });
      }
      const nextOrderIndex =
        peers.length === 0
          ? 0
          : Math.max(...peers.map((p) => p.orderIndex)) + 1;
      const pin = await ctx.db.pin.create({
        data: {
          userId: ctx.session.user.id,
          workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          orderIndex: nextOrderIndex,
        },
      });
      return { pinned: true as const, pin };
    }),

  /**
   * Reorder pins within a (userId, workspaceId) scope. `ids` is the
   * desired pin row ids in the new order; only pins inside this scope
   * are touched.
   */
  reorder: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().cuid().nullable().optional(),
        ids: z.array(pinRowIdSchema).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? null;
      // Validate every id belongs to this scope before any writes —
      // refuses cross-scope reorders silently rather than just dropping
      // mismatched rows.
      const owned = await ctx.db.pin.findMany({
        where: {
          id: { in: input.ids },
          userId: ctx.session.user.id,
          workspaceId,
        },
        select: { id: true },
      });
      if (owned.length !== input.ids.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Reorder includes pin ids outside this scope.",
        });
      }
      await ctx.db.$transaction(
        input.ids.map((id, idx) =>
          ctx.db.pin.update({ where: { id }, data: { orderIndex: idx } }),
        ),
      );
      return { reordered: input.ids.length };
    }),
});
