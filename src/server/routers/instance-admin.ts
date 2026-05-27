import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { InstanceRole } from "@prisma/client";
import { router, instanceAdminProcedure } from "@/server/trpc";

/**
 * Instance-admin surface for the `/admin` shell: tenants, users +
 * instance-role management, instance-wide runtimes, audit, and system
 * info. Every procedure is gated by `instanceAdminProcedure`
 * (User.instanceRole === INSTANCE_ADMIN, with ADMIN_EMAIL bootstrap
 * fallback). Distinct from the workspace `admin.*` observability router.
 * Part of the multi-workspace restructure.
 */

const HEARTBEAT_ONLINE_MS = 5 * 60 * 1000;

export const instanceAdminRouter = router({
  /** All tenants (non-deleted workspaces) with rollup stats. */
  tenants: instanceAdminProcedure.query(async ({ ctx }) => {
    const workspaces = await ctx.db.workspace.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        key: true,
        avatarUrl: true,
        createdAt: true,
        _count: { select: { memberships: true, issues: true } },
        memberships: { where: { role: "OWNER" }, take: 1, select: { user: { select: { name: true, email: true } } } },
      },
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return Promise.all(
      workspaces.map(async (w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        key: w.key,
        avatarUrl: w.avatarUrl,
        createdAt: w.createdAt,
        members: w._count.memberships,
        issues: w._count.issues,
        owner: w.memberships[0]?.user ?? null,
        runsLast24: await ctx.db.agentRun.count({ where: { workspaceId: w.id, startedAt: { gte: since } } }),
      })),
    );
  }),

  /** All users with instance role + workspace count. */
  users: instanceAdminProcedure.query(async ({ ctx }) => {
    const users = await ctx.db.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        handle: true,
        image: true,
        instanceRole: true,
        createdAt: true,
        _count: { select: { memberships: true } },
      },
    });
    return users.map((u) => ({ ...u, workspaces: u._count.memberships }));
  }),

  /** Promote / demote a user's instance role. Cannot demote the last admin. */
  setInstanceRole: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid(), role: z.nativeEnum(InstanceRole) }))
    .mutation(async ({ ctx, input }) => {
      if (input.role !== "INSTANCE_ADMIN") {
        const admins = await ctx.db.user.count({ where: { instanceRole: "INSTANCE_ADMIN" } });
        const target = await ctx.db.user.findUnique({ where: { id: input.userId }, select: { instanceRole: true } });
        if (target?.instanceRole === "INSTANCE_ADMIN" && admins <= 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Can't demote the last instance admin." });
        }
      }
      return ctx.db.user.update({
        where: { id: input.userId },
        data: { instanceRole: input.role },
        select: { id: true, instanceRole: true },
      });
    }),

  /** Every runtime across the instance (not just the caller's). */
  runtimes: instanceAdminProcedure.query(async ({ ctx }) => {
    const runtimes = await ctx.db.runtime.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        adapterKey: true,
        heartbeatAt: true,
        disabledAt: true,
        instanceShared: true,
        createdAt: true,
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { agents: true } },
      },
    });
    const now = Date.now();
    return runtimes.map((r) => ({
      ...r,
      online: !r.disabledAt && !!r.heartbeatAt && now - r.heartbeatAt.getTime() < HEARTBEAT_ONLINE_MS,
      boundAgents: r._count.agents,
    }));
  }),

  /** Cross-workspace audit feed for the instance audit page. */
  audit: instanceAdminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(60), cursor: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.activityEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        skip: input.cursor ? 1 : 0,
        select: {
          id: true,
          kind: true,
          subjectType: true,
          subjectId: true,
          createdAt: true,
          actor: { select: { id: true, name: true, image: true } },
          workspace: { select: { id: true, slug: true, key: true, name: true } },
        },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      return { items: rows, nextCursor };
    }),

  /** System / build info + instance-wide counts for the admin overview. */
  system: instanceAdminProcedure.query(async ({ ctx }) => {
    const [tenants, users, admins, runtimes, profiles, connections, runs24] = await Promise.all([
      ctx.db.workspace.count({ where: { deletedAt: null } }),
      ctx.db.user.count(),
      ctx.db.user.count({ where: { instanceRole: "INSTANCE_ADMIN" } }),
      ctx.db.runtime.count({ where: { archivedAt: null } }),
      ctx.db.agentProfile.count({ where: { archivedAt: null } }),
      ctx.db.connection.count(),
      ctx.db.agentRun.count({ where: { startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    ]);
    return {
      // Match system.buildInfo: the Dockerfile bakes FORGE_GIT_SHA / FORGE_BUILD_TIME.
      version: process.env.npm_package_version ?? "1.0.0",
      buildSha: process.env.FORGE_GIT_SHA || null,
      buildTime: process.env.FORGE_BUILD_TIME || null,
      counts: { tenants, users, admins, runtimes, profiles, connections, runs24 },
    };
  }),
});
