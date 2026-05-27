import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { SettingsRail } from "@/components/settings/settings-rail";

/**
 * Account / global settings shell.
 *
 * Applies to the *bare* `/settings/*` tree — the global, cross-workspace
 * settings (account, agents, runtimes, connections, workspaces). Workspace
 * settings live under `/w/[slug]/settings/*` and use the workspace shell.
 * These sit *above* any single workspace, so the back-link returns to
 * Mission Control (`/`), not into a workspace.
 */
export default async function AccountSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <SettingsRail
        scope="account"
        backHref="/"
        backLabel="Mission Control"
        email={session.user.email}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
