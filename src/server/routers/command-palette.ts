import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { router, protectedProcedure } from "@/server/trpc";
import { issueSearchWhere, parseIssueSearch } from "@/server/services/issue-search";
import { issueWhereForViewer, projectWhereForViewer } from "@/server/services/project-access";

/**
 * Command palette search — fans out across every entity type the
 * palette can navigate to (issues / projects / initiatives / saved
 * views / cycles / agents) and returns a per-type bucket so the
 * client can render section headers without re-grouping.
 *
 * Matching: issues use the shared direct-identifier/metadata contract;
 * other entities use simple ILIKE on their relevant fields. Each bucket
 * is capped at `limit` (default 6) so the UI doesn't truncate post-hoc.
 *
 * Scoping:
 *   - `workspaceId` provided → only that workspace.
 *   - `workspaceId` omitted  → every workspace the caller is a member of
 *                              (the cross-workspace palette mode the
 *                              brief calls out).
 *
 * Empty-query behavior: returns each bucket empty. The Phase 1C
 * palette is expected to fall through to recent-items + pins for the
 * empty-state suggestions; we don't merge those in here so callers
 * can render them with their own ordering logic.
 */

const cmdInput = z.object({
  query: z.string().max(200).default(""),
  workspaceId: z.string().cuid().optional(),
  limit: z.number().int().positive().max(20).default(6),
});

