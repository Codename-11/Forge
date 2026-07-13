import { NextResponse, type NextRequest } from "next/server";
import { subscribeReady, type RealtimeEvent } from "@/server/realtime";
import {
  compareRealtimeCursors,
  cursorForRealtimeEvent,
  decodeRealtimeCursor,
  loadRealtimeCatchup,
} from "@/server/realtime-catchup";
import { auth } from "@/server/auth";
import { db } from "@/server/db";

/**
 * Browser SSE stream for the current workspace. Session-authed.
 *
 * We use SSE instead of WebSockets because Next.js route handlers on the
 * Node runtime support streaming Responses cleanly, and browsers support
 * EventSource natively. For bi-directional cases (typing, cursors), swap
 * to a dedicated Socket.io/Pusher gateway.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = req.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "Missing workspaceId" }, { status: 400 });

  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: session.user.id, workspaceId } },
  });
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // EventSource automatically sends Last-Event-ID on transport reconnects.
  // The query parameter preserves the same cursor across provider remounts /
  // workspace navigation (the client stores it in sessionStorage).
  const rawCursor =
    req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("cursor");
  const cursor = decodeRealtimeCursor(rawCursor);
  const encoder = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown, id?: string) => {
        if (closed) return;
        const frame = `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };
      const liveBuffer: RealtimeEvent[] = [];
      const seen = new Set<string>();
      let highWaterCursor = cursor;
      let replaying = true;

      const sendLiveEvent = (evt: RealtimeEvent) => {
        const rawEventCursor = cursorForRealtimeEvent(evt);
        const eventCursor = decodeRealtimeCursor(rawEventCursor);
        // Redis publish is best-effort and may occur just before its enclosing
        // transaction commits. If replay already observed a later durable row,
        // still deliver this event but omit its SSE id so Last-Event-ID never
        // moves backward.
        const advancesCursor =
          eventCursor &&
          (!highWaterCursor || compareRealtimeCursors(eventCursor, highWaterCursor) > 0);
        if (advancesCursor) highWaterCursor = eventCursor;
        send(evt, advancesCursor ? rawEventCursor : undefined);
      };

      const onAbort = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        void unsubscribe?.();
        try {
          controller.close();
        } catch {
          // The stream may already be closed by the runtime.
        }
      };
      req.signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Subscribe first and buffer while reading durable rows. This closes
        // the replay/live handoff race without changing the Redis bus.
        unsubscribe = await subscribeReady(workspaceId, (evt) => {
          if (replaying) {
            liveBuffer.push(evt);
            return;
          }
          if (seen.has(evt.id)) return;
          seen.add(evt.id);
          sendLiveEvent(evt);
        });
        if (closed) {
          await unsubscribe();
          return;
        }

        let replayed = 0;
        let needsReconcile = Boolean(rawCursor && !cursor);
        if (cursor) {
          try {
            const catchup = await loadRealtimeCatchup(db, workspaceId, cursor);
            for (const evt of catchup.events) {
              seen.add(evt.id);
              const eventCursor = decodeRealtimeCursor(evt.cursor);
              const advancesCursor =
                eventCursor &&
                (!highWaterCursor || compareRealtimeCursors(eventCursor, highWaterCursor) > 0);
              if (advancesCursor) highWaterCursor = eventCursor;
              send(evt, advancesCursor ? evt.cursor : undefined);
            }
            replayed = catchup.events.length;
            needsReconcile ||= catchup.truncated;
          } catch (error) {
            console.error("[realtime] durable catch-up failed", error);
            needsReconcile = true;
          }
        }

        // Flush events that landed after the Redis subscription but before
        // replay completed. Duplicate durable rows are ignored by id.
        replaying = false;
        liveBuffer
          .sort((a, b) =>
            a.createdAt === b.createdAt
              ? a.id.localeCompare(b.id)
              : a.createdAt.localeCompare(b.createdAt),
          )
          .forEach((evt) => {
            if (seen.has(evt.id)) return;
            seen.add(evt.id);
            sendLiveEvent(evt);
          });

        if (needsReconcile) {
          send({ type: "reconcile", reason: cursor ? "catchup-limit" : "invalid-cursor" });
        }
        send({ type: "ready", replayed, reconciled: needsReconcile });
        heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": hb\n\n"));
        }, 15_000);
      } catch (error) {
        if (!closed) controller.error(error);
      }
    },
    async cancel() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      // Traefik terminates HTTP/2 in prod; `Connection` is an HTTP/1
      // hop-by-hop header that H2 forbids — omitted intentionally.
      "x-accel-buffering": "no",
    },
  });
}
