import "server-only";
import { EventKind, type PrismaClient } from "@prisma/client";
import type { RealtimeEvent } from "@/server/realtime";
import { filterProjectDerivedRecords } from "@/server/services/derived-project-access";
import type { Membership } from "@prisma/client";

export const REALTIME_CATCHUP_LIMIT = 500;

type CursorSource = "activity" | "run";

export interface RealtimeCursor {
  at: string;
  source: CursorSource;
  id: string;
}

export interface RealtimeReplayEvent extends RealtimeEvent {
  cursor: string;
}

function sourceRank(source: CursorSource): number {
  return source === "activity" ? 0 : 1;
}

export function compareRealtimeCursors(a: RealtimeCursor, b: RealtimeCursor): number {
  const time = Date.parse(a.at) - Date.parse(b.at);
  if (time !== 0) return time;
  const source = sourceRank(a.source) - sourceRank(b.source);
  if (source !== 0) return source;
  return a.id.localeCompare(b.id);
}

export function encodeRealtimeCursor(cursor: RealtimeCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeRealtimeCursor(raw: string | null | undefined): RealtimeCursor | null {
  if (!raw || raw.length > 512) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<RealtimeCursor>;
    if (
      typeof parsed.at !== "string" ||
      Number.isNaN(Date.parse(parsed.at)) ||
      (parsed.source !== "activity" && parsed.source !== "run") ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      parsed.id.length > 128
    ) {
      return null;
    }
    return { at: new Date(parsed.at).toISOString(), source: parsed.source, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Read the durable events missed after a browser cursor. Activity events and
 * granular run events live in separate append-only tables, so this establishes
 * a stable cross-table order of `(createdAt, source, id)` and maps both back to
 * the existing realtime wire shape.
 */
export async function loadRealtimeCatchup(
  db: PrismaClient,
  workspaceId: string,
  cursor: RealtimeCursor,
  limit = REALTIME_CATCHUP_LIMIT,
  membership?: Pick<Membership, "id" | "role">,
): Promise<{ events: RealtimeReplayEvent[]; truncated: boolean }> {
  const at = new Date(cursor.at);
  const [activityRows, runRows] = await Promise.all([
    db.activityEvent.findMany({
      where: {
        workspaceId,
        // Deliberately overlap the cursor millisecond. PostgreSQL timestamps
        // are exposed through JS at millisecond precision and two concurrent
        // rows can publish in a different order than their lexical ids. A
        // small duplicate replay is safer than skipping the late row.
        createdAt: { gte: at },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    }),
    db.agentRunEvent.findMany({
      where: {
        workspaceId,
        createdAt: { gte: at },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      include: {
        run: { select: { issueId: true, agentId: true, currentStep: true } },
      },
    }),
  ]);

  const merged = [
    ...activityRows.map((row) => ({ source: "activity" as const, row })),
    ...runRows.map((row) => ({ source: "run" as const, row })),
  ].sort((a, b) => {
    const time = a.row.createdAt.getTime() - b.row.createdAt.getTime();
    if (time !== 0) return time;
    const source = sourceRank(a.source) - sourceRank(b.source);
    if (source !== 0) return source;
    return a.row.id.localeCompare(b.row.id);
  });

  const candidateEvents = merged.map(({ source, row }) => {
    const cursorValue = encodeRealtimeCursor({
      at: row.createdAt.toISOString(),
      source,
      id: row.id,
    });
    if (source === "activity") {
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        kind: row.kind,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        payload: row.payload,
        actorId: row.actorId,
        createdAt: row.createdAt.toISOString(),
        cursor: cursorValue,
      } satisfies RealtimeReplayEvent;
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: EventKind.AGENT_RUN_STEP,
      subjectType: "agent-run",
      subjectId: row.runId,
      payload: {
        eventKind: row.kind,
        currentStep: row.run.currentStep,
        runId: row.runId,
        issueId: row.run.issueId,
        agentId: row.run.agentId,
        replayed: true,
      },
      actorId: null,
      createdAt: row.createdAt.toISOString(),
      cursor: cursorValue,
    } satisfies RealtimeReplayEvent;
  });

  const visibleEvents = membership
    ? await filterProjectDerivedRecords(db, { workspaceId, membership }, candidateEvents)
    : candidateEvents;
  const truncated = merged.length > limit || visibleEvents.length > limit;
  return { events: visibleEvents.slice(0, limit), truncated };
}

export function cursorForRealtimeEvent(evt: RealtimeEvent): string {
  return encodeRealtimeCursor({
    at: new Date(evt.createdAt).toISOString(),
    source:
      evt.subjectType === "agent-run" && evt.kind === EventKind.AGENT_RUN_STEP ? "run" : "activity",
    id: evt.id,
  });
}
