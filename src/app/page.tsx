import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";

/**
 * Root entry. Unauthenticated users go to sign-in. Authenticated users
 * resume their last-visited workspace — falling back to the earliest
 * membership if `User.lastWorkspaceId` is unset or stale.
 *
 * Having the landing redirect live here means the browser address bar
 * converges on `/w/<slug>/inbox` (the unified "what's next" landing,
 * née Dashboard) within one hop, keeping the URL scheme honest.
 */
export default async function RootPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { lastWorkspaceId: true },
  });

  if (user?.lastWorkspaceId) {
    const last = await db.workspace.findUnique({
      where: { id: user.lastWorkspaceId },
      select: { slug: true, deletedAt: true },
    });
    if (last && !last.deletedAt) redirect(`/w/${last.slug}/inbox`);
  }

  const membership = await db.membership.findFirst({
    where: { userId: session.user.id, workspace: { deletedAt: null } },
    include: { workspace: { select: { slug: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (membership) redirect(`/w/${membership.workspace.slug}/inbox`);

  // No active workspace — send to the account-level workspaces page so the
  // user can create one.
  redirect("/settings/workspaces");
}
