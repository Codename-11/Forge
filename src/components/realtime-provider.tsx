"use client";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { dispatchRealtimeEvent, type RealtimeEventShape } from "@/hooks/use-realtime";

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
    const es = new EventSource(`/api/realtime?workspaceId=${workspaceId}`);
    es.onmessage = (msg) => {
      let evt: RealtimeEventShape;
      try {
        evt = JSON.parse(msg.data) as RealtimeEventShape;
      } catch {
        return;
      }
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
        void utils.inbox.badge.invalidate();
      }
      // Relation router also emits ISSUE_UPDATED with subjectType=issue, so
      // the issue branch above already triggers a rail refresh (issue.byId
      // bundles relations) — no extra case needed.
    };
    return () => es.close();
  }, [workspaceId, utils]);

  return null;
}
