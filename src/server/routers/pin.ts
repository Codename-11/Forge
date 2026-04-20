import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "@/server/trpc";

/**
 * Personal pins — cross-workspace bookmarks for the signed-in user.
 *
 * Stored directly on `User.pinnedIssueIds` as an ordered string[] (max 3).
 * Because the column already exists on the schema, no migration is needed;
 * this router just maintains it and resolves the ids to full issue rows
 * filtered to the user's accessible workspaces.
 *
 * Pins are workspace-agnostic by design — the whole point is the strip in
 * the shell that shows the three most important things across *every*
 * workspace you care about.
 */

const MAX_PINS = 3;

export const pinRouter = router({
  /**
   * Ordered list of the caller's pinned issues, resolved to enough detail
   * for the header strip + pin list: title, workspace, key, status, etc.
   * Silently drops ids the user no longer has access to (soft-deleted,
   * removed membership, etc.) without mutating the stored array — that way
   * toggling membership back restores the pin.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { pinnedIssueIds: true },
    });
    const ids = user.pinnedIssueIds;
    if (ids.length === 0) return [];

    const issues = await ctx.db.issue.findMany({
      where: {
        id: { in: ids },
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

    // Preserve the user-defined ordering rather than whatever the DB returns.
    const byId = new Map(issues.map((i) => [i.id, i]));
    return ids
      .map((id) => byId.get(id))
      .filter((x): x is NonNullable<typeof x> => x !== undefined);
  }),

  /**
   * Replace the pin list. Caps at 3. Validates every id still resolves to
   * an issue the caller can see; rejects the whole set if any id fails,
   * rather than silently dropping — the UI should only send ids the user
   * just saw.
   */
  set: protectedProcedure
    .input(z.object({ issueIds: z.array(z.string().cuid()).max(MAX_PINS) }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.issueIds)];
      if (ids.length > MAX_PINS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Max ${MAX_PINS} pins.`,
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
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { pinnedIssueIds: ids },
      });
      return { pinnedIssueIds: ids };
    }),

  /**
   * Convenience toggle used by the "p" keyboard shortcut + pin button on
   * the issue detail header. Returns the new list so the UI can update
   * optimistically.
   */
  toggle: protectedProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { pinnedIssueIds: true },
      });
      const current = user.pinnedIssueIds;
      let next: string[];
      if (current.includes(input.issueId)) {
        next = current.filter((id) => id !== input.issueId);
      } else {
        // Must be an accessible issue before we pin it.
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
        next = [...current, input.issueId].slice(-MAX_PINS);
      }
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { pinnedIssueIds: next },
      });
      return {
        pinnedIssueIds: next,
        pinned: next.includes(input.issueId),
      };
    }),
});
