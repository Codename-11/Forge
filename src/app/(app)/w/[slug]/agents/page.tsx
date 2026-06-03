"use client";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/hooks/use-workspace";
import AgentPresenceStrip from "@/components/agent-presence-strip";
import AgentPipeline from "@/components/agent-pipeline";
import AgentTimeline from "@/components/agent-timeline";
import { DispatchModeBadge } from "@/components/dispatch-mode-badge";
import { trpc } from "@/lib/trpc";

/**
 * Agents operational dashboard.
 *
 * Composes three independent live-data surfaces:
 *   1. Presence strip   — per-agent status + load + recent throughput.
 *   2. Pipeline         — pool lane + per-agent swimlanes (assigned /
 *                         in-flight / recently done).
 *   3. Timeline         — chronological feed of agent-touching events.
 *
 * Each piece subscribes to its own slice of `useRealtime`, so live
 * updates land without a page refresh. CRUD lives in `/settings/agents`
 * and is reachable from the topbar action.
 */
export default function AgentsPage() {
  const ws = useWorkspace();
  const { data: workspace } = trpc.workspace.current.useQuery();
  return (
    <>
      <Topbar
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span>Agents</span>
            {workspace && <DispatchModeBadge mode={workspace.autoDispatchMode} showSettingsLink />}
          </span>
        }
        subtitle="Live presence, pipeline, and recent activity."
        actions={
          <Link href={`/w/${ws.slug}/settings/agents`}>
            <Button variant="ghost" size="sm" className="min-h-9">
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              Manage agents
            </Button>
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
          <AgentPresenceStrip />
          <AgentPipeline />
          <AgentTimeline />
        </div>
      </div>
    </>
  );
}
