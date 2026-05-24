import { router, workspaceProcedure } from "@/server/trpc";
import { RUNTIME_ADAPTERS, defaultAdapterForProvider } from "@/server/runtimes/adapters";
import { tierForTransport } from "@/lib/transport-display";

/**
 * Integrations index — now sourced from the canonical provider-agnostic
 * RuntimeAdapter registry (`src/server/runtimes/adapters.ts`), NOT the retired
 * provider-keyed manifest. Each adapter carries its tier (first-class / session
 * / basic), transport, and chatMode so the page can group + badge them, and we
 * attach the workspace's agents that use each adapter.
 */
export const integrationRouter = router({
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
        runtime: { select: { adapterKey: true } },
      },
    });

    // Associate each agent with an adapter: precise via its attached runtime's
    // adapterKey, else by its provider's default adapter (so unattached agents
    // still surface under the right card without double-counting CLAUDE across
    // claude-code + claude-desktop).
    const byAdapter = new Map<string, typeof agents>();
    for (const a of agents) {
      const key = a.runtime?.adapterKey ?? defaultAdapterForProvider(a.provider)?.key;
      if (!key) continue;
      const list = byAdapter.get(key) ?? [];
      list.push(a);
      byAdapter.set(key, list);
    }

    return RUNTIME_ADAPTERS.map((adapter) => {
      const tier = tierForTransport(adapter.transport);
      return {
        key: adapter.key,
        title: adapter.title,
        tagline: adapter.tagline,
        iconKey: adapter.iconKey,
        transport: adapter.transport,
        chatMode: adapter.chatMode,
        managed: adapter.managed,
        multiAgent: adapter.multiAgent,
        tier: tier.n,
        tierLabel: tier.label,
        providers: adapter.providers,
        defaultRuntimeMode: adapter.defaultRuntimeMode,
        defaultRunEngine: adapter.defaultRunEngine,
        defaultKeyKind: adapter.defaultKeyKind,
        capabilities: adapter.capabilities,
        setupMarkdown: adapter.setupMarkdown,
        mcpSnippet: adapter.mcpSnippet,
        agents: byAdapter.get(adapter.key) ?? [],
      };
    });
  }),
});
