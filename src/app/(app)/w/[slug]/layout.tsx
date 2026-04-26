import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { CommandPalette } from "@/components/command-palette";
import { QuickCreate } from "@/components/quick-create";
import { KeyboardHelp } from "@/components/keyboard-help";
import { RealtimeProvider } from "@/components/realtime-provider";
import RealtimeToaster from "@/components/realtime-toaster";
import { TrpcProvider } from "@/lib/trpc-provider";
import { WorkspaceProvider } from "@/components/workspace-provider";
import { WorkspaceCookieSync } from "@/components/workspace-cookie-sync";
import { AppearanceProvider } from "@/components/appearance-provider";
import { TimeTrackerWidget } from "@/components/time-tracker/time-tracker-widget";
import { AttachmentLightboxProvider } from "@/components/attachments/attachment-lightbox";
import type { WorkspaceContextValue } from "@/hooks/use-workspace";

/**
 * Workspace-scoped shell. Every authenticated page that depends on a tenant
 * (dashboard, issues, projects, focus, standup, most of settings) lives
 * under `/w/[slug]/*` and renders inside this layout.
 *
 * The RSC resolves the workspace from the URL slug:
 *   - 404 if the slug doesn't exist.
 *   - 403-equivalent redirect to the user's default workspace if they
 *     aren't a member (avoids membership enumeration on unknown slugs).
 *   - Refreshes `lastWorkspaceId` in the background so `/` can resume
 *     the right workspace on next visit.
 */
export default async function WorkspaceShellLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const workspace = await db.workspace.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      key: true,
      avatarUrl: true,
      cycleLengthDays: true,
      cycleCooldownDays: true,
      timeTrackingEnabled: true,
      attachmentQuotaMb: true,
      deletedAt: true,
    },
  });
  if (!workspace || workspace.deletedAt) notFound();

  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: session.user.id, workspaceId: workspace.id } },
    select: { role: true },
  });
  if (!membership) {
    // Not a member — send them somewhere they can be. Prefer their saved
    // default; fall back to the workspace picker.
    const fallback = await db.membership.findFirst({
      where: { userId: session.user.id, workspace: { deletedAt: null } },
      select: { workspace: { select: { slug: true } } },
      orderBy: { createdAt: "asc" },
    });
    redirect(fallback ? `/w/${fallback.workspace.slug}/inbox` : "/settings/workspaces");
  }

  const membershipCount = await db.membership.count({
    where: { userId: session.user.id, workspace: { deletedAt: null } },
  });

  // Remember this workspace so root "/" resumes here next time. Best-effort:
  // skip the write if it already matches to avoid chatty UPDATEs on nav.
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { lastWorkspaceId: true },
  });
  if (user?.lastWorkspaceId !== workspace.id) {
    await db.user
      .update({
        where: { id: session.user.id },
        data: { lastWorkspaceId: workspace.id },
      })
      .catch(() => void 0);
  }

  const contextValue: WorkspaceContextValue = {
    id: workspace.id,
    slug: workspace.slug,
    key: workspace.key,
    name: workspace.name,
    avatarUrl: workspace.avatarUrl,
    role: membership.role,
    membershipCount,
    cycleLengthDays: workspace.cycleLengthDays,
    cycleCooldownDays: workspace.cycleCooldownDays,
    timeTrackingEnabled: workspace.timeTrackingEnabled,
    attachmentQuotaMb: workspace.attachmentQuotaMb,
  };

  return (
    <TrpcProvider workspaceSlug={workspace.slug} workspaceId={workspace.id}>
      <WorkspaceProvider value={contextValue}>
        <AppearanceProvider>
        <AttachmentLightboxProvider>
        {/* Below-sm banner: Forge is keyboard-driven and expects tablet+.
            Full phone layout is explicitly out of scope for this design
            sweep; users on narrower screens get a hint and a degraded
            (but still functional) icon-rail + center-pins experience. */}
        <div className="sticky top-0 z-40 flex items-center gap-2 border-b border-border bg-ember/10 px-3 py-1.5 text-[11px] text-foreground sm:hidden">
          <span className="font-medium">Forge is keyboard-driven.</span>
          <span className="text-muted-foreground">
            Use on tablet or larger for the full experience.
          </span>
        </div>
        <div className="flex h-svh overflow-hidden">
          <Sidebar
            slug={workspace.slug}
            user={{
              name: session.user.name,
              image: session.user.image,
              email: session.user.email,
            }}
          />
          <main className="flex min-w-0 flex-1 flex-col bg-background">
            <TopBar
              user={{
                name: session.user.name,
                image: session.user.image,
                email: session.user.email,
              }}
            />
            {children}
          </main>
        </div>
        <CommandPalette />
        <QuickCreate />
        <KeyboardHelp />
        <TimeTrackerWidget />
        <RealtimeProvider workspaceId={workspace.id} />
        <RealtimeToaster />
        <WorkspaceCookieSync slug={workspace.slug} />
        </AttachmentLightboxProvider>
        </AppearanceProvider>
      </WorkspaceProvider>
    </TrpcProvider>
  );
}
