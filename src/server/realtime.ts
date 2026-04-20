import "server-only";
import { redisPub, redisSub } from "@/server/redis";
import type { EventKind } from "@prisma/client";

/**
 * Thin Redis pub/sub wrapper used as the real-time bus.
 *
 * Publishers (API routes / tRPC mutations) call `publish(workspaceId, evt)`.
 * Subscribers live in two places:
 *   1. WebSocket route (`/api/realtime`) that fans out to connected browsers.
 *   2. Plugin webhook worker that enqueues deliveries to subscribed plugins.
 *
 * Channel convention: `forge:ws:<workspaceId>` — one channel per workspace
 * keeps tenant isolation simple and lets us scale out readers horizontally.
 */

export interface RealtimeEvent {
  id: string;
  workspaceId: string;
  kind: EventKind;
  subjectType: string;
  subjectId: string;
  payload: unknown;
  actorId: string | null;
  createdAt: string;
}

function channel(workspaceId: string) {
  return `forge:ws:${workspaceId}`;
}

export async function publish(evt: RealtimeEvent): Promise<void> {
  await redisPub.publish(channel(evt.workspaceId), JSON.stringify(evt));
}

export function subscribe(
  workspaceId: string,
  onMessage: (evt: RealtimeEvent) => void,
): () => Promise<void> {
  const ch = channel(workspaceId);
  const sub = redisSub.duplicate();
  void sub.subscribe(ch);
  sub.on("message", (_channel, raw) => {
    try {
      onMessage(JSON.parse(raw) as RealtimeEvent);
    } catch {
      // swallow malformed payloads — producer contract violated
    }
  });
  return async () => {
    await sub.unsubscribe(ch);
    await sub.quit();
  };
}
