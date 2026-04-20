"use client";
import { useEffect, useRef } from "react";

/**
 * Realtime event wire format — mirrors `RealtimeEvent` on the server but
 * only includes fields the client actually reads.
 */
export interface RealtimeEventShape {
  id?: string;
  workspaceId?: string;
  kind?: string;
  subjectType?: string;
  subjectId?: string;
  payload?: unknown;
  actorId?: string | null;
  createdAt?: string;
  type?: string;
}

type EventHandler = (evt: RealtimeEventShape) => void;

const listeners = new Set<EventHandler>();

/**
 * Global registry the `RealtimeProvider` feeds SSE events into. Hooks
 * register themselves here rather than spinning up their own EventSource
 * per component — keeps the browser to a single socket per tab.
 */
export function dispatchRealtimeEvent(evt: RealtimeEventShape): void {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch {
      // keep the fan-out resilient to bad handlers
    }
  }
}

/**
 * Subscribe to server realtime events for the current workspace. Pass
 * an optional `filter` to narrow the callback to a subject/kind shape.
 *
 * The handler runs synchronously in the EventSource "message" callback
 * — keep it cheap (usually just a tRPC `utils.x.invalidate()` call).
 */
export function useRealtime(
  handler: EventHandler,
  filter?: {
    subjectType?: string | string[];
    subjectId?: string;
    kindPrefix?: string;
    kind?: string | string[];
  },
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const wrapped: EventHandler = (evt) => {
      if (filter?.subjectType) {
        const types = Array.isArray(filter.subjectType)
          ? filter.subjectType
          : [filter.subjectType];
        if (!evt.subjectType || !types.includes(evt.subjectType)) return;
      }
      if (filter?.subjectId && evt.subjectId !== filter.subjectId) return;
      if (filter?.kindPrefix && !evt.kind?.startsWith(filter.kindPrefix)) return;
      if (filter?.kind) {
        const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
        if (!evt.kind || !kinds.includes(evt.kind)) return;
      }
      handlerRef.current(evt);
    };
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, [
    filter?.subjectType,
    filter?.subjectId,
    filter?.kindPrefix,
    filter?.kind,
  ]);
}

// ---------------------------------------------------------------------------
// Cross-tab sync via BroadcastChannel.
//
// Some state is user-scoped, not workspace-scoped — pins (cross-workspace
// list on User), the running timer (per-user), and the inbox badge (sum
// across all memberships). SSE alone doesn't help here because another
// tab's mutation may hit a different workspace. BroadcastChannel lets a
// tab that just mutated shout at siblings, who then invalidate their
// caches.
// ---------------------------------------------------------------------------

const CHANNEL_NAME = "forge-cross-tab";

export type CrossTabMessage =
  | { type: "pins:updated" }
  | { type: "timer:started" }
  | { type: "timer:stopped" }
  | { type: "timer:updated" }
  | { type: "inbox:refresh" };

let broadcastChannel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (typeof BroadcastChannel === "undefined") return null;
  if (!broadcastChannel) broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
  return broadcastChannel;
}

/**
 * Tell every other tab that something user-scoped changed so they can
 * refresh the relevant tRPC query.
 */
export function broadcastCrossTab(msg: CrossTabMessage): void {
  try {
    getChannel()?.postMessage(msg);
  } catch {
    // BroadcastChannel can throw in private-mode / older browsers — no-op.
  }
}

/**
 * Subscribe to cross-tab messages. Handler should be stable (the effect
 * re-runs on identity change).
 */
export function useCrossTab(handler: (msg: CrossTabMessage) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const ch = getChannel();
    if (!ch) return;
    const onMessage = (ev: MessageEvent<CrossTabMessage>) => {
      try {
        handlerRef.current(ev.data);
      } catch {
        // swallow — same rationale as the SSE fan-out
      }
    };
    ch.addEventListener("message", onMessage);
    return () => {
      ch.removeEventListener("message", onMessage);
    };
  }, []);
}
