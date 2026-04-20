"use client";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";

/**
 * Subscribes to the workspace SSE stream and invalidates tRPC queries on
 * each event. Cheap, correct, and keeps the client in sync without per-
 * mutation wiring. Optimistic UI updates still happen at the mutation
 * layer; this catches out-of-band changes (other users, plugin writes).
 */
export function RealtimeProvider({ workspaceId }: { workspaceId: string }) {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!workspaceId) return;
    const es = new EventSource(`/api/realtime?workspaceId=${workspaceId}`);
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as { subjectType?: string; kind?: string };
        if (!evt.subjectType) return;
        if (evt.subjectType === "issue") void utils.issue.list.invalidate();
        if (evt.subjectType === "project") void utils.project.list.invalidate();
        if (evt.kind?.startsWith("COMMENT_")) void utils.issue.byId.invalidate();
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [workspaceId, utils]);

  return null;
}
