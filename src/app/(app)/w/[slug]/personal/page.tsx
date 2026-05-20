import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { refreshTodayZone } from "@/server/services/today-zone";

/**
 * `/w/[slug]/personal` — stable entry point to the caller's PERSONAL
 * canvas in this workspace. Server-component-only:
 *
 *   1. Resolves the workspace + membership.
 *   2. Looks up (or auto-provisions) the PERSONAL canvas for the
 *      caller. The unique key on (workspaceId, kind, ownerUserId)
 *      keeps this idempotent across concurrent fetches.
 *   3. Runs `refreshTodayZone` so the Today strip is current when the
 *      operator lands.
 *   4. Redirects to `/w/[slug]/canvas/[canvasId]`, where the existing
 *      viewer takes over.
 *
 * Bookmarkable, no client JS, and never modifies UI files agents are
 * working on — pure additive server route.
 */
export default async function PersonalCanvasRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const workspace = await db.workspace.findUnique({
    where: { slug },
    select: { id: true, deletedAt: true },
  });
  if (!workspace || workspace.deletedAt) notFound();

  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: session.user.id, workspaceId: workspace.id } },
    select: { role: true },
  });
  if (!membership) redirect(`/w/${slug}/inbox`);

  let canvas = await db.workspaceCanvas.findFirst({
    where: {
      workspaceId: workspace.id,
      kind: "PERSONAL",
      ownerUserId: session.user.id,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!canvas) {
    const me = await db.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { name: true, email: true },
    });
    const label = me.name?.trim() || me.email.split("@")[0] || "Personal";
    canvas = await db.workspaceCanvas.create({
      data: {
        workspaceId: workspace.id,
        kind: "PERSONAL",
        ownerUserId: session.user.id,
        createdById: session.user.id,
        name: `${label}'s workspace`,
      },
      select: { id: true },
    });
  }

  try {
    await refreshTodayZone(db, workspace.id, session.user.id, canvas.id);
  } catch {
    // Today zone is decorative — don't block the redirect on its failure.
  }

  redirect(`/w/${slug}/canvas/${canvas.id}`);
}
