"use client";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/hooks/use-workspace";
import { AgentRunroomDashboard } from "@/components/agents/agent-runroom-dashboard";
import { DispatchModeBadge } from "@/components/dispatch-mode-badge";
import { trpc } from "@/lib/trpc";

/**
 * Agents operational dashboard. The runroom component composes the live
 * presence, pipeline, runtime, failed-run, dispatch, and activity queries into
 * one operator surface. Fleet CRUD lives in `/agents` and is reachable from
 * the topbar action.
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
        subtitle="Operational oversight for agent health, runtime coverage, dispatch pressure, and live work."
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
        <div className="p-4 sm:p-6">
          <AgentRunroomDashboard />
        </div>
      </div>
    </>
  );
}
