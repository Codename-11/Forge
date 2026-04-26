import { z } from "zod";
import { router, workspaceProcedure } from "@/server/trpc";
import { composeStandup } from "@/server/services/standup";

/**
 * Standup tRPC router. All the work lives in
 * `src/server/services/standup.ts` so the MCP `standup.draft` tool and
 * any future scheduled job (Slack daily digest etc.) can call into the
 * same composer without re-implementing the query.
 */
export const standupRouter = router({
  draft: workspaceProcedure
    .input(
      z
        .object({
          sinceHours: z.number().int().min(1).max(168).default(24),
        })
        .default({}),
    )
    .query(({ ctx, input }) =>
      composeStandup({
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        sinceHours: input.sinceHours,
      }),
    ),
});
