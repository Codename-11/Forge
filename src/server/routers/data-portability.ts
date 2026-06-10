import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AgentProvider,
  AgentRole,
  InitiativeStatus,
  CycleStatus,
  DefaultIssueAssigneeMode,
  Priority,
  RelationKind,
  StatusCategory,
  WorkItemKind,
} from "@prisma/client";
import { router, adminProcedure } from "@/server/trpc";

/**
 * Workspace data portability — export the current workspace's core
 * content as a portable JSON snapshot and import a snapshot back into a
 * workspace. Intended for local dev iteration (clone a real workspace
 * into `dev:local`) and lightweight workspace-to-workspace transfer.
 *
 * Scope: settings + statuses + labels + initiatives + projects + cycles
 * + agents + issues (with assignees/labels/relations) + comments. It does
 * NOT carry infra/ephemeral rows (api keys, webhooks, audit log, activity
 * events, runs, attachments' bytes, sessions). For a full-fidelity replica
 * of production use `pnpm db:clone-prod` (Postgres-level dump) instead.
 *
 * Import is ADDITIVE and keyed off natural identifiers:
 *   - statuses/labels/cycles by name, projects by key, initiatives by
 *     slug, agents by profileKey → upserted (existing rows reused).
 *   - issues are always created fresh with appended numbers; their
 *     relations and comments are remapped onto the new issue ids.
 *   - users are matched by email; unknown authors/assignees fall back to
 *     the importing admin so nothing dangles.
 * It never deletes existing rows.
 */

const EXPORT_VERSION = 1 as const;

// ---- Snapshot schema (also the import input contract) --------------------

const statusSnap = z.object({
  name: z.string(),
  category: z.nativeEnum(StatusCategory),
  color: z.string(),
  position: z.number().int(),
  isDefault: z.boolean(),
});
const labelSnap = z.object({ name: z.string(), color: z.string() });
const initiativeSnap = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.nativeEnum(InitiativeStatus),
  color: z.string().nullable(),
  position: z.number().int(),
  targetDate: z.string().datetime().nullable(),
});
const projectSnap = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  archived: z.boolean(),
  startDate: z.string().datetime().nullable(),
  targetDate: z.string().datetime().nullable(),
  initiativeSlug: z.string().nullable(),
});
const cycleSnap = z.object({
  name: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  lengthDays: z.number().int(),
  cooldownDays: z.number().int(),
  status: z.nativeEnum(CycleStatus),
});
const agentSnap = z.object({
  profileKey: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  avatar: z.string().nullable(),
  provider: z.nativeEnum(AgentProvider),
  role: z.nativeEnum(AgentRole),
  capabilities: z.array(z.string()),
  maxConcurrent: z.number().int(),
});
const issueSnap = z.object({
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  projectKey: z.string().nullable(),
  statusName: z.string(),
  priority: z.nativeEnum(Priority),
  kind: z.nativeEnum(WorkItemKind),
  authorEmail: z.string().nullable(),
  assigneeEmails: z.array(z.string()),
  labelNames: z.array(z.string()),
  cycleName: z.string().nullable(),
  assignedAgentKey: z.string().nullable(),
  queued: z.boolean(),
  dueDate: z.string().datetime().nullable(),
  estimate: z.number().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  canceledAt: z.string().datetime().nullable(),
});
const relationSnap = z.object({
  fromNumber: z.number().int(),
  toNumber: z.number().int(),
  kind: z.nativeEnum(RelationKind),
});
const commentSnap = z.object({
  issueNumber: z.number().int(),
  authorEmail: z.string().nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
});

