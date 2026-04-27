"use client";
import { useWorkspace } from "@/hooks/use-workspace";
import { SettingsNavbar } from "@/components/settings/settings-navbar";

/**
 * Workspace-settings shell. Sits inside the workspace shell (sidebar +
 * topbar are still visible above) and adds a compact horizontal nav so
 * users can move between settings surfaces without adding another sidebar.
 */
export default function WorkspaceSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ws = useWorkspace();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <SettingsNavbar scope="workspace" slug={ws.slug} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
