import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { issueWhereForViewer } from "@/server/services/project-access";
import { sendBrowserPushToUser } from "@/server/services/web-push";

type DbClient = PrismaClient | Prisma.TransactionClient;

/** Re-check membership and project access on every read and delivery. */
export async function visibleReminderWhere(
  db: DbClient,
  userId: string,
  workspaceId?: string,
): Promise<Prisma.IssueReminderWhereInput> {
  const memberships = await db.membership.findMany({
    where: {
      userId,
      ...(workspaceId ? { workspaceId } : {}),
      user: { disabledAt: null, deletedAt: null, status: "ACTIVE" },
    },
    select: { id: true, role: true, workspaceId: true },
  });
  return {
    userId,
    user: { disabledAt: null, deletedAt: null, status: "ACTIVE" },
    dismissedAt: null,
    OR: memberships.map((membership) => ({
      workspaceId: membership.workspaceId,
      user: { memberships: { some: { id: membership.id, role: membership.role } } },
      issue: {
        AND: [issueWhereForViewer({ workspaceId: membership.workspaceId, membership })],
        deletedAt: null,
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
    })),
  };
}

export async function countDueReminders(
  db: DbClient,
  userId: string,
  workspaceId?: string,
  now = new Date(),
) {
  return db.issueReminder.count({
    where: {
      ...(await visibleReminderWhere(db, userId, workspaceId)),
      remindAt: { lte: now },
      readAt: null,
    },
  });
}

export async function markDueRemindersRead(
  db: DbClient,
  userId: string,
  workspaceId?: string,
  now = new Date(),
) {
  return db.issueReminder.updateMany({
    where: {
      ...(await visibleReminderWhere(db, userId, workspaceId)),
      remindAt: { lte: now },
      readAt: null,
    },
    data: { readAt: now },
  });
}

/** In-app reminders are durable and time-driven even when this worker is down.
 * This sweep only handles optional browser push, with one atomic claim per schedule.
 */
export async function sweepIssueReminders(db: PrismaClient, now = new Date()) {
  await db.issueReminder.updateMany({
    where: {
      dismissedAt: null,
      issue: {
        OR: [{ deletedAt: { not: null } }, { status: { category: { in: ["DONE", "CANCELED"] } } }],
      },
    },
    data: { dismissedAt: now },
  });
  const due = await db.issueReminder.findMany({
    where: {
      browserPush: true,
      notifiedAt: null,
      readAt: null,
      dismissedAt: null,
      remindAt: { lte: now },
    },
    orderBy: [{ remindAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  let claimed = 0;
  let sent = 0;
  for (const reminder of due) {
    const accessWhere = await visibleReminderWhere(db, reminder.userId, reminder.workspaceId);
    const visible = await db.issueReminder.findFirst({
      where: {
        ...accessWhere,
        id: reminder.id,
      },
      include: {
        issue: { select: { title: true, number: true } },
        workspace: { select: { slug: true, key: true } },
      },
    });
    if (!visible) {
      await db.issueReminder.updateMany({
        where: { id: reminder.id, updatedAt: reminder.updatedAt },
        data: { dismissedAt: now },
      });
      continue;
    }
    const claim = await db.issueReminder.updateMany({
      where: {
        ...accessWhere,
        id: reminder.id,
        updatedAt: reminder.updatedAt,
        notifiedAt: null,
        readAt: null,
        dismissedAt: null,
      },
      data: { notifiedAt: now },
    });
    if (!claim.count) continue;
    claimed += 1;
    const result = await sendBrowserPushToUser(db, reminder.userId, {
      title: `Reminder: ${visible.workspace.key}-${visible.issue.number}`,
      body: visible.issue.title,
      url: `/w/${visible.workspace.slug}/issues/${reminder.issueId}`,
      tag: `forge-reminder-${reminder.id}`,
    });
    sent += result.sent;
  }
  return { claimed, sent };
}