const snapshotSchema = z.object({
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().datetime(),
  workspace: z.object({
    slug: z.string(),
    name: z.string(),
    key: z.string(),
    cycleLengthDays: z.number().int(),
    cycleCooldownDays: z.number().int(),
    timeTrackingEnabled: z.boolean(),
    attachmentQuotaMb: z.number().int(),
    defaultIssueAssigneeMode: z.nativeEnum(DefaultIssueAssigneeMode).optional(),
    defaultIssueAssigneeUserEmail: z.string().email().nullable().optional(),
  }),
  statuses: z.array(statusSnap),
  labels: z.array(labelSnap),
  initiatives: z.array(initiativeSnap),
  projects: z.array(projectSnap),
  cycles: z.array(cycleSnap),
  agents: z.array(agentSnap),
  issues: z.array(issueSnap),
  relations: z.array(relationSnap),
  comments: z.array(commentSnap),
});

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const dataPortabilityRouter = router({
  /**
   * Serialise the current workspace's core content to a JSON snapshot.
   * The client turns this into a downloadable `.json` file.
   */
  export: adminProcedure.query(async ({ ctx }) => {
    const wid = ctx.workspaceId;
    const [workspace, statuses, labels, initiatives, projects, cycles, agents, issues] =
      await Promise.all([
        ctx.db.workspace.findUniqueOrThrow({
          where: { id: wid },
          include: {
            defaultIssueAssigneeUser: { select: { email: true } },
          },
        }),
        ctx.db.status.findMany({ where: { workspaceId: wid }, orderBy: { position: "asc" } }),
        ctx.db.label.findMany({ where: { workspaceId: wid } }),
        ctx.db.initiative.findMany({ where: { workspaceId: wid } }),
        ctx.db.project.findMany({ where: { workspaceId: wid } }),
        ctx.db.cycle.findMany({ where: { workspaceId: wid } }),
        ctx.db.agent.findMany({ where: { workspaceId: wid, archivedAt: null } }),
        ctx.db.issue.findMany({
          where: { workspaceId: wid, deletedAt: null },
          include: {
            assignees: { include: { user: { select: { email: true } } } },
            labels: { include: { label: { select: { name: true } } } },
            project: { select: { key: true } },
            status: { select: { name: true } },
            cycle: { select: { name: true } },
            author: { select: { email: true } },
            assignedAgent: { select: { profileKey: true } },
          },
        }),
      ]);

    const initiativeSlugById = new Map(initiatives.map((i) => [i.id, i.slug]));
    const issueNumberById = new Map(issues.map((i) => [i.id, i.number]));

    const [relations, comments] = await Promise.all([
      ctx.db.issueRelation.findMany({ where: { workspaceId: wid } }),
      ctx.db.comment.findMany({
        where: { workspaceId: wid, deletedAt: null, issueId: { not: null }, kind: "BODY" },
        include: { author: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      workspace: {
        slug: workspace.slug,
        name: workspace.name,
        key: workspace.key,
        cycleLengthDays: workspace.cycleLengthDays,
        cycleCooldownDays: workspace.cycleCooldownDays,
        timeTrackingEnabled: workspace.timeTrackingEnabled,
        attachmentQuotaMb: workspace.attachmentQuotaMb,
        defaultIssueAssigneeMode: workspace.defaultIssueAssigneeMode,
        defaultIssueAssigneeUserEmail:
          workspace.defaultIssueAssigneeUser?.email ?? null,
      },
      statuses: statuses.map((s) => ({
        name: s.name,
        category: s.category,
        color: s.color,
        position: s.position,
        isDefault: s.isDefault,
      })),
      labels: labels.map((l) => ({ name: l.name, color: l.color })),
      initiatives: initiatives.map((i) => ({
        slug: i.slug,
        name: i.name,
        description: i.description,
        status: i.status,
        color: i.color,
        position: i.position,
        targetDate: iso(i.targetDate),
      })),
      projects: projects.map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        color: p.color,
        icon: p.icon,
        archived: p.archived,
        startDate: iso(p.startDate),
        targetDate: iso(p.targetDate),
        initiativeSlug: p.initiativeId ? initiativeSlugById.get(p.initiativeId) ?? null : null,
      })),
      cycles: cycles.map((c) => ({
        name: c.name,
        startsAt: c.startsAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        lengthDays: c.lengthDays,
        cooldownDays: c.cooldownDays,
        status: c.status,
      })),
      agents: agents.map((a) => ({
        profileKey: a.profileKey,
        name: a.name,
        description: a.description,
        avatar: a.avatar,
        provider: a.provider,
        role: a.role,
        capabilities: a.capabilities,
        maxConcurrent: a.maxConcurrent,
      })),
      issues: issues.map((i) => ({
        number: i.number,
        title: i.title,
        description: i.description,
        projectKey: i.project?.key ?? null,
        statusName: i.status.name,
        priority: i.priority,
        kind: i.kind,
        authorEmail: i.author?.email ?? null,
        assigneeEmails: i.assignees.map((a) => a.user.email).filter((e): e is string => !!e),
        labelNames: i.labels.map((l) => l.label.name),
        cycleName: i.cycle?.name ?? null,
        assignedAgentKey: i.assignedAgent?.profileKey ?? null,
        queued: i.queued,
        dueDate: iso(i.dueDate),
        estimate: i.estimate,
        startedAt: iso(i.startedAt),
        completedAt: iso(i.completedAt),
        canceledAt: iso(i.canceledAt),
      })),
      relations: relations
        .map((r) => ({
          fromNumber: issueNumberById.get(r.fromIssueId),
          toNumber: issueNumberById.get(r.toIssueId),
          kind: r.kind,
        }))
        .filter((r): r is { fromNumber: number; toNumber: number; kind: RelationKind } =>
          r.fromNumber != null && r.toNumber != null,
        ),
      comments: comments.map((c) => ({
        issueNumber: issueNumberById.get(c.issueId!) ?? -1,
        authorEmail: c.author?.email ?? null,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })).filter((c) => c.issueNumber !== -1),
    } satisfies z.infer<typeof snapshotSchema>;
  }),

  /**
   * Import a snapshot into the current workspace. Additive: upserts
   * config rows by natural key, creates issues fresh with appended
   * numbers, then remaps relations + comments onto the new ids. Returns
   * a count summary.
   */
  import: adminProcedure
    .input(z.object({ snapshot: snapshotSchema }))
    .mutation(async ({ ctx, input }) => {
      const wid = ctx.workspaceId;
      const snap = input.snapshot;
      const fallbackUserId = ctx.session.user.id;

      // Resolve referenced users by email up front (existing members /
      // users only — we do not create accounts on import).
      const emails = new Set<string>();
      snap.issues.forEach((i) => {
        if (i.authorEmail) emails.add(i.authorEmail);
        i.assigneeEmails.forEach((e) => emails.add(e));
      });
      if (snap.workspace.defaultIssueAssigneeUserEmail) {
        emails.add(snap.workspace.defaultIssueAssigneeUserEmail);
      }
      snap.comments.forEach((c) => c.authorEmail && emails.add(c.authorEmail));
      const users = await ctx.db.user.findMany({
        where: { email: { in: [...emails] } },
        select: { id: true, email: true },
      });
      const userIdByEmail = new Map(users.map((u) => [u.email!, u.id]));
      const resolveUser = (email: string | null) =>
        (email && userIdByEmail.get(email)) || fallbackUserId;

      const summary = {
        statuses: 0,
        labels: 0,
        initiatives: 0,
        projects: 0,
        cycles: 0,
        agents: 0,
        issues: 0,
        relations: 0,
        comments: 0,
      };

      await ctx.db.$transaction(
        async (tx) => {
          if (snap.workspace.defaultIssueAssigneeMode) {
            let defaultIssueAssigneeUserId: string | null = null;
            const email = snap.workspace.defaultIssueAssigneeUserEmail;
            if (
              snap.workspace.defaultIssueAssigneeMode ===
                DefaultIssueAssigneeMode.USER &&
              email
            ) {
              const candidateId = userIdByEmail.get(email) ?? null;
              const membership = candidateId
                ? await tx.membership.findUnique({
                    where: {
                      userId_workspaceId: {
                        userId: candidateId,
                        workspaceId: wid,
                      },
                    },
                    select: { id: true },
                  })
                : null;
              defaultIssueAssigneeUserId = membership ? candidateId : null;
            }

            await tx.workspace.update({
              where: { id: wid },
              data: {
                defaultIssueAssigneeMode:
                  snap.workspace.defaultIssueAssigneeMode ===
                    DefaultIssueAssigneeMode.USER &&
                  !defaultIssueAssigneeUserId
                    ? DefaultIssueAssigneeMode.NONE
                    : snap.workspace.defaultIssueAssigneeMode,
                defaultIssueAssigneeUserId,
              },
            });
          }

          // Statuses (by name)
          for (const s of snap.statuses) {
            await tx.status.upsert({
              where: { workspaceId_name: { workspaceId: wid, name: s.name } },
              update: {},
              create: { ...s, workspaceId: wid },
            });
            summary.statuses++;
          }
          const statuses = await tx.status.findMany({ where: { workspaceId: wid } });
          const statusIdByName = new Map(statuses.map((s) => [s.name, s.id]));
          const defaultStatusId =
            statuses.find((s) => s.isDefault)?.id ?? statuses[0]?.id;
          if (!defaultStatusId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Snapshot has no statuses; cannot place issues.",
            });
          }

          // Labels (by name)
          for (const l of snap.labels) {
            await tx.label.upsert({
              where: { workspaceId_name: { workspaceId: wid, name: l.name } },
              update: {},
              create: { ...l, workspaceId: wid },
            });
            summary.labels++;
          }
          const labels = await tx.label.findMany({ where: { workspaceId: wid } });
          const labelIdByName = new Map(labels.map((l) => [l.name, l.id]));

          // Initiatives (by slug)
          for (const i of snap.initiatives) {
            await tx.initiative.upsert({
              where: { workspaceId_slug: { workspaceId: wid, slug: i.slug } },
              update: {},
              create: {
                workspaceId: wid,
                slug: i.slug,
                name: i.name,
                description: i.description,
                status: i.status,
                color: i.color,
                position: i.position,
                targetDate: i.targetDate ? new Date(i.targetDate) : null,
                createdById: fallbackUserId,
              },
            });
            summary.initiatives++;
          }
          const initiatives = await tx.initiative.findMany({ where: { workspaceId: wid } });
          const initiativeIdBySlug = new Map(initiatives.map((i) => [i.slug, i.id]));

          // Projects (by key)
          for (const p of snap.projects) {
            await tx.project.upsert({
              where: { workspaceId_key: { workspaceId: wid, key: p.key } },
              update: {},
              create: {
                workspaceId: wid,
                key: p.key,
                name: p.name,
                description: p.description,
                color: p.color,
                icon: p.icon,
                archived: p.archived,
                startDate: p.startDate ? new Date(p.startDate) : null,
                targetDate: p.targetDate ? new Date(p.targetDate) : null,
                initiativeId: p.initiativeSlug
                  ? initiativeIdBySlug.get(p.initiativeSlug) ?? null
                  : null,
                createdById: fallbackUserId,
              },
            });
            summary.projects++;
          }
          const projects = await tx.project.findMany({ where: { workspaceId: wid } });
          const projectIdByKey = new Map(projects.map((p) => [p.key, p.id]));

          // Cycles (by name)
          for (const c of snap.cycles) {
            await tx.cycle.upsert({
              where: { workspaceId_name: { workspaceId: wid, name: c.name } },
              update: {},
              create: {
                workspaceId: wid,
                name: c.name,
                startsAt: new Date(c.startsAt),
                endsAt: new Date(c.endsAt),
                lengthDays: c.lengthDays,
                cooldownDays: c.cooldownDays,
                status: c.status,
              },
            });
            summary.cycles++;
          }
          const cycles = await tx.cycle.findMany({ where: { workspaceId: wid } });
          const cycleIdByName = new Map(cycles.map((c) => [c.name, c.id]));

          // Agents (by profileKey)
          for (const a of snap.agents) {
            await tx.agent.upsert({
              where: { workspaceId_profileKey: { workspaceId: wid, profileKey: a.profileKey } },
              update: {},
              create: {
                workspaceId: wid,
                profileKey: a.profileKey,
                name: a.name,
                description: a.description,
                avatar: a.avatar,
                provider: a.provider,
                role: a.role,
                capabilities: a.capabilities,
                maxConcurrent: a.maxConcurrent,
              },
            });
            summary.agents++;
          }
          const agents = await tx.agent.findMany({ where: { workspaceId: wid } });
          const agentIdByKey = new Map(agents.map((a) => [a.profileKey, a.id]));

          // Issues — always created fresh with appended numbers.
          const maxIssue = await tx.issue.aggregate({
            where: { workspaceId: wid },
            _max: { number: true },
          });
          let n = maxIssue._max.number ?? 0;
          // Map the snapshot's issue number → the new issue id, so
          // relations and comments can be rewired.
          const newIssueIdBySnapNumber = new Map<number, string>();

          for (const i of snap.issues) {
            n += 1;
            const created = await tx.issue.create({
              data: {
                workspaceId: wid,
                number: n,
                title: i.title,
                description: i.description,
                kind: i.kind,
                priority: i.priority,
                queued: i.queued,
                statusId: statusIdByName.get(i.statusName) ?? defaultStatusId,
                projectId: i.projectKey ? projectIdByKey.get(i.projectKey) ?? null : null,
                cycleId: i.cycleName ? cycleIdByName.get(i.cycleName) ?? null : null,
                assignedAgentId: i.assignedAgentKey
                  ? agentIdByKey.get(i.assignedAgentKey) ?? null
                  : null,
                authorId: resolveUser(i.authorEmail),
                dueDate: i.dueDate ? new Date(i.dueDate) : null,
                estimate: i.estimate,
                startedAt: i.startedAt ? new Date(i.startedAt) : null,
                completedAt: i.completedAt ? new Date(i.completedAt) : null,
                canceledAt: i.canceledAt ? new Date(i.canceledAt) : null,
                assignees: {
                  create: [...new Set(i.assigneeEmails)]
                    .map((e) => userIdByEmail.get(e))
                    .filter((id): id is string => !!id)
                    .map((userId) => ({ userId })),
                },
                labels: {
                  create: i.labelNames
                    .map((name) => labelIdByName.get(name))
                    .filter((id): id is string => !!id)
                    .map((labelId) => ({ labelId })),
                },
              },
            });
            newIssueIdBySnapNumber.set(i.number, created.id);
            summary.issues++;
          }

          // Relations
          for (const r of snap.relations) {
            const fromId = newIssueIdBySnapNumber.get(r.fromNumber);
            const toId = newIssueIdBySnapNumber.get(r.toNumber);
            if (!fromId || !toId) continue;
            await tx.issueRelation.create({
              data: { workspaceId: wid, fromIssueId: fromId, toIssueId: toId, kind: r.kind },
            });
            summary.relations++;
          }

          // Comments
          for (const c of snap.comments) {
            const issueId = newIssueIdBySnapNumber.get(c.issueNumber);
            if (!issueId) continue;
            await tx.comment.create({
              data: {
                workspaceId: wid,
                issueId,
                authorId: resolveUser(c.authorEmail),
                body: c.body,
                createdAt: new Date(c.createdAt),
              },
            });
            summary.comments++;
          }
        },
        { timeout: 120_000 },
      );

      return summary;
    }),
});
