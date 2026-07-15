"use client";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import {
  dispatchRealtimeEvent,
  setRealtimeConnectionHealth,
  type RealtimeEventShape,
} from "@/hooks/use-realtime";

/**
 * Subscribes to the workspace SSE stream and invalidates tRPC queries on
 * each event. Cheap, correct, and keeps the client in sync without per-
 * mutation wiring. Optimistic UI updates still happen at the mutation
 * layer; this catches out-of-band changes (other users, plugin writes).
 *
 * Also fans out every event to {@link useRealtime} subscribers so feature
 * components (cycles board, activity tab, relations panel, etc.) can
 * patch their local state without each spinning up their own EventSource.
 */
export function RealtimeProvider({ workspaceId }: { workspaceId: string }) {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!workspaceId) return;
    setRealtimeConnectionHealth({
      status: typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "connecting",
      lastConnectedAt: null,
      lastEventAt: null,
    });
    const cursorKey = `forge.realtime.cursor.${workspaceId}`;
    let savedCursor: string | null = null;
    try {
      savedCursor = window.sessionStorage.getItem(cursorKey);
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
    const search = new URLSearchParams({ workspaceId });
    if (savedCursor) search.set("cursor", savedCursor);
    const es = new EventSource(`/api/realtime?${search.toString()}`);
    es.onopen = () => {
      // HTTP is open, but remain connecting until the server finishes durable
      // replay and emits its ready control frame.
      setRealtimeConnectionHealth({ status: "connecting" });
    };
    es.onmessage = (msg) => {
      let evt: RealtimeEventShape;
      try {
        evt = JSON.parse(msg.data) as RealtimeEventShape;
      } catch {
        return;
      }
      if (msg.lastEventId) {
        try {
          window.sessionStorage.setItem(cursorKey, msg.lastEventId);
        } catch {
          // Cursor persistence is an enhancement; native EventSource retries
          // still carry Last-Event-ID for the lifetime of this instance.
        }
      }
      if (evt.type === "ready") {
        const now = new Date().toISOString();
        setRealtimeConnectionHealth({ status: "live", lastConnectedAt: now });
        return;
      }
      if (evt.type === "reconcile") {
        // The cursor was invalid or the bounded replay window overflowed.
        // Reconcile all mounted tRPC observers once; subsequent live events
        // return to the existing fine-grained invalidation path.
        void utils.invalidate();
        dispatchRealtimeEvent(evt);
        return;
      }
      setRealtimeConnectionHealth({
        status: "live",
        lastEventAt: evt.createdAt ?? new Date().toISOString(),
      });
      // Fan out to hook subscribers first — their handlers often want to
      // patch local state before the tRPC invalidation kicks in.
      dispatchRealtimeEvent(evt);

      if (!evt.subjectType && !evt.kind) return;

      // tRPC cache invalidations — coarse but cheap. Individual hook
      // subscribers can do finer-grained optimistic patching.
      if (evt.subjectType === "issue") {
        void utils.issue.list.invalidate();
        void utils.inbox.badge.invalidate();
        // Activity tab + relations panel both hang off an issueId.
        if (evt.subjectId) {
          void utils.issue.activity.invalidate({ issueId: evt.subjectId });
          void utils.issue.byId.invalidate({ id: evt.subjectId });
          void utils.comment.listForIssue.invalidate({ issueId: evt.subjectId });
        }
        // Cycle planning board reads cycle.get(cycleId).issues — trigger
        // a refresh whenever an issue changes in this workspace.
        void utils.cycle.get.invalidate();
      }
      if (evt.subjectType === "project") {
        void utils.project.list.invalidate();
      }
      if (evt.subjectType === "cycle") {
        void utils.cycle.list.invalidate();
        void utils.cycle.get.invalidate();
      }
      if (evt.subjectType === "initiative") {
        void utils.initiative.list.invalidate();
        void utils.initiative.get.invalidate();
      }
      // Agent presence + metadata changes. The agent router publishes with
      // `subjectType: "agent"` on create/update/archive/heartbeat paths;
      // a future AGENT_STATUS_CHANGED event fires here too. We also need
      // to refresh any issue surface that renders the assignee chip, so
      // the list query and any open issue page pick up the new status.
      if (evt.subjectType === "agent" || evt.kind?.startsWith("AGENT_")) {
        void utils.agent.list.invalidate();
        if (evt.subjectId) {
          void utils.agent.byId.invalidate({ id: evt.subjectId });
        }
        void utils.issue.list.invalidate();
        void utils.issue.byId.invalidate();
      }
      if (evt.kind?.startsWith("COMMENT_")) {
        void utils.issue.byId.invalidate();
        void utils.comment.listForIssue.invalidate();
        void utils.inbox.badge.invalidate();
      }
      // AgentRun lifecycle: every STARTED/STEP/STALLED/COMPLETED event
      // invalidates the active-run query for the run's issue so the
      // live pulse strip patches in real time without polling.
      if (evt.subjectType === "agent-run" || evt.kind?.startsWith("AGENT_RUN_")) {
        const payload = evt.payload as { issueId?: string } | null;
        if (payload?.issueId) {
          void utils.agentRun.activeForIssue.invalidate({ issueId: payload.issueId });
          // STATUS comment lives inside the issue's comments tree; refresh too.
          void utils.issue.byId.invalidate({ id: payload.issueId });
        }
      }
      // Relation router also emits ISSUE_UPDATED with subjectType=issue, so
      // the issue branch above already triggers a rail refresh (issue.byId
      // bundles relations) — no extra case needed.
    };
    es.onerror = () => {
      setRealtimeConnectionHealth({
        status: typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "reconnecting",
      });
    };
    const onOffline = () => setRealtimeConnectionHealth({ status: "offline" });
    const onOnline = () => {
      if (es.readyState !== EventSource.OPEN) {
        setRealtimeConnectionHealth({ status: "reconnecting" });
      }
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      es.close();
    };
  }, [workspaceId, utils]);

  return null;
}
