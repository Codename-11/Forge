import { NextResponse, type NextRequest } from "next/server";
import { subscribe } from "@/server/realtime";
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

  const encoder = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (d: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(d)}\n\n`));
      send({ type: "ready" });
      unsubscribe = subscribe(workspaceId, send);
      const hb = setInterval(() => controller.enqueue(encoder.encode(": hb\n\n")), 15_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(hb);
        void unsubscribe?.();
        controller.close();
      });
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
