import { z } from "zod";
import { router, workspaceProcedure } from "@/server/trpc";
import { INTEGRATION_ADAPTERS } from "@/server/integrations/adapters";

const idString = z.string().min(1).max(40);

export const integrationRouter = router({
  /**
   * List all known integration adapters + which agents in this workspace
   * are using each. Drives the integrations index page.
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const agents = await ctx.db.agent.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      select: {
        id: true,
        name: true,
        profileKey: true,
        avatar: true,
        provider: true,
        runtimeMode: true,
        status: true,
        lastHeartbeatAt: true,
      },
    });
    const byProvider = new Map<string, typeof agents>();
    for (const a of agents) {
      const list = byProvider.get(a.provider) ?? [];
      list.push(a);
      byProvider.set(a.provider, list);
    }
    return INTEGRATION_ADAPTERS.map((adapter) => ({
      ...adapter,
      agents: byProvider.get(adapter.kind) ?? [],
    }));
  }),

  /**
   * Return the manifest for a single adapter, plus its installed agents.
   * Powers the "install" detail page.
   */
  byKind: workspaceProcedure
    .input(
      z.object({
        kind: z.string().min(1).max(40),
        presence: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const adapter = INTEGRATION_ADAPTERS.find(
        (a) =>
          a.kind === input.kind &&
          (!input.presence || a.presence === input.presence),
      );
      if (!adapter) return null;
      const agents = await ctx.db.agent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          provider: adapter.kind as never,
          archivedAt: null,
        },
        select: {
          id: true,
          name: true,
          profileKey: true,
          avatar: true,
          runtimeMode: true,
          status: true,
          lastHeartbeatAt: true,
          webhookUrl: true,
        },
      });
      return { ...adapter, agents };
    }),

  /**
   * Apply an adapter's defaults to an existing agent (sets provider +
   * runtimeMode to match). Useful for tagging legacy agents.
   */
  applyToAgent: workspaceProcedure
    .input(
      z.object({
        agentId: idString,
        kind: z.string().min(1).max(40),
        presence: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const adapter = INTEGRATION_ADAPTERS.find(
        (a) =>
          a.kind === input.kind &&
          (!input.presence || a.presence === input.presence),
      );
      if (!adapter) throw new Error("Unknown integration");
      return ctx.db.agent.update({
        where: { id: input.agentId },
        data: {
          provider: adapter.kind as never,
          runtimeMode: adapter.defaultRuntimeMode,
        },
      });
    }),
});
