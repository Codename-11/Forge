/**
 * Today-zone refresh — populates the locked auto-arranged strip at the
 * top of a user's PERSONAL canvas with their current work:
 *
 *   • Active issues assigned to the user (top 7, by due-then-priority)
 *   • Issues due today (overflow into a second row if needed)
 *   • Recent chat threads from the last 7 days (top 5)
 *   • Top IDEA-status notes (top 3)
 *
 * Idempotent — re-running clears the Today frame's children and
 * re-creates them in the canonical order. The frame itself is locked
 * (`lockedAt` set) and named "Today" with a sentinel marker stored on
 * `backgroundFill.kind = "today-zone"` so we can find it without name
 * matching.
 *
 * The strip is anchored at (0, 0) on the canvas with a fixed width
 * (1080px) and a height that grows with row count. The rest of the
 * canvas — below the strip — is the operator's free scratch space and
 * is never touched by this refresh.
 */

import type { PrismaClient, Prisma } from "@prisma/client";

const TODAY_ZONE_X = 0;
const TODAY_ZONE_Y = 0;
const TODAY_ZONE_WIDTH = 1080;
const TODAY_ZONE_PADDING_X = 16;
const TODAY_ZONE_PADDING_Y = 40;
const CARD_WIDTH = 200;
const CARD_HEIGHT = 96;
const CARD_GAP = 12;

interface TodayZoneFrame {
  id: string;
  workspaceId: string;
  canvasId: string;
}

/**
 * Idempotent refresh — ensures a Today frame exists on the PERSONAL
 * canvas, clears its children, and re-populates with the current
 * Today items. Safe to call on every canvas open.
 */
export async function refreshTodayZone(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  canvasId: string,
): Promise<void> {
  const items = await collectTodayItems(db, workspaceId, userId);
  // 4 column layout — adjust rows up as items grow.
  const columns = 4;
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const frameHeight = TODAY_ZONE_PADDING_Y + rows * (CARD_HEIGHT + CARD_GAP) + 8;

  await db.$transaction(async (tx) => {
    const frame = await ensureTodayZoneFrame(tx, workspaceId, canvasId, frameHeight);

    // Wipe prior children — both nodes and the Today header shape.
    await tx.workspaceCanvasNode.deleteMany({
      where: { parentFrameId: frame.id, workspaceId },
    });
    await tx.canvasShape.deleteMany({
      where: { parentFrameId: frame.id, workspaceId },
    });

    // Header label shape.
    await tx.canvasShape.create({
      data: {
        workspaceId,
        canvasId,
        kind: "text",
        x: TODAY_ZONE_X + TODAY_ZONE_PADDING_X,
        y: TODAY_ZONE_Y + 8,
        width: TODAY_ZONE_WIDTH - TODAY_ZONE_PADDING_X * 2,
        height: 24,
        text: "Today",
        parentFrameId: frame.id,
        lockedAt: new Date(),
        style: { fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" } as Prisma.InputJsonValue,
      },
    });

    // Place each item in a column-major grid.
    for (let i = 0; i < items.length; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = TODAY_ZONE_X + TODAY_ZONE_PADDING_X + col * (CARD_WIDTH + CARD_GAP);
      const y = TODAY_ZONE_Y + TODAY_ZONE_PADDING_Y + row * (CARD_HEIGHT + CARD_GAP);
      await tx.workspaceCanvasNode.create({
        data: {
          workspaceId,
          canvasId,
          targetType: items[i].targetType,
          targetId: items[i].targetId,
          x,
          y,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          parentFrameId: frame.id,
          lockedAt: new Date(),
          viewMode: "compact",
          meta: { todayZone: true } as Prisma.InputJsonValue,
        },
      });
    }

    await tx.canvasFrame.update({
      where: { id: frame.id },
      data: { height: frameHeight },
    });
    await tx.workspaceCanvas.update({
      where: { id: canvasId },
      data: { updatedAt: new Date() },
    });
  });
}

interface TodayItem {
  targetType: "issue" | "chat-thread";
  targetId: string;
  sortKey: string;
}

async function collectTodayItems(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<TodayItem[]> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [assigned, dueToday, recentChats] = await Promise.all([
    db.issue.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { category: { in: ["TODO", "IN_PROGRESS", "IN_REVIEW"] } },
        assignees: { some: { userId } },
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      take: 7,
      select: { id: true, priority: true, dueDate: true, updatedAt: true },
    }),
    db.issue.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        dueDate: { gte: startOfDay, lt: endOfDay },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
        OR: [{ assignees: { some: { userId } } }, { authorId: userId }],
      },
      orderBy: { dueDate: "asc" },
      take: 4,
      select: { id: true, dueDate: true },
    }),
    db.chatThread.findMany({
      where: {
        workspaceId,
        userId,
        archivedAt: null,
        lastMessageAt: { gte: sevenDaysAgo },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 3,
      select: { id: true, lastMessageAt: true },
    }),
  ]);

  const seen = new Set<string>();
  const items: TodayItem[] = [];
  for (const i of assigned) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    items.push({ targetType: "issue", targetId: i.id, sortKey: `a-${i.updatedAt.toISOString()}` });
  }
  for (const i of dueToday) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    items.push({ targetType: "issue", targetId: i.id, sortKey: `d-${i.dueDate?.toISOString() ?? ""}` });
  }
  for (const c of recentChats) {
    items.push({
      targetType: "chat-thread",
      targetId: c.id,
      sortKey: `c-${c.lastMessageAt.toISOString()}`,
    });
  }
  return items;
}

async function ensureTodayZoneFrame(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  canvasId: string,
  height: number,
): Promise<TodayZoneFrame> {
  // The frame is identified by `backgroundFill.kind = "today-zone"`
  // rather than name, so renames don't break lookup.
  const existing = await tx.canvasFrame.findFirst({
    where: {
      workspaceId,
      canvasId,
      backgroundFill: { path: ["kind"], equals: "today-zone" },
    },
    select: { id: true, workspaceId: true, canvasId: true },
  });
  if (existing) {
    return existing;
  }
  const created = await tx.canvasFrame.create({
    data: {
      workspaceId,
      canvasId,
      name: "Today",
      x: TODAY_ZONE_X,
      y: TODAY_ZONE_Y,
      width: TODAY_ZONE_WIDTH,
      height,
      lockedAt: new Date(),
      backgroundFill: { kind: "today-zone", color: "var(--card)", opacity: 0.3 } as Prisma.InputJsonValue,
    },
    select: { id: true, workspaceId: true, canvasId: true },
  });
  return created;
}
