import { NextResponse, type NextRequest } from "next/server";
import { subscribe } from "@/server/realtime";
import { authenticateApiKey, ApiKeyError } from "@/server/services/api-key-auth";

/**
 * Server-Sent Events stream for plugin/agent subscribers.
 * `Authorization: Bearer <key>` with SUBSCRIBE_EVENTS scope.
 * Streams `RealtimeEvent`s scoped to the key's workspace.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: "Missing bearer token." }, { status: 401 });

  let principal;
  try {
    principal = await authenticateApiKey(token, ["SUBSCRIBE_EVENTS"]);
  } catch (err) {
    if (err instanceof ApiKeyError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      send({ type: "ready", workspaceId: principal.workspaceId });
      unsubscribe = subscribe(principal.workspaceId, (evt) => send(evt));
      // Heartbeat to keep connection alive through proxies.
      const hb = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 15_000);
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
      connection: "keep-alive",
    },
  });
}
