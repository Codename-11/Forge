import type { PrismaClient } from "@prisma/client";
import { router, globalProcedure } from "@/server/trpc";
import { deriveRuntimeHealthStatus } from "@/server/services/runtime-status";

/**
 * Cross-workspace, read-only aggregations for the global "concourse"
 * shell and Mission Control (the renamed cross-workspace home). Every
 * row carries its `workspace` so the UI can stamp a workspace chip; no
 * mutation lives here — writes happen inside a workspace
 * (`workspaceProcedure`). Part of the multi-workspace restructure
 * (see docs/plans/multiws-restructure.md, Phase 2).
 */

/** Workspace ids the caller is a member of (non-deleted). */
async function memberWorkspaceIds(db: PrismaClient, userId: string): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: { userId, workspace: { deletedAt: null } },
    select: { workspaceId: true },
  });
  return rows.map((r) => r.workspaceId);
}

export const globalRouter = router({
  /**
   * The caller's workspaces with per-workspace mini-stats for the
   * Mission Control "workspaces" card + the dedicated picker page.
   * Chip color is derived client-side from `key` (presentation only).
   */
  workspaces: globalProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.db.membership.findMany({
      where: { userId: ctx.session.user.id, workspace: { deletedAt: null } },
      select: {
        role: true,
        workspace: { select: { id: true, slug: true, name: true, key: true, avatarUrl: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return Promise.all(
      memberships.map(async (m) => {
        const ws = m.workspace;
        const [members, openIssues, agents, activeRuns, lastEvent] = await Promise.all([
          ctx.db.membership.count({ where: { workspaceId: ws.id } }),
          ctx.db.issue.count({
            where: { workspaceId: ws.id, deletedAt: null, status: { category: { notIn: ["DONE", "CANCELED"] } } },
          }),
          ctx.db.agent.count({ where: { workspaceId: ws.id, archivedAt: null } }),
          ctx.db.agentRun.count({ where: { workspaceId: ws.id, status: "ACTIVE" } }),
          ctx.db.activityEvent.findFirst({
            where: { workspaceId: ws.id },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          }),
        ]);
        return {
          id: ws.id,
          slug: ws.slug,
          name: ws.name,
          key: ws.key,
          avatarUrl: ws.avatarUrl,
          role: m.role,
          members,
          openIssues,
          agents,
          activeRuns,
          lastActiveAt: lastEvent?.createdAt ?? null,
        };
      }),
    );
  }),

  /** Metric tiles for the Mission Control header. */
  summary: globalProcedure.query(async ({ ctx }) => {
    const wsIds = await memberWorkspaceIds(ctx.db, ctx.session.user.id);
    const [openIssues, activeRuns, agentsOnline, runtimes] = await Promise.all([
      ctx.db.issue.count({
        where: { workspaceId: { in: wsIds }, deletedAt: null, status: { category: { notIn: ["DONE", "CANCELED"] } } },
      }),
      ctx.db.agentRun.count({ where: { workspaceId: { in: wsIds }, status: "ACTIVE" } }),
      ctx.db.agent.count({ where: { workspaceId: { in: wsIds }, archivedAt: null, status: { in: ["ONLINE", "BUSY"] } } }),
      ctx.db.runtime.findMany({
        where: { ownerId: ctx.session.user.id, archivedAt: null },
        select: {
          kind: true,
          adapterKey: true,
          endpoint: true,
          archivedAt: true,
          disabledAt: true,
          heartbeatAt: true,
          connectedAt: true,
          lastProbeAt: true,
          lastProbeAttempted: true,
          lastProbeReachable: true,
          lastProbeDetail: true,
        },
      }),
    ]);
    const runtimesOnline = runtimes.filter((r) => deriveRuntimeHealthStatus(r).kind === "online").length;
    return {
      workspaceCount: wsIds.length,
      openIssues,
      activeRuns,
      agentsOnline,
      runtimeCount: runtimes.length,
      runtimesOnline,
    };
  }),

  /**
   * The caller's global agent profiles (owned + instance-shared), with
   * their per-workspace bindings summarized for the global agents list.
   * Returns owned profiles even when un-bound; instance-shared profiles
   * owned by others are included read-only.
   */
  agents: globalProcedure.query(async ({ ctx }) => {
    const profiles = await ctx.db.agentProfile.findMany({
      where: { archivedAt: null, OR: [{ ownerId: ctx.session.user.id }, { instanceShared: true }] },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        profileKey: true,
        name: true,
        avatar: true,
        description: true,
        provider: true,
        runEngine: true,
        baseCapabilities: true,
        instanceShared: true,
        disabledAt: true,
        ownerId: true,
        runtime: { select: { id: true, name: true, kind: true } },
        bindings: {
          where: { archivedAt: null },
          select: {
            id: true,
            status: true,
            autoDispatchEligible: true,
            lastHeartbeatAt: true,
            workspace: { select: { id: true, slug: true, name: true, key: true } },
          },
        },
      },
    });
    return profiles.map((p) => ({
      ...p,
      ownedByMe: p.ownerId === ctx.session.user.id,
      bindingCount: p.bindings.length,
      // ONLINE if any binding is currently online/busy.
      online: p.bindings.some((b) => b.status === "ONLINE" || b.status === "BUSY"),
    }));
  }),

  /** The caller's runtimes (global, user-owned) with bound agents + workspaces in use. */
  runtimes: globalProcedure.query(async ({ ctx }) => {
    const runtimes = await ctx.db.runtime.findMany({
      where: { ownerId: ctx.session.user.id, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        adapterKey: true,
        endpoint: true,
        providersAvailable: true,
        heartbeatAt: true,
        lastProbeAt: true,
        lastProbeAttempted: true,
        lastProbeReachable: true,
        lastProbeDetail: true,
        connectedAt: true,
        disabledAt: true,
        archivedAt: true,
        createdAt: true,
        agents: {
          where: { archivedAt: null },
          select: {
            id: true,
            profileKey: true,
            name: true,
            workspace: { select: { id: true, slug: true, name: true, key: true } },
          },
        },
      },
    });
    return runtimes.map((r) => {
      const workspaces = new Map<string, { id: string; slug: string; name: string; key: string }>();
      for (const a of r.agents) workspaces.set(a.workspace.id, a.workspace);
      const health = deriveRuntimeHealthStatus(r);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        adapterKey: r.adapterKey,
        endpoint: r.endpoint,
        providersAvailable: r.providersAvailable,
        heartbeatAt: r.heartbeatAt,
        lastProbeAt: r.lastProbeAt,
        lastProbeAttempted: r.lastProbeAttempted,
        lastProbeReachable: r.lastProbeReachable,
        lastProbeDetail: r.lastProbeDetail,
        health,
        connectedAt: r.connectedAt,
        registeredAt: r.createdAt,
        online: health.kind === "online",
        disabled: !!r.disabledAt,
        boundAgents: r.agents.map((a) => ({ id: a.id, profileKey: a.profileKey, name: a.name })),
        workspacesInUse: [...workspaces.values()],
      };
    });
  }),

  /** The caller's global connections (OAuth/OIDC identities) + their per-workspace mappings. Secrets redacted. */
  connections: globalProcedure.query(async ({ ctx }) => {
    const connections = await ctx.db.connection.findMany({
      where: { ownerId: ctx.session.user.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        provider: true,
        label: true,
        account: true,
        status: true,
        scopes: true,
        error: true,
        expiresAt: true,
        createdAt: true,
        tokenEnc: true, // selected only to derive hasToken; never returned
        mappings: {
          select: {
            id: true,
            kind: true,
            target: true,
            direction: true,
            status: true,
            routeTo: true,
            workspace: { select: { id: true, slug: true, name: true, key: true } },
          },
        },
      },
    });
    return connections.map(({ tokenEnc, ...c }) => ({ ...c, hasToken: !!tokenEnc }));
  }),

  /** Cross-workspace "my work": issues assigned to the caller, newest first. */
  work: globalProcedure.query(async ({ ctx }) => {
    const wsIds = await memberWorkspaceIds(ctx.db, ctx.session.user.id);
    const assignments = await ctx.db.issueAssignee.findMany({
      where: { userId: ctx.session.user.id, issue: { workspaceId: { in: wsIds }, deletedAt: null } },
      take: 30,
      orderBy: { issue: { updatedAt: "desc" } },
      select: {
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            updatedAt: true,
            status: { select: { name: true, category: true, color: true } },
            workspace: { select: { id: true, slug: true, name: true, key: true } },
          },
        },
      },
    });
    return assignments.map((a) => a.issue);
  }),

  /** Recent activity across all the caller's workspaces, read-only. */
  activity: globalProcedure.query(async ({ ctx }) => {
    const wsIds = await memberWorkspaceIds(ctx.db, ctx.session.user.id);
    const events = await ctx.db.activityEvent.findMany({
      where: { workspaceId: { in: wsIds } },
      take: 40,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        subjectType: true,
        subjectId: true,
        payload: true,
        createdAt: true,
        actor: { select: { id: true, name: true, handle: true, image: true } },
        actorAgent: { select: { id: true, profileKey: true, name: true, avatar: true } },
        workspace: { select: { id: true, slug: true, name: true, key: true } },
      },
    });
    return events;
  }),
});
