import "server-only";
import { db } from "@/server/db";
import { issueWhereForViewer } from "@/server/services/project-access";

/**
 * Standup composer — pure function over the DB. Extracted from the
 * tRPC router so the MCP tool surface (`standup.draft`) and any future
 * scheduled job (e.g. Slack cron, Hermes daily digest) share one
 * implementation. The output is mrkdwn-flavored markdown so it pastes
 * cleanly into Slack / Discord.
 */

export interface StandupInput {
  workspaceId: string;
  userId: string;
  sinceHours: number;
}

export interface StandupOutput {
  markdown: string;
  sinceHours: number;
  workspaceKey: string;
  counts: {
    closed: number;
    opened: number;
    moved: number;
    inProgress: number;
    blocked: number;
  };
  groups: {
    closed: Array<{ id: string; number: number; title: string; key: string }>;
    opened: Array<{ id: string; number: number; title: string; key: string }>;
    inProgress: Array<{
      id: string;
      number: number;
      title: string;
      key: string;
    }>;
    blocked: Array<{
      id: string;
      number: number;
      title: string;
      key: string;
    }>;
  };
}

export async function composeStandup(input: StandupInput): Promise<StandupOutput> {
  const since = new Date(Date.now() - input.sinceHours * 3600_000);
  const stalledCutoff = new Date(Date.now() - 3 * 86_400_000);
  const membership = await db.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
    select: { id: true, role: true },
  });
  const accessWhere = issueWhereForViewer({ workspaceId: input.workspaceId, membership });

  const [workspace, closed, moved, newlyOpened, inProgress, blocked] = await Promise.all([
    db.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      select: { key: true },
    }),
    db.issue.findMany({
      where: {
        workspaceId: input.workspaceId,
        deletedAt: null,
        completedAt: { gte: since },
        OR: [{ authorId: input.userId }, { assignees: { some: { userId: input.userId } } }],
        AND: [accessWhere],
      },
      select: { id: true, number: true, title: true },
      take: 20,
    }),
    db.auditLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        entity: "Issue",
        action: "update",
        createdAt: { gte: since },
        entityId: {
          in: await db.issue
            .findMany({
              where: { AND: [accessWhere] },
              select: { id: true },
            })
            .then((rows) => rows.map((row) => row.id)),
        },
      },
      select: { entityId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.issue.findMany({
      where: {
        workspaceId: input.workspaceId,
        deletedAt: null,
        authorId: input.userId,
        createdAt: { gte: since },
        AND: [accessWhere],
      },
      select: { id: true, number: true, title: true },
      take: 20,
    }),
    db.issue.findMany({
      where: {
        workspaceId: input.workspaceId,
        deletedAt: null,
        status: { category: "IN_PROGRESS" },
        assignees: { some: { userId: input.userId } },
        AND: [accessWhere],
      },
      select: { id: true, number: true, title: true },
      take: 20,
    }),
    db.issue.findMany({
      where: {
        workspaceId: input.workspaceId,
        deletedAt: null,
        assignees: { some: { userId: input.userId } },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
        updatedAt: { lt: stalledCutoff },
        AND: [accessWhere],
      },
      select: { id: true, number: true, title: true },
      take: 10,
    }),
  ]);

  const wsKey = workspace.key;
  const tag = (n: number) => `${wsKey}-${n}`;
  const enrich = (rows: Array<{ id: string; number: number; title: string }>) =>
    rows.map((r) => ({ ...r, key: tag(r.number) }));

  const groups = {
    closed: enrich(closed),
    opened: enrich(newlyOpened),
    inProgress: enrich(inProgress),
    blocked: enrich(blocked),
  };

  const window =
    input.sinceHours === 24
      ? "last 24h"
      : input.sinceHours === 72
        ? "last 3 days"
        : input.sinceHours === 168
          ? "last week"
          : `last ${input.sinceHours}h`;

  // Markdown sections — group-by-action reads more naturally than
  // y/t/b. Counts live in headings so a quick scan is enough; the
  // bullet list is the detail. Empty groups are dropped so the
  // doc shrinks to fit the actual activity.
  const sections: string[] = [`*Standup — ${window}*`];

  if (groups.closed.length) {
    sections.push("");
    sections.push(`*Closed (${groups.closed.length})*`);
    for (const i of groups.closed) sections.push(`• ${i.key} — ${i.title}`);
  }

  if (groups.opened.length) {
    sections.push("");
    sections.push(`*Opened (${groups.opened.length})*`);
    for (const i of groups.opened) sections.push(`• ${i.key} — ${i.title}`);
  }

  if (groups.inProgress.length) {
    sections.push("");
    sections.push(`*Continuing (${groups.inProgress.length})*`);
    for (const i of groups.inProgress) sections.push(`• ${i.key} — ${i.title}`);
  }

  if (groups.blocked.length) {
    sections.push("");
    sections.push(`*Blocked / stalled (${groups.blocked.length})*`);
    for (const i of groups.blocked) sections.push(`• ${i.key} — ${i.title} _(no movement in 3d+)_`);
  }

  if (sections.length === 1) {
    sections.push("");
    sections.push("_No tracked activity in this window._");
  }

  return {
    markdown: sections.join("\n"),
    sinceHours: input.sinceHours,
    workspaceKey: wsKey,
    counts: {
      closed: closed.length,
      opened: newlyOpened.length,
      moved: moved.length,
      inProgress: inProgress.length,
      blocked: blocked.length,
    },
    groups,
  };
}