export const commandPaletteRouter = router({
  search: protectedProcedure.input(cmdInput).query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const empty = {
      issues: [] as Array<{
        id: string;
        key: string;
        title: string;
        statusName: string;
        statusColor: string;
        projectKey: string | null;
        projectId: string | null;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      projects: [] as Array<{
        id: string;
        key: string;
        name: string;
        color: string | null;
        icon: string | null;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      initiatives: [] as Array<{
        id: string;
        slug: string;
        name: string;
        color: string | null;
        status: string;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      savedViews: [] as Array<{
        id: string;
        name: string;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      cycles: [] as Array<{
        id: string;
        name: string;
        status: string;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      agents: [] as Array<{
        id: string;
        profileKey: string;
        displayName: string;
        status: string;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      goals: [] as Array<{
        id: string;
        title: string;
        status: string;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      crews: [] as Array<{
        id: string;
        name: string;
        memberCount: number;
        workspaceId: string;
        workspaceSlug: string;
      }>,
      plans: [] as Array<{
        id: string;
        title: string;
        status: string;
        workspaceId: string;
        workspaceSlug: string;
      }>,
    };

    const q = input.query.trim();
    if (q.length === 0) {
      return empty;
    }

    // Build the workspace gate. When `workspaceId` is provided we
    // gate on the membership for THAT workspace specifically; when
    // omitted we let any workspace the user is a member of through.
    const workspaceGate: Prisma.WorkspaceWhereInput = {
      deletedAt: null,
      memberships: { some: { userId } },
      ...(input.workspaceId ? { id: input.workspaceId } : {}),
    };
    const memberships = await ctx.db.membership.findMany({
      where: {
        userId,
        workspace: { deletedAt: null },
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
      select: { id: true, role: true, workspaceId: true },
    });
    const issueAccess = memberships.map((membership) =>
      issueWhereForViewer({ workspaceId: membership.workspaceId, membership }),
    );
    const projectAccess = memberships.map((membership) =>
      projectWhereForViewer({ workspaceId: membership.workspaceId, membership }),
    );
    if (memberships.length === 0) return empty;

    const parsedIssueSearch = parseIssueSearch(q);

    const [issues, projects, initiatives, savedViews, cycles, agents, goals, crews, plans] =
      await Promise.all([
        // ---- Issues -----------------------------------------------------
        ctx.db.issue.findMany({
          where: {
            deletedAt: null,
            workspace: workspaceGate,
            AND: [{ OR: issueAccess }, issueSearchWhere(q)!],
          },
          take: input.limit,
          orderBy:
            parsedIssueSearch.kind === "identifier"
              ? [{ workspaceId: "asc" }, { number: "asc" }, { id: "asc" }]
              : [{ updatedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            number: true,
            title: true,
            projectId: true,
            workspaceId: true,
            workspace: { select: { slug: true, key: true } },
            project: { select: { key: true } },
            status: { select: { name: true, color: true } },
          },
        }),
        // ---- Projects ---------------------------------------------------
        ctx.db.project.findMany({
          where: {
            AND: [
              { OR: projectAccess },
              {
                deletedAt: null,
                archived: false,
                workspace: workspaceGate,
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { key: { contains: q, mode: "insensitive" } },
                ],
              },
            ],
          },
          take: input.limit,
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            key: true,
            name: true,
            color: true,
            icon: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
          },
        }),
        // ---- Initiatives ------------------------------------------------
        ctx.db.initiative.findMany({
          where: {
            workspace: workspaceGate,
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { slug: { contains: q, mode: "insensitive" } },
            ],
          },
          take: input.limit,
          orderBy: [{ position: "asc" }, { updatedAt: "desc" }],
          select: {
            id: true,
            slug: true,
            name: true,
            color: true,
            status: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
          },
        }),
        // ---- Saved views -----------------------------------------------
        ctx.db.issueSavedView.findMany({
          where: {
            // Only the caller's own saved views — they're per-user.
            userId,
            workspace: workspaceGate,
            name: { contains: q, mode: "insensitive" },
          },
          take: input.limit,
          orderBy: { orderIndex: "asc" },
          select: {
            id: true,
            name: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
          },
        }),
        // ---- Cycles -----------------------------------------------------
        ctx.db.cycle.findMany({
          where: {
            workspace: workspaceGate,
            name: { contains: q, mode: "insensitive" },
          },
          take: input.limit,
          orderBy: { startsAt: "desc" },
          select: {
            id: true,
            name: true,
            status: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
          },
        }),
        // ---- Agents -----------------------------------------------------
        ctx.db.agent.findMany({
          where: {
            archivedAt: null,
            workspace: workspaceGate,
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { profileKey: { contains: q, mode: "insensitive" } },
            ],
          },
          take: input.limit,
          orderBy: { name: "asc" },
          select: {
            id: true,
            profileKey: true,
            name: true,
            status: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
          },
        }),
        // ---- Goals ------------------------------------------------------
        ctx.db.goal.findMany({
          where: {
            archivedAt: null,
            workspace: workspaceGate,
            title: { contains: q, mode: "insensitive" },
            OR: [{ issueId: null }, { issue: { OR: issueAccess } }],
          },
          take: input.limit,
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            title: true,
            status: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
          },
        }),
        // ---- Crews ------------------------------------------------------
        ctx.db.agentCrew.findMany({
          where: {
            archivedAt: null,
            workspace: workspaceGate,
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
            ],
          },
          take: input.limit,
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            name: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
            _count: { select: { members: true } },
          },
        }),
        // ---- Plans ------------------------------------------------------
        ctx.db.executionPlan.findMany({
          where: {
            archivedAt: null,
            workspace: workspaceGate,
            AND: [
              {
                OR: [
                  { projectId: null, issueId: null },
                  { project: { OR: projectAccess } },
                  { issue: { OR: issueAccess } },
                ],
              },
              {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { description: { contains: q, mode: "insensitive" } },
                ],
              },
            ],
          },
          take: input.limit,
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            title: true,
            status: true,
            workspaceId: true,
            workspace: { select: { slug: true } },
          },
        }),
      ]);

    return {
      issues: issues.map((i) => ({
        id: i.id,
        key: `${i.workspace.key}-${i.number}`,
        title: i.title,
        statusName: i.status.name,
        statusColor: i.status.color,
        projectKey: i.project?.key ?? null,
        projectId: i.projectId,
        workspaceId: i.workspaceId,
        workspaceSlug: i.workspace.slug,
      })),
      projects: projects.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        color: p.color,
        icon: p.icon,
        workspaceId: p.workspaceId,
        workspaceSlug: p.workspace.slug,
      })),
      initiatives: initiatives.map((iv) => ({
        id: iv.id,
        slug: iv.slug,
        name: iv.name,
        color: iv.color,
        status: iv.status,
        workspaceId: iv.workspaceId,
        workspaceSlug: iv.workspace.slug,
      })),
      savedViews: savedViews.map((v) => ({
        id: v.id,
        name: v.name,
        workspaceId: v.workspaceId,
        workspaceSlug: v.workspace.slug,
      })),
      cycles: cycles.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        workspaceId: c.workspaceId,
        workspaceSlug: c.workspace.slug,
      })),
      agents: agents.map((a) => ({
        id: a.id,
        profileKey: a.profileKey,
        displayName: a.name,
        status: a.status,
        workspaceId: a.workspaceId,
        workspaceSlug: a.workspace.slug,
      })),
      goals: goals.map((g) => ({
        id: g.id,
        title: g.title,
        status: g.status,
        workspaceId: g.workspaceId,
        workspaceSlug: g.workspace.slug,
      })),
      crews: crews.map((c) => ({
        id: c.id,
        name: c.name,
        memberCount: c._count.members,
        workspaceId: c.workspaceId,
        workspaceSlug: c.workspace.slug,
      })),
      plans: plans.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        workspaceId: p.workspaceId,
        workspaceSlug: p.workspace.slug,
      })),
    };
  }),
});
