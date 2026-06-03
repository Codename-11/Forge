"use client";
import { useWorkspace } from "@/hooks/use-workspace";
import { SettingsRail } from "@/components/settings/settings-rail";

/**
 * Workspace-settings shell. Sits inside the workspace shell (global sidebar +
 * topbar above) and adds the design's 244px settings rail to the left of the
 * detail pane — grouped nav with hints + admin pills + a "Search settings"
 * box (`/` to focus). Replaces the old horizontal navbar.
 */
export default function WorkspaceSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ws = useWorkspace();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
      <SettingsRail scope="workspace" slug={ws.slug} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
